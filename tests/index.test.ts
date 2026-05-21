import {
    type File,
    GraphQLUpload,
    Upload,
    bufferToStream,
    parseOperationsJSON,
    sanitizeAndValidateJSON,
    setValueAtPath,
    streamToBuffer,
    validateMap,
} from '../src/index'

describe('sanitizeAndValidateJSON', () => {
    it('parses a valid JSON object', () => {
        expect(sanitizeAndValidateJSON('{"key": "value"}')).toEqual({ key: 'value' })
    })

    it('parses a nested JSON object', () => {
        expect(sanitizeAndValidateJSON('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } })
    })

    it('throws on invalid JSON', () => {
        expect(() => sanitizeAndValidateJSON('not json')).toThrow('Invalid JSON input')
    })

    it('throws on JSON array (arrays rejected for map field)', () => {
        expect(() => sanitizeAndValidateJSON('[1, 2, 3]')).toThrow('Invalid JSON structure')
    })

    it('throws on JSON string', () => {
        expect(() => sanitizeAndValidateJSON('"hello"')).toThrow('Invalid JSON structure')
    })

    it('throws on JSON null', () => {
        expect(() => sanitizeAndValidateJSON('null')).toThrow('Invalid JSON structure')
    })

    it('throws on JSON number', () => {
        expect(() => sanitizeAndValidateJSON('42')).toThrow('Invalid JSON structure')
    })

    it('throws on empty string', () => {
        expect(() => sanitizeAndValidateJSON('')).toThrow('Invalid JSON input')
    })
})

describe('parseOperationsJSON', () => {
    it('parses a single operation object', () => {
        const result = parseOperationsJSON('{"query": "{ hello }", "variables": {}}')
        expect(result).toEqual({ query: '{ hello }', variables: {} })
        expect(Array.isArray(result)).toBe(false)
    })

    it('parses a batch of operations (array)', () => {
        const input = '[{"query": "{ a }"}, {"query": "{ b }"}]'
        const result = parseOperationsJSON(input)
        expect(Array.isArray(result)).toBe(true)
        expect(result).toHaveLength(2)
    })

    it('throws on invalid JSON', () => {
        expect(() => parseOperationsJSON('{')).toThrow('Invalid JSON in the operations')
    })

    it('throws on null', () => {
        expect(() => parseOperationsJSON('null')).toThrow('Invalid type for the operations')
    })

    it('throws on primitive string', () => {
        expect(() => parseOperationsJSON('"hello"')).toThrow('Invalid type for the operations')
    })

    it('throws on number', () => {
        expect(() => parseOperationsJSON('42')).toThrow('Invalid type for the operations')
    })
})

describe('setValueAtPath', () => {
    it('sets a value at a simple root key', () => {
        const obj: Record<string, unknown> = {}
        setValueAtPath(obj, 'key', 'value')
        expect(obj).toEqual({ key: 'value' })
    })

    it('sets a value at a nested path', () => {
        const obj: Record<string, unknown> = {}
        setValueAtPath(obj, 'a.b.c', 'deep')
        expect(obj).toEqual({ a: { b: { c: 'deep' } } })
    })

    it('creates an array when the next key is a numeric index', () => {
        const obj: Record<string, unknown> = {}
        setValueAtPath(obj, 'files.0', 'first')
        expect(obj).toEqual({ files: ['first'] })
    })

    it('sets a value deep inside a mixed object/array path', () => {
        const obj: Record<string, unknown> = {}
        setValueAtPath(obj, 'variables.files.0', 'upload0')
        expect(obj).toEqual({ variables: { files: ['upload0'] } })
    })

    it('handles batch-style paths with leading numeric index', () => {
        const obj: Record<string, unknown> = {
            '0': { variables: { file: null } },
        }
        setValueAtPath(obj, '0.variables.file', 'upload')
        expect((obj['0'] as any).variables.file).toBe('upload')
    })

    it('preserves existing sibling keys', () => {
        const obj: Record<string, unknown> = { existing: true }
        setValueAtPath(obj, 'new.path', 'value')
        expect(obj.existing).toBe(true)
        expect(obj).toEqual({ existing: true, new: { path: 'value' } })
    })

    it('overwrites an array with an object when path conflicts', () => {
        const obj: Record<string, unknown> = { a: [1, 2, 3] }
        setValueAtPath(obj, 'a.key', 'value')
        expect(obj).toEqual({ a: { key: 'value' } })
    })

    it('overwrites an object with an array when path conflicts', () => {
        const obj: Record<string, unknown> = { a: { key: 'old' } }
        setValueAtPath(obj, 'a.0', 'value')
        expect(obj).toEqual({ a: ['value'] })
    })

    it('supports multiple array indices', () => {
        const obj: Record<string, unknown> = {}
        setValueAtPath(obj, 'files.0', 'a')
        setValueAtPath(obj, 'files.1', 'b')
        expect(obj).toEqual({ files: ['a', 'b'] })
    })

    it('rejects __proto__ to prevent prototype pollution', () => {
        const obj: Record<string, unknown> = {}
        expect(() => setValueAtPath(obj, '__proto__.polluted', true)).toThrow('not allowed')
        expect(({} as any).polluted).toBeUndefined()
    })

    it('rejects constructor to prevent prototype pollution', () => {
        const obj: Record<string, unknown> = {}
        expect(() => setValueAtPath(obj, 'constructor.prototype.polluted', true)).toThrow('not allowed')
        expect(({} as any).polluted).toBeUndefined()
    })

    it('rejects prototype to prevent prototype pollution', () => {
        const obj: Record<string, unknown> = {}
        expect(() => setValueAtPath(obj, 'a.prototype.polluted', true)).toThrow('not allowed')
    })

    it('rejects __proto__ as final key', () => {
        const obj: Record<string, unknown> = {}
        expect(() => setValueAtPath(obj, 'a.__proto__', true)).toThrow('not allowed')
    })
})

describe('validateMap', () => {
    it('returns null for a valid map', () => {
        expect(validateMap({ '0': ['variables.file'] })).toBeNull()
    })

    it('returns null for a map with multiple entries', () => {
        expect(validateMap({
            '0': ['variables.files.0'],
            '1': ['variables.files.1'],
        })).toBeNull()
    })

    it('returns null for an empty map', () => {
        expect(validateMap({})).toBeNull()
    })

    it('returns null for a map with multiple paths per file (deduplication)', () => {
        expect(validateMap({ '0': ['variables.file1', 'variables.file2'] })).toBeNull()
    })

    it('returns error for a non-array map entry', () => {
        const result = validateMap({ '0': 'variables.file' as any })
        expect(result).toContain('expected an array')
    })

    it('returns error for a non-string path in array', () => {
        const result = validateMap({ '0': [42] as any })
        expect(result).toContain('expected string')
    })

    it('returns error for a null map entry', () => {
        const result = validateMap({ '0': null as any })
        expect(result).toContain('expected an array')
    })

    it('returns error for an empty path', () => {
        const result = validateMap({ '0': [''] })
        expect(result).toContain('path cannot be empty')
    })

    it('returns error for empty path segments', () => {
        const result = validateMap({ '0': ['variables..file'] })
        expect(result).toContain('empty segments')
    })

    it('returns error for blocked path segments', () => {
        const result = validateMap({ '0': ['variables.__proto__.polluted'] })
        expect(result).toContain('not allowed')
    })
})

describe('bufferToStream and streamToBuffer', () => {
    it('round-trips a text buffer', async () => {
        const original = Buffer.from('hello world')
        const stream = bufferToStream(original)
        const result = await streamToBuffer(stream)
        expect(result.equals(original)).toBe(true)
    })

    it('round-trips an empty buffer', async () => {
        const original = Buffer.alloc(0)
        const stream = bufferToStream(original)
        const result = await streamToBuffer(stream)
        expect(result.length).toBe(0)
    })

    it('round-trips binary data', async () => {
        const original = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe])
        const stream = bufferToStream(original)
        const result = await streamToBuffer(stream)
        expect(result.equals(original)).toBe(true)
    })

    it('round-trips a large buffer', async () => {
        const original = Buffer.alloc(1024 * 1024, 0xab)
        const stream = bufferToStream(original)
        const result = await streamToBuffer(stream)
        expect(result.equals(original)).toBe(true)
    })
})

describe('Upload', () => {
    it('resolves promise with file data using spec property names', async () => {
        const upload = new Upload()
        const file: File = {
            createReadStream: () => bufferToStream(Buffer.from('')),
            encoding: 'utf-8',
            fileSize: 0,
            filename: 'test.txt',
            mimetype: 'text/plain',
        }
        upload.resolve(file)
        const result = await upload.promise
        expect(result).toBe(file)
        expect(result.filename).toBe('test.txt')
        expect(result.mimetype).toBe('text/plain')
        expect(upload.file).toBe(file)
    })

    it('rejects promise with an Error', async () => {
        const upload = new Upload()
        upload.reject(new Error('upload failed'))
        await expect(upload.promise).rejects.toThrow('upload failed')
    })

    it('rejects promise with a string reason', async () => {
        const upload = new Upload()
        upload.reject('string reason')
        await expect(upload.promise).rejects.toBe('string reason')
    })

    it('starts with file as undefined', () => {
        const upload = new Upload()
        expect(upload.file).toBeUndefined()
    })
})

describe('GraphQLUpload', () => {
    it('has the correct name and description', () => {
        expect(GraphQLUpload.name).toBe('Upload')
        expect(GraphQLUpload.description).toBe('The Upload scalar type represents a file upload.')
    })

    it('parseValue returns promise for Upload instances', () => {
        const upload = new Upload()
        const result = GraphQLUpload.parseValue(upload)
        expect(result).toBe(upload.promise)
    })

    it('parseValue throws for non-Upload values', () => {
        expect(() => GraphQLUpload.parseValue('not an upload')).toThrow('Upload value invalid')
        expect(() => GraphQLUpload.parseValue(null)).toThrow('Upload value invalid')
        expect(() => GraphQLUpload.parseValue(42)).toThrow('Upload value invalid')
    })

    it('serialize throws', () => {
        expect(() => GraphQLUpload.serialize(null)).toThrow('Upload serialization unsupported')
    })

    it('parseLiteral throws', () => {
        const fakeNode = { kind: 'StringValue' as const, value: 'test' }
        expect(() => GraphQLUpload.parseLiteral(fakeNode, {})).toThrow('Upload literal unsupported')
    })
})
