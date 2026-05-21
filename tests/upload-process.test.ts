import type { MinimalRequest } from '../src/index'
import { Upload, uploadProcess } from '../src/index'

/** Creates a mock request wrapping a FormData instance. */
function createMockRequest(formData: FormData): MinimalRequest {
    return {
        formData: async () => formData,
        headers: { get: () => null },
    }
}

/** Creates a mock server that captures executeOperation calls. */
function createMockServer(handler?: (params: any, ctx: any) => Promise<any>) {
    const calls: { params: any; context: any }[] = []
    return {
        calls,
        server: {
            executeOperation: handler || (async (params: any, context: any) => {
                calls.push({ params, context })
                return {
                    body: {
                        kind: 'single' as const,
                        singleResult: { data: { success: true } },
                    },
                }
            }),
        },
    }
}

/** Builds a FormData with operations, map, and optional file entries. */
function buildFormData(
    operations: unknown,
    map: unknown,
    files?: Record<string, { content: string; name: string; type: string }>,
): FormData {
    const fd = new FormData()
    fd.append('operations', JSON.stringify(operations))
    fd.append('map', JSON.stringify(map))
    if (files) {
        for (const [key, file] of Object.entries(files)) {
            fd.append(key, new File([file.content], file.name, { type: file.type }))
        }
    }
    return fd
}

describe('uploadProcess', () => {
    describe('validation errors (400)', () => {
        it('returns 400 when operations field is missing', async () => {
            const fd = new FormData()
            fd.append('map', '{}')
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 when map field is missing', async () => {
            const fd = new FormData()
            fd.append('operations', '{"query":"{ hello }"}')
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 for invalid JSON in operations', async () => {
            const fd = new FormData()
            fd.append('operations', '{invalid')
            fd.append('map', '{}')
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 for invalid JSON in map', async () => {
            const fd = new FormData()
            fd.append('operations', '{"query":"{ hello }"}')
            fd.append('map', '{invalid')
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 when map entry is not an array', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: { file: null } },
                { '0': 'variables.file' },
                { '0': { content: 'data', name: 'a.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 when map path is not a string', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: { file: null } },
                { '0': [42] },
                { '0': { content: 'data', name: 'a.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 when map is an array', async () => {
            const fd = new FormData()
            fd.append('operations', '{"query":"{ hello }"}')
            fd.append('map', '[["variables.file"]]')
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it.each([
            '',
            'variables..file',
            'variables.__proto__.x',
            'constructor.prototype.x',
        ])('returns 400 for invalid map path "%s"', async (path) => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': [path] },
                { '0': { content: 'data', name: 'a.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it.each([
            { caseName: 'null operation', operations: [null] },
            { caseName: 'missing query', operations: [{}] },
            { caseName: 'non-string query', operations: [{ query: 42 }] },
            { caseName: 'null variables', operations: [{ query: '{ hello }', variables: null }] },
            { caseName: 'array variables', operations: [{ query: '{ hello }', variables: [] }] },
        ])('returns 400 for malformed batch operation: $caseName', async ({ operations }) => {
            const fd = buildFormData(operations, {})
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })

        it('returns 400 for a malformed single operation', async () => {
            const fd = buildFormData(
                { query: 42 },
                {},
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(400)
        })
    })

    describe('size and count limits (413)', () => {
        it('returns 413 when file exceeds maxFileSize', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': ['variables.f'] },
                { '0': { content: 'x'.repeat(1000), name: 'big.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFileSize: 100 })
            expect(response.status).toBe(413)
        })

        it('returns 413 when file count exceeds maxFiles', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:[Upload!]!){up(f:$f){ok}}', variables: { f: [null, null] } },
                { '0': ['variables.f.0'], '1': ['variables.f.1'] },
                {
                    '0': { content: 'a', name: 'a.txt', type: 'text/plain' },
                    '1': { content: 'b', name: 'b.txt', type: 'text/plain' },
                },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFiles: 1 })
            expect(response.status).toBe(413)
        })

        it('returns 413 when maxFiles is 0 and a file is mapped', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': ['variables.f'] },
                { '0': { content: 'data', name: 'a.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFiles: 0 })
            expect(response.status).toBe(413)
        })

        it('allows an empty file when maxFileSize is 0', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': ['variables.f'] },
                { '0': { content: '', name: 'empty.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFileSize: 0 })
            expect(response.status).toBe(200)
            expect(calls).toHaveLength(1)
        })

        it('returns 413 for a non-empty file when maxFileSize is 0', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': ['variables.f'] },
                { '0': { content: 'x', name: 'non-empty.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFileSize: 0 })
            expect(response.status).toBe(413)
        })
    })

    describe('settings validation (400)', () => {
        it('returns 400 when maxFiles is negative', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: {} },
                {},
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFiles: -1 })
            expect(response.status).toBe(400)
        })

        it('returns 400 when maxFileSize is not finite', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: {} },
                {},
            )
            const request = createMockRequest(fd)
            const { server } = createMockServer()

            const response = await uploadProcess(request, {}, server, { maxFileSize: Number.POSITIVE_INFINITY })
            expect(response.status).toBe(400)
        })
    })

    describe('single file upload', () => {
        it('processes a single file and passes it to executeOperation', async () => {
            const fd = buildFormData(
                { query: 'mutation($file:Upload!){up(file:$file){ok}}', variables: { file: null } },
                { '0': ['variables.file'] },
                { '0': { content: 'hello world', name: 'test.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, { ip: '127.0.0.1' }, server)
            expect(response.status).toBe(200)
            expect(calls).toHaveLength(1)

            // The variable should be an Upload instance (its promise is what the scalar resolves).
            const fileVar = calls[0].params.variables.file
            expect(fileVar).toBeInstanceOf(Upload)
        })
    })

    describe('multiple file upload', () => {
        it('processes multiple files mapped to array indices', async () => {
            const fd = buildFormData(
                { query: 'mutation($files:[Upload!]!){up(files:$files){ok}}', variables: { files: [null, null] } },
                { '0': ['variables.files.0'], '1': ['variables.files.1'] },
                {
                    '0': { content: 'file-a', name: 'a.txt', type: 'text/plain' },
                    '1': { content: 'file-b', name: 'b.txt', type: 'text/plain' },
                },
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(200)
            expect(calls).toHaveLength(1)

            const filesVar = calls[0].params.variables.files
            expect(Array.isArray(filesVar)).toBe(true)
            expect(filesVar).toHaveLength(2)
            expect(filesVar[0]).toBeInstanceOf(Upload)
            expect(filesVar[1]).toBeInstanceOf(Upload)
        })
    })

    describe('batch operations', () => {
        it('executes each operation in a batch and returns array of results', async () => {
            const fd = buildFormData(
                [
                    { query: 'mutation($f:Upload!){a(f:$f){ok}}', variables: { f: null } },
                    { query: 'mutation($f:Upload!){b(f:$f){ok}}', variables: { f: null } },
                ],
                { '0': ['0.variables.f'], '1': ['1.variables.f'] },
                {
                    '0': { content: 'alpha', name: 'a.txt', type: 'text/plain' },
                    '1': { content: 'bravo', name: 'b.txt', type: 'text/plain' },
                },
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(200)
            expect(calls).toHaveLength(2)
            expect(response.body).toBeInstanceOf(Array)
        })
    })

    describe('file deduplication', () => {
        it('maps one file to multiple operation paths', async () => {
            const fd = buildFormData(
                { query: 'mutation($a:Upload!,$b:Upload!){up(a:$a,b:$b){ok}}', variables: { a: null, b: null } },
                { '0': ['variables.a', 'variables.b'] },
                { '0': { content: 'shared', name: 'shared.txt', type: 'text/plain' } },
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(200)

            const vars = calls[0].params.variables
            expect(vars.a).toBeInstanceOf(Upload)
            expect(vars.b).toBeInstanceOf(Upload)
            // Both should be the same Upload instance (deduplication).
            expect(vars.a).toBe(vars.b)
        })
    })

    describe('missing file handling', () => {
        it('rejects the Upload promise when a mapped file is missing', async () => {
            const fd = buildFormData(
                { query: 'mutation($f:Upload!){up(f:$f){ok}}', variables: { f: null } },
                { '0': ['variables.f'] },
                // No file "0" attached.
            )
            const request = createMockRequest(fd)

            let capturedUpload: Upload | undefined
            const { server } = createMockServer(async (params) => {
                capturedUpload = params.variables.f
                return { body: { kind: 'single' as const, singleResult: { data: null } } }
            })

            await uploadProcess(request, {}, server)

            expect(capturedUpload).toBeInstanceOf(Upload)
            await expect(capturedUpload!.promise).rejects.toThrow('File missing in the request.')
        })
    })

    describe('context forwarding', () => {
        it('passes contextValueInput to executeOperation', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: {} },
                {},
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            await uploadProcess(request, { ip: '10.0.0.1', userId: 'abc' }, server)

            expect(calls[0].context.contextValue).toEqual({ ip: '10.0.0.1', userId: 'abc' })
        })
    })

    describe('no files (query only)', () => {
        it('processes a request with empty map', async () => {
            const fd = buildFormData(
                { query: '{ hello }', variables: {} },
                {},
            )
            const request = createMockRequest(fd)
            const { calls, server } = createMockServer()

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(200)
            expect(calls).toHaveLength(1)
            expect(calls[0].params.query).toBe('{ hello }')
        })
    })

    describe('incremental response handling', () => {
        it('collects incremental results into a single response', async () => {
            const fd = buildFormData(
                { query: '{ stream }', variables: {} },
                {},
            )
            const request = createMockRequest(fd)

            async function* generateResults() {
                yield { data: { chunk: 1 }, hasNext: true }
                yield { data: { chunk: 2 }, hasNext: false }
            }

            const { server } = createMockServer(async () => ({
                body: {
                    kind: 'incremental' as const,
                    initialResult: { data: { stream: null }, hasNext: true },
                    subsequentResults: generateResults(),
                },
            }))

            const response = await uploadProcess(request, {}, server)
            expect(response.status).toBe(200)
            expect(response.body).toHaveProperty('initialResult')
            expect(response.body).toHaveProperty('subsequentResults')
            expect((response.body as any).subsequentResults).toHaveLength(2)
        })
    })
})
