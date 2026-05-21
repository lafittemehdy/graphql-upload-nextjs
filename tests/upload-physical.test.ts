import type { File as UploadFile, MinimalRequest } from '../src/index'
import { Upload, streamToBuffer, uploadProcess } from '../src/index'

/**
 * Physical upload tests — exercises the full pipeline with real File objects,
 * verifying MIME detection, file properties, and stream data integrity.
 */

/** PNG magic bytes (minimal valid PNG header). */
const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed data
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // ...
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82,                     // IEND CRC
])

/** Creates a mock request from FormData. */
function createMockRequest(formData: FormData): MinimalRequest {
    return {
        formData: async () => formData,
        headers: { get: () => null },
    }
}

describe('physical upload tests', () => {
    it('uploads a text file and verifies stream content matches', async () => {
        const fileContent = 'Hello, this is a test file with some content.\nLine 2.'
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($file: Upload!) { uploadFile(file: $file) { filename } }',
            variables: { file: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.file'] }))
        fd.append('0', new File([fileContent], 'readme.txt', { type: 'text/plain' }))

        const request = createMockRequest(fd)

        let resolvedFile: UploadFile | undefined
        const server = {
            executeOperation: async (params: any) => {
                const upload = params.variables.file as Upload
                resolvedFile = await upload.promise
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        expect(resolvedFile).toBeDefined()
        expect(resolvedFile!.filename).toBe('readme.txt')
        expect(resolvedFile!.encoding).toBe('binary')
        expect(resolvedFile!.fileSize).toBe(Buffer.byteLength(fileContent))

        // Verify stream data integrity.
        const stream = resolvedFile!.createReadStream()
        const buffer = await streamToBuffer(stream)
        expect(buffer.toString('utf-8')).toBe(fileContent)
    })

    it('uploads a binary file (PNG) and verifies file properties', async () => {
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($file: Upload!) { uploadFile(file: $file) { filename mimetype } }',
            variables: { file: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.file'] }))
        fd.append('0', new File([PNG_HEADER], 'image.png', { type: 'image/png' }))

        const request = createMockRequest(fd)

        let resolvedFile: UploadFile | undefined
        const server = {
            executeOperation: async (params: any) => {
                const upload = params.variables.file as Upload
                resolvedFile = await upload.promise
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        expect(resolvedFile).toBeDefined()
        expect(resolvedFile!.filename).toBe('image.png')
        expect(resolvedFile!.fileSize).toBe(PNG_HEADER.length)

        // Verify binary stream data integrity.
        const stream = resolvedFile!.createReadStream()
        const buffer = await streamToBuffer(stream)
        expect(buffer.equals(PNG_HEADER)).toBe(true)
    })

    it('uploads multiple files simultaneously and verifies each', async () => {
        const textContent = 'text file data'
        const binaryContent = Buffer.from([0x00, 0xff, 0xab, 0xcd])

        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($files: [Upload!]!) { uploadFiles(files: $files) { filename } }',
            variables: { files: [null, null] },
        }))
        fd.append('map', JSON.stringify({
            '0': ['variables.files.0'],
            '1': ['variables.files.1'],
        }))
        fd.append('0', new File([textContent], 'doc.txt', { type: 'text/plain' }))
        fd.append('1', new File([binaryContent], 'data.bin', { type: 'application/octet-stream' }))

        const request = createMockRequest(fd)

        const resolvedFiles: UploadFile[] = []
        const server = {
            executeOperation: async (params: any) => {
                const uploads = params.variables.files as Upload[]
                for (const upload of uploads) {
                    resolvedFiles.push(await upload.promise)
                }
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        expect(resolvedFiles).toHaveLength(2)

        // Verify first file (text).
        expect(resolvedFiles[0].filename).toBe('doc.txt')
        const textBuffer = await streamToBuffer(resolvedFiles[0].createReadStream())
        expect(textBuffer.toString('utf-8')).toBe(textContent)

        // Verify second file (binary).
        expect(resolvedFiles[1].filename).toBe('data.bin')
        const binBuffer = await streamToBuffer(resolvedFiles[1].createReadStream())
        expect(binBuffer.equals(binaryContent)).toBe(true)
    })

    it('uploads files in a batch operation and verifies each operation receives its file', async () => {
        const fd = new FormData()
        fd.append('operations', JSON.stringify([
            { query: 'mutation($f:Upload!){a(f:$f){ok}}', variables: { f: null } },
            { query: 'mutation($f:Upload!){b(f:$f){ok}}', variables: { f: null } },
        ]))
        fd.append('map', JSON.stringify({
            '0': ['0.variables.f'],
            '1': ['1.variables.f'],
        }))
        fd.append('0', new File(['alpha content'], 'alpha.txt', { type: 'text/plain' }))
        fd.append('1', new File(['bravo content'], 'bravo.txt', { type: 'text/plain' }))

        const request = createMockRequest(fd)

        const resolvedFiles: UploadFile[] = []
        const server = {
            executeOperation: async (params: any) => {
                const upload = params.variables.f as Upload
                resolvedFiles.push(await upload.promise)
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        expect(resolvedFiles).toHaveLength(2)
        expect(resolvedFiles[0].filename).toBe('alpha.txt')
        expect(resolvedFiles[1].filename).toBe('bravo.txt')

        const alphaData = await streamToBuffer(resolvedFiles[0].createReadStream())
        expect(alphaData.toString('utf-8')).toBe('alpha content')

        const bravoData = await streamToBuffer(resolvedFiles[1].createReadStream())
        expect(bravoData.toString('utf-8')).toBe('bravo content')
    })

    it('rejects a file that violates allowedTypes', async () => {
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($f:Upload!){up(f:$f){ok}}',
            variables: { f: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.f'] }))
        fd.append('0', new File(['data'], 'script.js', { type: 'application/javascript' }))

        const request = createMockRequest(fd)

        let capturedUpload: Upload | undefined
        const server = {
            executeOperation: async (params: any) => {
                capturedUpload = params.variables.f
                return { body: { kind: 'single' as const, singleResult: { data: null } } }
            },
        }

        await uploadProcess(request, {}, server, {
            allowedTypes: ['text/plain', 'image/png'],
        })

        expect(capturedUpload).toBeInstanceOf(Upload)
        await expect(capturedUpload!.promise).rejects.toThrow('is not allowed')
    })

    it('does not trust client-provided MIME type when enforcing allowedTypes', async () => {
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($f:Upload!){up(f:$f){ok}}',
            variables: { f: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.f'] }))
        fd.append('0', new File([Buffer.from([0x00, 0xff, 0xab, 0xcd])], 'not-a-png.bin', { type: 'image/png' }))

        const request = createMockRequest(fd)

        let capturedUpload: Upload | undefined
        const server = {
            executeOperation: async (params: any) => {
                capturedUpload = params.variables.f
                return { body: { kind: 'single' as const, singleResult: { data: null } } }
            },
        }

        await uploadProcess(request, {}, server, {
            allowedTypes: ['image/png'],
        })

        expect(capturedUpload).toBeInstanceOf(Upload)
        await expect(capturedUpload!.promise).rejects.toThrow('application/octet-stream is not allowed')
    })

    it('falls back to application/octet-stream when no MIME type can be detected', async () => {
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($f:Upload!){up(f:$f){ok}}',
            variables: { f: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.f'] }))
        fd.append('0', new File([Buffer.from([0x00, 0xff, 0xab, 0xcd])], 'unknown.bin'))

        const request = createMockRequest(fd)

        let resolvedFile: UploadFile | undefined
        const server = {
            executeOperation: async (params: any) => {
                resolvedFile = await (params.variables.f as Upload).promise
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        expect(resolvedFile).toBeDefined()
        expect(resolvedFile!.mimetype).toBe('application/octet-stream')
    })

    it('createReadStream can be called multiple times (Blob is replayable)', async () => {
        const content = 'replayable content'
        const fd = new FormData()
        fd.append('operations', JSON.stringify({
            query: 'mutation($f:Upload!){up(f:$f){ok}}',
            variables: { f: null },
        }))
        fd.append('map', JSON.stringify({ '0': ['variables.f'] }))
        fd.append('0', new File([content], 'replay.txt', { type: 'text/plain' }))

        const request = createMockRequest(fd)

        let resolvedFile: UploadFile | undefined
        const server = {
            executeOperation: async (params: any) => {
                resolvedFile = await (params.variables.f as Upload).promise
                return { body: { kind: 'single' as const, singleResult: { data: { ok: true } } } }
            },
        }

        await uploadProcess(request, {}, server)

        // Read the stream twice — both should return the same data.
        const first = await streamToBuffer(resolvedFile!.createReadStream())
        const second = await streamToBuffer(resolvedFile!.createReadStream())
        expect(first.toString('utf-8')).toBe(content)
        expect(second.toString('utf-8')).toBe(content)
    })
})
