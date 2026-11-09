/** Executes multipart operations while file bytes arrive, with bounded parsing and private disk spooling. */
import busboy from 'busboy'
import { WriteStream } from 'fs-capacitor'
import type { NextResponse } from 'next/server.js'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import {
    type File, type MinimalRequest, type Operation, type Upload, type UploadProcessSettings, type UploadServer,
    UploadRequestError, checkUploadRequest, detectMimeType, executeOperations, prepareOperations, uploadErrorResponse,
} from './core.js'

/** Streaming metadata deliberately has a different size contract from the buffered File. */
export interface StreamingFile extends Omit<File, 'fileSize' | 'createReadStream'> {
    /** Resolves after this file has been completely received and written to temporary storage. */
    fileSize: Promise<number>
    createReadStream: () => Readable
    /** Cancels the entire multipart request, including any aliases and other pending uploads. */
    abort: () => void
}

export interface StreamingRequest {
    body: ReadableStream<Uint8Array> | null
    headers: MinimalRequest['headers']
    signal?: AbortSignal
}

export interface StreamingUploadSettings extends UploadProcessSettings {
    maxFieldSize?: number
    maxRequestSize?: number
}

/** Opt-in Node.js API; success waits for reception, and all readers must finish within execution. */
export async function uploadProcessStreaming<TContext extends Record<string, unknown>>(
    request: StreamingRequest,
    contextValueInput: TContext,
    server: UploadServer<TContext>,
    settings: StreamingUploadSettings = {},
): Promise<NextResponse> {
    let dispose: (() => Promise<void>) | undefined
    try {
        checkUploadRequest(request.headers, settings)
        const limits = {
            maxFieldSize: settings.maxFieldSize === undefined ? 1024 * 1024 : settings.maxFieldSize,
            maxFileSize: settings.maxFileSize === undefined ? 10 * 1024 * 1024 : settings.maxFileSize,
            maxFiles: settings.maxFiles === undefined ? 10 : settings.maxFiles,
            maxRequestSize: settings.maxRequestSize === undefined ? 100 * 1024 * 1024 : settings.maxRequestSize,
        }
        for (const key of ['maxFieldSize', 'maxFileSize', 'maxFiles', 'maxRequestSize'] as const) {
            if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) {
                throw new UploadRequestError(`Invalid ${key} setting: expected a non-negative safe integer.`)
            }
        }
        if (!request.body || request.body.locked) throw new UploadRequestError('An unread request body is required.')
        const contentType = request.headers.get('content-type') || ''
        if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
            throw new UploadRequestError('Expected a multipart/form-data request.')
        }
        let parser: ReturnType<typeof busboy>
        try {
            parser = busboy({
                headers: { 'content-type': contentType }, defParamCharset: 'utf8',
                limits: {
                    fields: 2, files: limits.maxFiles,
                    // Busboy reports equality as truncation; the public limits are inclusive.
                    fieldSize: limits.maxFieldSize + 1, fileSize: limits.maxFileSize + 1,
                },
            })
        } catch {
            throw new UploadRequestError('Invalid multipart Content-Type or boundary.')
        }

        const ready = Promise.withResolvers<Operation | Operation[]>()
        const failure = Promise.withResolvers<never>()
        // Parser failures can precede the caller awaiting either promise.
        void ready.promise.catch(() => {})
        void failure.promise.catch(() => {})
        let uploads: Map<string, Upload<StreamingFile>> | undefined
        let operationsRaw: string | undefined
        let fatal: Error | undefined
        let released = false
        let requestSize = 0
        const seen = new Set<string>()
        const writes: Promise<void>[] = []
        const validations: Promise<void>[] = []
        const storage: { capacitor: WriteStream; ready: Promise<void>; closed: Promise<void> }[] = []
        const readers = new Set<Readable>()
        const sniffers = new Set<Transform>()
        const sizes = new Set<(error: Error) => void>()
        let cleanupError: Error | undefined
        const source = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])

        function fail(error: Error) {
            if (fatal || released) return
            fatal = error
            ready.reject(error)
            failure.reject(error)
            for (const upload of uploads?.values() || []) upload.reject(error)
            for (const reject of sizes) reject(error)
            // Let parser callbacks and native Fetch EOF microtasks finish before cancellation.
            setImmediate(() => {
                source.destroy(error)
                parser.destroy(error)
                for (const sniffer of sniffers) sniffer.destroy(error)
                for (const { capacitor, ready } of storage) {
                    void ready.then(() => capacitor.destroy(error), () => {})
                }
            })
        }

        const onAbort = () => fail(new UploadRequestError('Request aborted during file upload.', 499))
        request.signal?.addEventListener('abort', onAbort, { once: true })
        dispose = async () => {
            released = true
            request.signal?.removeEventListener('abort', onAbort)
            const error = fatal || new Error('Upload execution has finished.')
            for (const upload of uploads?.values() || []) upload.reject(error)
            for (const reject of sizes) reject(error)
            await new Promise<void>(resolve => setImmediate(resolve))
            source.destroy()
            parser.destroy()
            for (const reader of readers) reader.destroy(error)
            for (const sniffer of sniffers) sniffer.destroy()
            await Promise.allSettled(storage.map(entry => entry.ready))
            for (const { capacitor } of storage) capacitor.destroy()
            await Promise.all(storage.map(entry => entry.closed))
            if (cleanupError) throw cleanupError
        }

        parser.on('field', (name, value, info) => {
            if (fatal) return
            try {
                if (info.valueTruncated || Buffer.byteLength(value) > limits.maxFieldSize) {
                    throw new UploadRequestError('Multipart control field size limit exceeded.', 413)
                }
                if (name === 'operations' && operationsRaw === undefined && !uploads) {
                    operationsRaw = value
                } else if (name === 'map' && operationsRaw !== undefined && !uploads) {
                    const prepared = prepareOperations<StreamingFile>(operationsRaw, value, limits.maxFiles)
                    uploads = prepared.uploads
                    ready.resolve(prepared.operations)
                } else {
                    throw new UploadRequestError('Expected unique operations, then map, then file fields.')
                }
            } catch (error) {
                fail(error as Error)
            }
        })

        parser.on('file', (name, file, info) => {
            file.on('error', error => fail(error instanceof UploadRequestError ? error : new UploadRequestError('Incomplete multipart file.')))
            file.on('limit', () => fail(new UploadRequestError('File size limit exceeded.', 413)))
            if (fatal) { file.resume(); return }
            if (!uploads || seen.has(name) || name === 'operations' || name === 'map') {
                file.resume()
                fail(new UploadRequestError('Misordered or duplicate multipart file field.'))
                return
            }
            seen.add(name)
            const upload = uploads.get(name)
            if (!upload) { file.resume(); return }
            const filename = info.filename
            if (!filename) {
                file.resume()
                fail(new UploadRequestError('A non-empty file name is required.'))
                return
            }
            const capacitor = new WriteStream()
            const storageReady = new Promise<void>((resolve, reject) => {
                capacitor.once('ready', resolve)
                capacitor.once('error', reject)
            })
            void storageReady.catch(() => {})
            storage.push({ capacitor, ready: storageReady, closed: new Promise(resolve => capacitor.once('close', resolve)) })
            capacitor.on('error', error => {
                if (released) { if (error !== fatal) cleanupError ||= error }
                else fail(error)
            })
            const size = Promise.withResolvers<number>()
            void size.promise.catch(() => {})
            sizes.add(size.reject)
            let bytes = 0
            let prefixBytes = 0
            const prefix: Buffer[] = []
            let published = false
            const publish = () => {
                if (published || fatal || released) return
                published = true
                const validation = detectMimeType(Buffer.concat(prefix), settings.allowedTypes).then(mimetype => {
                    if (fatal || released) return
                    upload.resolve({
                        filename, encoding: info.encoding, mimetype, fileSize: size.promise,
                        abort: () => fail(new UploadRequestError('Multipart upload cancelled by a resolver.')),
                        createReadStream() {
                            if (fatal) throw fatal
                            if (released) throw new Error('Upload streams are unavailable after execution finishes.')
                            const reader = capacitor.createReadStream()
                            // Cancellation must also be safe for a reader whose consumer never attached.
                            reader.on('error', () => {})
                            readers.add(reader)
                            reader.once('close', () => readers.delete(reader))
                            return reader
                        },
                    })
                }, error => fail(new UploadRequestError(`File type detection failed: ${(error as Error).message}`)))
                validations.push(validation)
            }
            const sniffer = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    bytes += chunk.length
                    if (bytes > limits.maxFileSize) {
                        callback(new UploadRequestError('File size limit exceeded.', 413))
                        return
                    }
                    if (prefixBytes < 4100) {
                        const slice = chunk.subarray(0, 4100 - prefixBytes)
                        prefix.push(Buffer.from(slice))
                        prefixBytes += slice.length
                    }
                    if (prefixBytes === 4100) publish()
                    callback(null, chunk)
                },
                flush(callback) { publish(); callback() },
            })
            sniffers.add(sniffer)
            sniffer.on('error', fail)
            const write = finished(capacitor, { cleanup: true }).then(() => { size.resolve(bytes) }, error => {
                size.reject(error)
                fail(error)
            })
            writes.push(write)
            file.pipe(sniffer).pipe(capacitor)
        })

        parser.on('fieldsLimit', () => fail(new UploadRequestError('Only operations and map control fields are allowed.')))
        parser.on('filesLimit', () => fail(new UploadRequestError('File count limit exceeded.', 413)))
        parser.on('error', error => fail(error instanceof UploadRequestError ? error : new UploadRequestError('Malformed multipart request.')))
        parser.once('finish', () => {
            if (!uploads) { fail(new UploadRequestError('Missing operations or map multipart field.')); return }
            for (const [name, upload] of uploads) {
                if (!seen.has(name)) upload.reject(new Error('File missing in the request.'))
            }
        })
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            requestSize += chunk.length
            callback(requestSize > limits.maxRequestSize ? new UploadRequestError('Request size limit exceeded.', 413) : null, chunk)
        } })
        const received = pipeline(source, meter, parser).catch(error => {
            fail(error instanceof UploadRequestError ? error : new UploadRequestError('Incomplete multipart request.'))
        })
        if (request.signal?.aborted) onAbort()
        const operations = await ready.promise
        if (fatal) throw fatal
        const response = await Promise.race([executeOperations(operations, contextValueInput, server), failure.promise])
        await Promise.race([received.then(async () => {
            await Promise.all(writes)
            await Promise.all(validations)
        }), failure.promise])
        if (fatal) throw fatal
        return response
    } catch (error) {
        return uploadErrorResponse(error)
    } finally {
        await dispose?.()
    }
}
