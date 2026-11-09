/** Exercises real multipart streams, temporal ordering, resource bounds, and cleanup without parser mocks. */
import { ApolloServer } from '@apollo/server'
import { mkdtemp, readdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    type StreamingFile, GraphQLUpload, streamToBuffer, uploadProcess, uploadProcessStreaming,
} from '../src/index'

let directory: string
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upload-streaming-test-'))
    for (const key of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(key, directory)
})
afterEach(async () => { expect(await readdir(directory)).toEqual([]) })
afterAll(async () => { vi.unstubAllEnvs(); await rmdir(directory) })

const operation = { query: 'mutation($file: Upload!) { upload(file: $file) }', variables: { file: null } }

function form(operations: unknown = operation, map: unknown = { 0: ['variables.file'] }, content = 'hello') {
    const body = new FormData()
    body.set('operations', JSON.stringify(operations))
    body.set('map', JSON.stringify(map))
    body.set('0', new File([content], 'file.txt', { type: 'image/png' }))
    return body
}

async function request(body: BodyInit = form(), signal?: AbortSignal) {
    // Encode on the client side: a server receives wire bytes, not a live FormData encoder.
    const encoded = new Request('http://localhost/graphql', {
        method: 'POST', body, signal, headers: { 'Apollo-Require-Preflight': 'true' },
    })
    if (!(body instanceof FormData)) return encoded
    return new Request(encoded.url, {
        method: 'POST', body: await encoded.arrayBuffer(), signal, headers: encoded.headers,
    })
}

function server(handler?: (params: any) => Promise<unknown>) {
    return { executeOperation: vi.fn(async (params: any) => ({
        body: { kind: 'single', singleResult: { data: handler ? await handler(params) : { ok: true } } },
    })) }
}

function slowRequest(operations: unknown = operation, map: unknown = { arbitrary: ['variables.file'] }) {
    let controller: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel })
    const req = new Request('http://localhost/graphql', {
        method: 'POST', body, duplex: 'half',
        headers: { 'Content-Type': 'multipart/form-data; boundary=boundary', 'Apollo-Require-Preflight': 'true' },
    } as RequestInit)
    const append = (value: string) => controller.enqueue(Buffer.from(value))
    append(`--boundary\r\nContent-Disposition: form-data; name="operations"\r\n\r\n${JSON.stringify(operations)}\r\n`)
    append(`--boundary\r\nContent-Disposition: form-data; name="map"\r\n\r\n${JSON.stringify(map)}\r\n`)
    append('--boundary\r\nContent-Disposition: form-data; name="arbitrary"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\n')
    return { req, append, cancel, truncate() { controller.close() }, close() { append('\r\n--boundary--\r\n'); controller.close() } }
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Expected progress before upload completion.')), 2000)
        })])
    } finally { clearTimeout(timer!) }
}

it('real Apollo reads file bytes before the client sends the final bytes', async () => {
    const read = Promise.withResolvers<void>()
    let clientFinished = false
    const api = new ApolloServer({
        typeDefs: 'scalar Upload type Query { ok: Boolean } type Mutation { upload(file: Upload!): Int! }',
        resolvers: {
            Upload: GraphQLUpload,
            Mutation: { upload: async (_: unknown, { file }: { file: Promise<StreamingFile> }) => {
                const upload = await file
                expect(upload.mimetype).toBe('text/plain')
                let bytes = 0
                for await (const chunk of upload.createReadStream()) {
                    bytes += chunk.length
                    if (!clientFinished) read.resolve()
                }
                expect(await upload.fileSize).toBe(bytes)
                return bytes
            } },
        },
    })
    const source = slowRequest()
    source.append('a'.repeat(5000))
    const response = uploadProcessStreaming(source.req, {}, api)
    try {
        await deadline(read.promise)
        expect(clientFinished).toBe(false)
    } finally {
        clientFinished = true
        source.append('tail')
        source.close()
    }
    expect(await (await response).json()).toEqual({ data: { upload: 5004 } })
    await api.stop()
})

describe.each([['buffered', uploadProcess], ['streaming', uploadProcessStreaming]] as const)('%s contract', (_name, processUpload) => {
    it('preserves operationName, context, numeric JSON keys, and deduplicated aliases', async () => {
        const operations = { ...operation, operationName: 'Selected', variables: { input: { 0: null, caption: 'keep' }, alias: null } }
        const api = server(async params => {
            expect(params.operationName).toBe('Selected')
            expect(params.variables.input.caption).toBe('keep')
            expect(Array.isArray(params.variables.input)).toBe(false)
            expect(params.variables.input[0]).toBe(params.variables.alias)
            const file = await params.variables.alias.promise
            const streams = [file.createReadStream(), file.createReadStream()]
            expect(await Promise.all(streams.map(streamToBuffer))).toEqual([Buffer.from('hello'), Buffer.from('hello')])
            expect(await file.fileSize).toBe(5)
            return true
        })
        const body = form(operations, { arbitrary: ['variables.input.0', 'variables.alias'] })
        body.delete('0')
        body.set('arbitrary', new File(['hello'], 'file.txt'))
        const response = await processUpload(await request(body), {}, api)
        expect(response.status).toBe(200)
    })
})

it('spools files received in a different order from batched resolver execution', async () => {
    const body = form([operation, operation], { first: ['0.variables.file'], second: ['1.variables.file'] })
    body.delete('0')
    body.set('second', new File(['two'], 'two.txt'))
    body.set('first', new File(['one'], 'one.txt'))
    const api = server(async params => {
        const file = await params.variables.file.promise
        return (await streamToBuffer(file.createReadStream())).toString()
    })
    const response = await uploadProcessStreaming(await request(body), {}, api)
    expect(await response.json()).toEqual([{ data: 'one' }, { data: 'two' }])
})

it.each([0, 1, 10, 4100, 4101])('accepts exactly the configured file size %i', async bytes => {
    const api = server(async params => {
        const file = await params.variables.file.promise
        expect((await streamToBuffer(file.createReadStream())).length).toBe(bytes)
        return await file.fileSize
    })
    const response = await uploadProcessStreaming(await request(form(operation, { 0: ['variables.file'] }, 'a'.repeat(bytes))), {}, api, { maxFileSize: bytes })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: bytes })
})

it.each([0, 1, 4100])('rejects one byte beyond file size %i and cancels reception', async limit => {
    const source = slowRequest()
    source.append('a'.repeat(limit + 1))
    const response = await deadline(uploadProcessStreaming(source.req, {}, server(), { maxFileSize: limit }))
    expect(response.status).toBe(413)
    expect(source.cancel).toHaveBeenCalled()
})

it('enforces the total body limit without relying on Content-Length or EOF', async () => {
    const source = slowRequest()
    source.append('x'.repeat(1000))
    const response = await deadline(uploadProcessStreaming(source.req, {}, server(), { maxRequestSize: 100 }))
    expect(response.status).toBe(413)
    expect(source.cancel).toHaveBeenCalled()
})

it('cancels disk writes, fileSize, and active readers when a resolver aborts', async () => {
    const source = slowRequest()
    source.append('x'.repeat(5000))
    let file: StreamingFile
    let reading: Promise<Buffer>
    const response = await deadline(uploadProcessStreaming(source.req, {}, server(async params => {
        file = await params.variables.file.promise
        reading = streamToBuffer(file.createReadStream())
        void reading.catch(() => {})
        file.abort()
        return true
    })))
    expect(response.status).toBe(400)
    await expect(file!.fileSize).rejects.toThrow('cancelled')
    await expect(reading!).rejects.toThrow('cancelled')
    expect(source.cancel).toHaveBeenCalled()
})

it('handles a disconnected client during an active resolver', async () => {
    const controller = new AbortController()
    const source = slowRequest()
    const started = Promise.withResolvers<void>()
    source.append('x'.repeat(5000))
    const req = { body: source.req.body, headers: source.req.headers, signal: controller.signal }
    const response = uploadProcessStreaming(req, {}, server(async params => {
        const file = await params.variables.file.promise
        started.resolve()
        await streamToBuffer(file.createReadStream())
    }))
    await deadline(started.promise)
    controller.abort()
    expect((await deadline(response)).status).toBe(499)
    expect(source.cancel).toHaveBeenCalled()
})

it('rejects simple forms before consuming their bodies', async () => {
    const req = await request()
    req.headers.delete('Apollo-Require-Preflight')
    expect((await uploadProcessStreaming(req, {}, server())).status).toBe(400)
    expect(req.bodyUsed).toBe(false)
})

it('rejects missing files through the scalar promise without hanging', async () => {
    const body = form()
    body.delete('0')
    const api = server(async params => {
        await expect(params.variables.file.promise).rejects.toThrow('File missing')
        return true
    })
    expect((await deadline(uploadProcessStreaming(await request(body), {}, api))).status).toBe(200)
})

it('rejects late readers after execution and removes temporary files', async () => {
    let file: StreamingFile
    const response = await uploadProcessStreaming(await request(), {}, server(async params => {
        file = await params.variables.file.promise
        return await file.fileSize
    }))
    expect(response.status).toBe(200)
    expect(() => file!.createReadStream()).toThrow('after execution')
})

it('cleans up reception after an unexpected server exception without leaking it', async () => {
    const source = slowRequest()
    source.append('x'.repeat(5000))
    const api = { executeOperation: async (params: any) => {
        await params.variables.file.promise
        throw new Error('database-password=secret')
    } }
    const response = await deadline(uploadProcessStreaming(source.req, {}, api))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('database-password')
    expect(source.cancel).toHaveBeenCalled()
})

it('rejects a claimed image when detected contents violate allowedTypes', async () => {
    const response = await uploadProcessStreaming(await request(), {}, server(async params => {
        await params.variables.file.promise
    }), { allowedTypes: ['image/png'] })
    expect(response.status).toBe(400)
})

it.each([
    { maxFileSize: -1 }, { maxFileSize: 0.5 }, { maxFiles: Infinity },
    { maxFieldSize: NaN }, { maxRequestSize: -1 }, { maxRequestSize: Number.MAX_VALUE },
])('rejects invalid configuration %j before reading bytes', async settings => {
    const req = await request()
    expect((await uploadProcessStreaming(req, {}, server(), settings)).status).toBe(400)
    expect(req.bodyUsed).toBe(false)
})

it('accepts explicit undefined options as their defaults', async () => {
    expect((await uploadProcessStreaming(await request(), {}, server(), { maxFileSize: undefined })).status).toBe(200)
})

it('enforces MIME validation even when resolvers ignore their uploads', async () => {
    expect((await uploadProcessStreaming(await request(), {}, server(), { allowedTypes: ['image/png'] })).status).toBe(400)
})

it('handles unavailable temporary storage as a server error without exposing paths', async () => {
    for (const key of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(key, path.join(directory, 'missing'))
    try {
        const response = await deadline(uploadProcessStreaming(await request(), {}, server(async params => {
            const file = await params.variables.file.promise
            return await file.fileSize
        })))
        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain(directory)
    } finally {
        for (const key of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(key, directory)
    }
})

it.each([
    ['misordered', [['map', '{}'], ['operations', JSON.stringify(operation)]]],
    ['duplicate operations', [['operations', JSON.stringify(operation)], ['operations', JSON.stringify(operation)], ['map', '{}']]],
    ['invalid JSON', [['operations', '{'], ['map', '{}']]],
    ['empty batch', [['operations', '[]'], ['map', '{}']]],
    ['invalid map', [['operations', JSON.stringify(operation)], ['map', '[]']]],
    ['unsafe path', [['operations', JSON.stringify(operation)], ['map', '{"0":["variables.__proto__.x"]}']]],
    ['nonexistent path', [['operations', JSON.stringify(operation)], ['map', '{"0":["variables.missing"]}']]],
] as const)('rejects %s control fields', async (_label, fields) => {
    const body = new FormData()
    for (const [key, value] of fields) body.append(key, value)
    const api = server()
    expect((await uploadProcessStreaming(await request(body), {}, api)).status).toBe(400)
    expect(api.executeOperation).not.toHaveBeenCalled()
})

it('rejects extra fields even when execution may already have started after the map', async () => {
    const body = form({ query: '{ ok }' }, {})
    body.set('extra', 'x')
    expect((await uploadProcessStreaming(await request(body), {}, server())).status).toBe(400)
})

it('rejects file parts appearing before the map', async () => {
    const body = new FormData()
    body.set('0', new File(['data'], 'data.txt'))
    body.set('operations', JSON.stringify(operation))
    body.set('map', '{}')
    expect((await uploadProcessStreaming(await request(body), {}, server())).status).toBe(400)
})

it('rejects duplicate physical file names after execution has started', async () => {
    const body = form()
    body.append('0', new File(['other'], 'other.txt'))
    expect((await uploadProcessStreaming(await request(body), {}, server())).status).toBe(400)
})

it.each([0, 1])('counts unmapped files against maxFiles=%i', async maxFiles => {
    const body = form({ query: '{ ok }' }, {})
    body.set('unmapped', new File(['other'], 'other.txt'))
    expect((await uploadProcessStreaming(await request(body), {}, server(), { maxFiles })).status).toBe(413)
})

it('enforces file size limits on unmapped files too', async () => {
    expect((await uploadProcessStreaming(await request(form({ query: '{ ok }' }, {}, 'ab')), {}, server(), { maxFileSize: 1 })).status).toBe(413)
})

it('accepts the exact control-field limit and rejects one byte less', async () => {
    const size = Buffer.byteLength(JSON.stringify(operation))
    expect((await uploadProcessStreaming(await request(), {}, server(), { maxFieldSize: size })).status).toBe(200)
    expect((await uploadProcessStreaming(await request(), {}, server(), { maxFieldSize: size - 1 })).status).toBe(413)
})

it.each(['multipart/form-data', 'text/plain'])('rejects invalid Content-Type %s without reading', async contentType => {
    const req = await request()
    req.headers.set('Content-Type', contentType)
    expect((await uploadProcessStreaming(req, {}, server())).status).toBe(400)
    expect(req.bodyUsed).toBe(false)
})

it('rejects truncated multipart syntax', async () => {
    const req = await request('garbage')
    req.headers.set('Content-Type', 'multipart/form-data; boundary=boundary')
    expect((await uploadProcessStreaming(req, {}, server())).status).toBe(400)
})

it('rejects EOF during an active file and settles resolver readers', async () => {
    const source = slowRequest()
    const started = Promise.withResolvers<void>()
    source.append('x'.repeat(5000))
    const response = uploadProcessStreaming(source.req, {}, server(async params => {
        const file = await params.variables.file.promise
        started.resolve()
        await streamToBuffer(file.createReadStream())
    }))
    await deadline(started.promise)
    source.truncate()
    expect((await deadline(response)).status).toBe(400)
})

it.each([1, 2, 7, 4096])('preserves multipart data under %i-byte transport fragmentation', async chunkSize => {
    const encoded = await request(form(operation, { 0: ['variables.file'] }, 'multibyte: é 日本語'))
    const bytes = new Uint8Array(await encoded.arrayBuffer())
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize))
        controller.close()
    } })
    const response = await uploadProcessStreaming({ body, headers: encoded.headers }, {}, server(async params => {
        const file = await params.variables.file.promise
        return (await streamToBuffer(file.createReadStream())).toString()
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: 'multibyte: é 日本語' })
})

it('handles an already-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect((await uploadProcessStreaming(await request(form(), controller.signal), {}, server())).status).toBe(499)
})

it('isolates independent requests and cleans up all their files', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, async (_, index) => uploadProcessStreaming(
        await request(form(operation, { 0: ['variables.file'] }, String(index))), {}, server(async params => {
            const file = await params.variables.file.promise
            return (await streamToBuffer(file.createReadStream())).toString()
        }),
    )))
    expect(await Promise.all(responses.map(response => response.json()))).toEqual(Array.from({ length: 8 }, (_, index) => ({ data: String(index) })))
})
