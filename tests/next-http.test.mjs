/** Verifies both upload APIs through an actual Next.js production server and real HTTP sockets. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const example = path.join(root, 'examples/example-graphql-upload-nextjs')
const uploads = path.join(example, 'uploads')
const created = new Set()
let child
let origin
let logs = ''

async function until(check, message) {
    const expires = Date.now() + 10000
    while (Date.now() < expires) {
        const result = await check()
        if (result) return result
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`${message}\n${logs}`)
}

async function names() {
    try { return await readdir(uploads) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

before(async () => {
    await stat(path.join(example, '.next/BUILD_ID'))
    child = spawn(process.execPath, [path.join(example, 'node_modules/next/dist/bin/next'), 'start', '--port', '0'], {
        cwd: example, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    })
    child.stdout.on('data', chunk => { logs += chunk })
    child.stderr.on('data', chunk => { logs += chunk })
    await until(() => {
        assert.equal(child.exitCode, null, logs)
        const match = logs.match(/http:\/\/localhost:(\d+)/)
        if (match && /Ready in/.test(logs)) return `http://127.0.0.1:${match[1]}`
    }, 'Next.js did not start')
        .then(value => { origin = value })
}, { timeout: 20000 })

after(async () => {
    if (child && child.exitCode === null) {
        const exited = once(child, 'exit')
        if (process.platform === 'win32') {
            const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
            assert.equal(result.status, 0, result.stderr?.toString())
        } else child.kill('SIGTERM')
        await exited
    }
    for (const name of created) {
        try { await unlink(path.join(uploads, name)) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.doesNotMatch(logs, /uncaughtException:|unhandledRejection:/, logs)
})

for (const endpoint of ['/api/graphql', '/api/graphql-streaming']) {
    test(`${endpoint} preserves operation selection, numeric output size, and download contents`, async () => {
        const body = new FormData()
        body.set('operations', JSON.stringify({
            query: 'mutation A($file: Upload!) { uploadFile(file: $file) { filename } } mutation B($file: Upload!) { selected: uploadFile(file: $file) { filename fileSize uri } }',
            operationName: 'B', variables: { file: null },
        }))
        body.set('map', JSON.stringify({ arbitrary: ['variables.file'] }))
        body.set('arbitrary', new File(['real HTTP upload'], 'test.txt'))
        const response = await fetch(origin + endpoint, { method: 'POST', body, headers: { 'Apollo-Require-Preflight': 'true' } })
        assert.equal(response.status, 200)
        const result = await response.json()
        assert.equal(result.errors, undefined, JSON.stringify(result))
        const file = result.data.selected
        created.add(path.basename(file.uri))
        assert.equal(file.filename, 'test.txt')
        assert.equal(file.fileSize, 16)
        const download = await fetch(origin + file.uri)
        assert.equal(download.status, 200)
        assert.match(download.headers.get('content-disposition'), /attachment/)
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
        assert.equal(await download.text(), 'real HTTP upload')
    })
}

test('streaming rejects a completed invalid MIME upload without uncaught runtime errors', async () => {
    const body = new FormData()
    body.set('operations', JSON.stringify({
        query: 'mutation($file: Upload!) { uploadFile(file: $file) { filename } }', variables: { file: null },
    }))
    body.set('map', JSON.stringify({ 0: ['variables.file'] }))
    body.set('0', new File([new Uint8Array([0, 255, 1, 250, 0, 255])], 'spoofed.txt', { type: 'text/plain' }))
    const response = await fetch(origin + '/api/graphql-streaming', {
        method: 'POST', body, headers: { 'Apollo-Require-Preflight': 'true' },
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /not allowed/)
})

function beginUpload() {
    const req = http.request(origin + '/api/graphql-streaming', {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=live', 'Apollo-Require-Preflight': 'true' },
    })
    const operations = { query: 'mutation($file: Upload!) { uploadFile(file: $file) { uri fileSize } }', variables: { file: null } }
    req.write(`--live\r\nContent-Disposition: form-data; name="operations"\r\n\r\n${JSON.stringify(operations)}\r\n`)
    req.write('--live\r\nContent-Disposition: form-data; name="map"\r\n\r\n{"file":["variables.file"]}\r\n')
    req.write('--live\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\n')
    req.write('s'.repeat(5000))
    return req
}

async function partialFile(previous) {
    return until(async () => {
        for (const name of await names()) {
            if (previous.has(name)) continue
            if ((await stat(path.join(uploads, name))).size >= 5000) {
                created.add(name)
                return name
            }
        }
    }, 'Resolver did not write bytes while the client withheld upload completion')
}

test('production Next.js writes file bytes before the client finishes its request', async () => {
    const previous = new Set(await names())
    const req = beginUpload()
    const response = once(req, 'response')
    try {
        const name = await partialFile(previous)
        assert.equal((await readFile(path.join(uploads, name))).toString(), 's'.repeat(5000))
        req.end('tail\r\n--live--\r\n')
        const [res] = await response
        const chunks = []
        for await (const chunk of res) chunks.push(chunk)
        assert.equal(res.statusCode, 200)
        const result = JSON.parse(Buffer.concat(chunks).toString())
        assert.equal(result.errors, undefined, JSON.stringify(result))
        assert.equal(result.data.uploadFile.fileSize, 5004)
    } finally { req.destroy() }
})

test('production Next.js removes partial application files when the client disconnects', async () => {
    const previous = new Set(await names())
    const req = beginUpload()
    req.on('error', error => { assert.equal(error.message, 'intentional test disconnect') })
    try {
        const name = await partialFile(previous)
        req.destroy(new Error('intentional test disconnect'))
        await until(async () => !(await names()).includes(name), 'Partial destination remained after client disconnect')
    } finally { req.destroy() }
})
