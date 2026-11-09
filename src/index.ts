/** Preserves the buffered upload API and exports the optional streaming integration. */
import type { NextResponse } from 'next/server.js'
import {
    type MinimalRequest, type UploadServer, UploadRequestError,
    checkUploadRequest, executeOperations, prepareOperations, processUpload, uploadErrorResponse,
} from './core.js'

export {
    type File, type FileStream, type FormDataFile, type MinimalRequest,
    GraphQLUpload, Upload, bufferToStream, parseOperationsJSON,
    sanitizeAndValidateJSON, setValueAtPath, streamToBuffer, validateMap,
} from './core.js'
export { type StreamingFile, type StreamingRequest, type StreamingUploadSettings, uploadProcessStreaming } from './streaming.js'

/** Fully receives files before executing GraphQL; existing callers retain numeric file sizes. */
export async function uploadProcess<TContext extends Record<string, unknown>>(
    request: MinimalRequest,
    contextValueInput: TContext,
    server: UploadServer<TContext>,
    settings?: { allowedTypes?: string[]; maxFileSize?: number; maxFiles?: number },
): Promise<NextResponse> {
    try {
        checkUploadRequest(request.headers, settings)
        let formData: FormData
        try {
            formData = await request.formData()
        } catch {
            throw new UploadRequestError('Invalid multipart request body.')
        }
        const entries = [...formData.entries()].filter((entry): entry is [string, globalThis.File] => entry[1] instanceof globalThis.File)
        if (settings?.maxFiles !== undefined && entries.length > settings.maxFiles) {
            throw new UploadRequestError(`${settings.maxFiles} max file uploads exceeded.`, 413)
        }
        const operationsRaw = formData.get('operations')
        const mapRaw = formData.get('map')
        if (typeof operationsRaw !== 'string' || typeof mapRaw !== 'string' ||
            formData.getAll('operations').length !== 1 || formData.getAll('map').length !== 1) {
            throw new UploadRequestError('Missing, duplicate, or invalid map/operations in form data.')
        }
        const files = new Map<string, globalThis.File>()
        for (const [field, file] of entries) {
            if (files.has(field)) throw new UploadRequestError('Duplicate multipart file field.')
            if (settings?.maxFileSize !== undefined && file.size > settings.maxFileSize) {
                throw new UploadRequestError(`File ${file.name} size is too large.`, 413)
            }
            files.set(field, file)
        }
        const { operations, uploads } = prepareOperations(operationsRaw, mapRaw, settings?.maxFiles)
        await Promise.all([...uploads].map(async ([field, upload]) => {
            const file = files.get(field)
            if (!file) {
                upload.reject(new Error('File missing in the request.'))
                return
            }
            try {
                upload.resolve(await processUpload(file, settings?.allowedTypes))
            } catch (error) {
                upload.reject(new Error(`Failed to process file ${file.name}: ${(error as Error).message}`))
            }
        }))
        return await executeOperations(operations, contextValueInput, server)
    } catch (error) {
        return uploadErrorResponse(error)
    }
}
