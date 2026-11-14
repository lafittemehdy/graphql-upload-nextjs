/** Verifies example persistence keeps numeric metadata and never leaves partially written files. */
import { mkdtemp, readFile, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { processAndStoreFile } from '../examples/example-graphql-upload-nextjs/src/lib/storeUpload'

let directory: string
let restore: () => void
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upload-storage-test-'))
    restore = vi.spyOn(process, 'cwd').mockReturnValue(directory).mockRestore
})
afterAll(async () => {
    restore()
    await rmdir(path.join(directory, 'uploads'))
    await rmdir(directory)
})

it('removes a partial destination when the source stream fails', async () => {
    const source = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('source failed') })())
    await expect(processAndStoreFile({
        createReadStream: () => source, encoding: 'binary', filename: 'file.txt', mimetype: 'text/plain', fileSize: 7,
    })).rejects.toThrow('source failed')
    expect(await readdir(path.join(directory, 'uploads'))).toEqual([])
})

it('stores a completed stream and awaits its final size', async () => {
    const result = await processAndStoreFile({
        createReadStream: () => Readable.from('hello'), encoding: 'binary', filename: '../name.txt',
        mimetype: 'text/plain', fileSize: Promise.resolve(5), abort() {},
    })
    expect(result.filename).toBe('name.txt')
    expect(result.fileSize).toBe(5)
    const saved = path.join(directory, 'uploads', path.basename(result.uri))
    expect(await readFile(saved, 'utf8')).toBe('hello')
    if (process.platform !== 'win32') {
        expect((await stat(saved)).mode & 0o777).toBe(0o600)
        expect((await stat(path.dirname(saved))).mode & 0o777).toBe(0o700)
    }
    await unlink(saved)
})
