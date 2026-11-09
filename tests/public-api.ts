/** Compiles legacy buffered consumers and the distinct opt-in streaming contract against published declarations. */
import { ApolloServer } from '@apollo/server'
import { Readable } from 'node:stream'
import {
    type File, type FileStream, type FormDataFile, type MinimalRequest, type StreamingFile,
    GraphQLUpload, Upload, bufferToStream, parseOperationsJSON, sanitizeAndValidateJSON,
    setValueAtPath, streamToBuffer, uploadProcess, uploadProcessStreaming, validateMap,
} from '../index.js'

const file: File = {
    createReadStream: () => Readable.from('hello'), encoding: 'binary', fileSize: 5,
    filename: 'hello.txt', mimetype: 'text/plain',
}
const upload = new Upload()
upload.resolve(file)
const parsed: Promise<File> = GraphQLUpload.parseValue(upload)
const size: number = (await upload.promise).fileSize
const existingRequest: MinimalRequest = { formData: async () => new FormData(), headers: new Headers() }
const server = new ApolloServer<{ userId: string }>({ typeDefs: 'type Query { ok: Boolean }' })
await uploadProcess(existingRequest, { userId: 'existing' }, server, { maxFileSize: size, maxFiles: 1 })
await uploadProcessStreaming(new Request('http://localhost'), { userId: 'new' }, server)

declare const streamed: StreamingFile
const finalSize: Promise<number> = streamed.fileSize
// @ts-expect-error Streaming metadata cannot silently satisfy the old synchronous size contract.
const incompatible: File = streamed
const raw: FormDataFile = { lastModified: 0, name: 'file', size, type: 'text/plain' }
const legacyStream: FileStream = { ...raw, stream: () => new ReadableStream() }
void [GraphQLUpload, bufferToStream, parseOperationsJSON, sanitizeAndValidateJSON,
    setValueAtPath, streamToBuffer, validateMap, legacyStream, finalSize, incompatible, parsed]
