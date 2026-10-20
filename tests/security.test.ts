import { describe, expect, it, vi } from 'vitest'
import { uploadProcess } from '../src/index'

function request(operations: unknown, map: unknown, header = true) {
    const body = new FormData()
    body.set('operations', JSON.stringify(operations))
    body.set('map', JSON.stringify(map))
    return { body, formData: vi.fn(async () => body), headers: new Headers(header ? { 'Apollo-Require-Preflight': 'true' } : {}) }
}

const makeServer = () => ({ executeOperation: vi.fn(async () => ({ body: { kind: 'single', singleResult: { data: { ok: true } } } })) })

describe('multipart request boundaries', () => {
    it('does not classify binary data as text from its filename', async () => {
        const req = request({ query: 'mutation($file: Upload!) { upload(file: $file) }', variables: { file: null } }, { 0: ['variables.file'] })
        req.body.set('0', new File([new Uint8Array([0, 255, 0, 255])], 'fake.txt', { type: 'text/plain' }))
        let rejection: unknown
        const server = { executeOperation: async (params: any) => {
            try { await params.variables.file.promise } catch (error) { rejection = error }
            return { body: { kind: 'single', singleResult: {} } }
        } }
        await uploadProcess(req, {}, server, { allowedTypes: ['text/plain'] })
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toContain('not allowed')
    })
    it('rejects simple cross-origin forms before reading their body', async () => {
        const req = request({ query: '{ hello }' }, {}, false)
        const server = makeServer()
        expect((await uploadProcess(req, {}, server)).status).toBe(400)
        expect(req.formData).not.toHaveBeenCalled()
        expect(server.executeOperation).not.toHaveBeenCalled()
    })

    it.each(['query', 'operationName', 'variables', 'variables.missing', 'variables.files.4294967294', 'variables.value'])('rejects unsafe path %s before execution', async path => {
        const req = request({ query: '{ hello }', variables: { file: null, files: [null], value: 'existing' } }, { 0: [path] })
        const server = makeServer()
        expect((await uploadProcess(req, {}, server)).status).toBe(400)
        expect(server.executeOperation).not.toHaveBeenCalled()
    })

    it.each(['1.variables.file', '01.variables.file', '-1.variables.file', '0.query'])('rejects invalid batch path %s', async path => {
        const server = makeServer()
        expect((await uploadProcess(request([{ query: '{ hello }', variables: { file: null } }], { 0: [path] }), {}, server)).status).toBe(400)
        expect(server.executeOperation).not.toHaveBeenCalled()
    })

    it.each([false, true])('forwards operationName for batch=%s', async batch => {
        const op = { query: 'query A { a } query B { b }', operationName: 'B', variables: {} }
        const server = makeServer()
        expect((await uploadProcess(request(batch ? [op] : op, {}), {}, server)).status).toBe(200)
        expect(server.executeOperation).toHaveBeenCalledWith(op, { contextValue: {} })
    })

    it('counts unmapped files against maxFiles', async () => {
        const req = request({ query: '{ hello }' }, {})
        req.body.set('unused', new File(['data'], 'a.txt'))
        expect((await uploadProcess(req, {}, makeServer(), { maxFiles: 0 })).status).toBe(413)
    })

    it('counts duplicate multipart file fields against maxFiles', async () => {
        const req = request({ query: '{ hello }' }, {})
        req.body.append('same', new File(['one'], 'a.txt'))
        req.body.append('same', new File(['two'], 'b.txt'))
        expect((await uploadProcess(req, {}, makeServer(), { maxFiles: 1 })).status).toBe(413)
    })

    it.each([{ maxFiles: 0.5 }, { allowedTypes: 'text/plain' }, { allowedTypes: [1] }])('rejects invalid settings %j', async settings => {
        expect((await uploadProcess(request({ query: '{ hello }' }, {}), {}, makeServer(), settings as never)).status).toBe(400)
    })

    it('rejects an empty batch and invalid operationName', async () => {
        expect((await uploadProcess(request([], {}), {}, makeServer())).status).toBe(400)
        expect((await uploadProcess(request({ query: '{ hello }', operationName: 1 }, {}), {}, makeServer())).status).toBe(400)
    })
})
