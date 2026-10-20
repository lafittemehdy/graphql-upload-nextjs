import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { GET } from '../examples/example-graphql-upload-nextjs/src/app/uploads/[filename]/route'

const filename = '12345678-1234-1234-1234-123456789abc.txt'
let directory: string
let restore: () => void

beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'graphql-upload-'))
    await mkdir(path.join(directory, 'uploads'))
    await writeFile(path.join(directory, 'uploads', filename), '<script>example</script>')
    restore = vi.spyOn(process, 'cwd').mockReturnValue(directory).mockRestore
})
afterAll(async () => {
    restore()
    await unlink(path.join(directory, 'uploads', filename))
    await rmdir(path.join(directory, 'uploads'))
    await rmdir(directory)
})

it('serves uploaded content as an attachment with a safe content type', async () => {
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ filename }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('<script>example</script>')
})
it.each(['../package.json', 'file.html', '00000000-0000-0000-0000-000000000000.txt'])('does not expose invalid or absent file %s', async requested => {
    expect((await GET(new Request('http://localhost'), { params: Promise.resolve({ filename: requested }) })).status).toBe(404)
})
