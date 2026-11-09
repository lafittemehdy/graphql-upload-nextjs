/** Specifies buffered upload compatibility and malformed-input regressions. */
import { expect, it, vi } from 'vitest'
import { uploadProcess } from '../src/index'

function request(variables: object, map: object) {
    const body = new FormData()
    body.set('operations', JSON.stringify({ query: 'mutation { upload }', variables }))
    body.set('map', JSON.stringify(map))
    body.set('0', new File(['first'], 'first.txt'))
    return { body, formData: async () => body, headers: new Headers({ 'Apollo-Require-Preflight': 'true' }) }
}

function server() {
    return { executeOperation: vi.fn(async () => ({ body: { kind: 'single', singleResult: { data: { ok: true } } } })) }
}

it('preserves numeric object keys and sibling values while injecting uploads', async () => {
    const req = request({ input: { '0': null, caption: 'keep' } }, { 0: ['variables.input.0'] })
    let input: any
    const api = { executeOperation: async (params: any) => {
        input = params.variables.input
        return { body: { kind: 'single', singleResult: {} } }
    } }
    expect((await uploadProcess(req, {}, api)).status).toBe(200)
    expect(Array.isArray(input)).toBe(false)
    expect(input.caption).toBe('keep')
    expect(typeof (await input['0'].promise).fileSize).toBe('number')
})

it('rejects competing files mapped to the same placeholder before execution', async () => {
    const req = request({ file: null }, { 0: ['variables.file'], 1: ['variables.file'] })
    req.body.set('1', new File(['second'], 'second.txt'))
    const api = server()
    expect((await uploadProcess(req, {}, api)).status).toBe(400)
    expect(api.executeOperation).not.toHaveBeenCalled()
})

it('rejects duplicate file parts instead of silently choosing the last one', async () => {
    const req = request({ file: null }, { 0: ['variables.file'] })
    req.body.append('0', new File(['second'], 'second.txt'))
    const api = server()
    expect((await uploadProcess(req, {}, api)).status).toBe(400)
    expect(api.executeOperation).not.toHaveBeenCalled()
})

it('reports malformed multipart syntax as a client error', async () => {
    const req = new Request('http://localhost/graphql', {
        method: 'POST', body: 'invalid',
        headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Apollo-Require-Preflight': 'true' },
    })
    const api = server()
    expect((await uploadProcess(req, {}, api)).status).toBe(400)
    expect(api.executeOperation).not.toHaveBeenCalled()
})

it('does not expose unexpected server exception details', async () => {
    const req = request({ file: null }, { 0: ['variables.file'] })
    const api = { executeOperation: async () => { throw new Error('database-password=secret') } }
    const response = await uploadProcess(req, {}, api)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('database-password')
})
