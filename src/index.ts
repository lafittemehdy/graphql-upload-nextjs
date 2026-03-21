import type { GraphQLResponse } from '@apollo/server'
import { fileTypeFromBuffer } from 'file-type'
import { GraphQLError, GraphQLScalarType } from 'graphql'
import { isText } from 'istextorbinary'
import { NextResponse } from 'next/server.js'
import { Readable } from 'stream'

/** Represents a processed file with metadata and stream access. */
export interface File {
    createReadStream: () => NodeJS.ReadableStream
    encoding: string
    fileSize: number
    filename: string
    mimetype: string
}

/** Raw file entry extracted from multipart FormData. */
export interface FormDataFile {
    lastModified: number
    name: string
    size: number
    type: string
}

/** Extends FormDataFile with a stream method for reading file contents. */
export interface FileStream extends FormDataFile {
    stream: () => ReadableStream
}

/** Minimal request interface compatible with Next.js and Web API requests. */
export interface MinimalRequest {
    formData: () => Promise<FormData>
    headers: {
        get: (name: string) => string | null
    }
}

/** Parameters for Apollo Server's executeOperation method. */
interface ServerExecuteOperationParams {
    query: string
    variables: Record<string, unknown>
}

/**
 * Represents an instance of a file upload.
 * Holds a promise that resolves with the file details once processed.
 */
export class Upload {
    file?: File
    promise: Promise<File>
    reject: (reason?: Error | string) => void = () => { }
    resolve: (file: File) => void = () => { }

    constructor() {
        this.promise = new Promise<File>((resolve, reject) => {
            this.resolve = (file: File) => {
                this.file = file
                resolve(file)
            }
            this.reject = reject
        })
        this.promise.catch(() => { })
    }
}

/** Custom GraphQL scalar type for handling file uploads. */
export const GraphQLUpload = new GraphQLScalarType({
    description: 'The Upload scalar type represents a file upload.',
    name: 'Upload',
    parseLiteral(node) {
        throw new GraphQLError('Upload literal unsupported.', { nodes: node })
    },
    parseValue(value) {
        if (value instanceof Upload) return value.promise
        throw new GraphQLError('Upload value invalid.')
    },
    serialize() {
        throw new GraphQLError('Upload serialization unsupported.')
    },
})

/** Converts a Buffer into a Node.js readable stream. */
export function bufferToStream(buffer: Buffer): NodeJS.ReadableStream {
    const stream = new Readable()
    stream.push(buffer)
    stream.push(null)
    return stream
}

/** Collects a GraphQL response into a serializable result object. */
async function collectResponse<TContext>(response: GraphQLResponse<TContext>): Promise<unknown> {
    if (response.body.kind === 'single') {
        return response.body.singleResult
    }
    if (response.body.kind === 'incremental') {
        const { initialResult, subsequentResults } = response.body
        const collected = []
        for await (const result of subsequentResults) {
            collected.push(result)
        }
        return { initialResult, subsequentResults: collected }
    }
    return { errors: [{ message: 'Unexpected server response format' }] }
}

/** Extracts File entries from multipart FormData. */
async function extractFiles(formData: FormData): Promise<Record<string, FormDataFile>> {
    const files: Record<string, FormDataFile> = {}
    for (const [key, value] of formData.entries()) {
        if (value instanceof globalThis.File) {
            files[key] = value as FormDataFile
        }
    }
    return files
}

/** Parses JSON for the operations field. Accepts objects or arrays (for batching per spec). */
export function parseOperationsJSON(input: string): Record<string, unknown> | Record<string, unknown>[] {
    let result: unknown
    try {
        result = JSON.parse(input)
    } catch {
        throw new Error('Invalid JSON in the operations multipart field.')
    }
    if (typeof result !== 'object' || result === null) {
        throw new Error('Invalid type for the operations multipart field.')
    }
    return result as Record<string, unknown> | Record<string, unknown>[]
}

/**
 * Processes a file from FormData, detects its MIME type via magic bytes,
 * and returns a resolved Upload instance with streaming file access.
 */
async function processUpload(
    file: FormDataFile,
    allowedTypes?: string[]
): Promise<Upload> {
    if (!file.name || typeof file.size !== 'number' || !file.type) {
        throw new Error('Invalid file properties: name, size, or type is missing or invalid.')
    }

    const blob = file as unknown as Blob

    // Only read the first 4100 bytes for MIME type detection via magic bytes.
    // This avoids buffering the entire file into memory.
    const DETECTION_BYTES = 4100
    const headerBuffer = Buffer.from(await blob.slice(0, DETECTION_BYTES).arrayBuffer())
    const fileTypeInfo = await fileTypeFromBuffer(
        new Uint8Array(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength)
    )

    let mimetype = file.type
    if (fileTypeInfo) {
        mimetype = fileTypeInfo.mime
    } else {
        try {
            if (await isText(file.name, headerBuffer)) {
                mimetype = 'text/plain'
            }
        } catch {
            // Fallback: isText detection failed, proceeding with original mimetype from FormData.
        }
    }

    if (allowedTypes && !allowedTypes.includes(mimetype)) {
        throw new Error(`File type ${mimetype} is not allowed. Allowed types: ${allowedTypes.join(', ')}`)
    }

    const upload = new Upload()
    upload.resolve({
        createReadStream: () => Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]),
        encoding: 'binary',
        fileSize: file.size,
        filename: file.name,
        mimetype,
    })
    return upload
}

/** Parses and validates a JSON string, ensuring it resolves to a non-null object (rejects arrays). */
export function sanitizeAndValidateJSON(input: string): unknown {
    let result: unknown
    try {
        result = JSON.parse(input)
    } catch (error) {
        throw new Error(`Invalid JSON input: ${(error as Error).message}`)
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Invalid JSON structure: expected a non-null object.')
    }
    return result
}

/** Dangerous property names that could lead to prototype pollution. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Sets a value at a dot-notation path in a nested object, creating intermediate containers as needed. */
export function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.')
    let current: Record<string, unknown> = obj

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]

        if (BLOCKED_KEYS.has(key)) {
            throw new Error(`Invalid path segment: '${key}' is not allowed.`)
        }

        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1])

        if (
            !current[key] ||
            typeof current[key] !== 'object' ||
            (nextKeyIsArrayIndex && !Array.isArray(current[key])) ||
            (!nextKeyIsArrayIndex && Array.isArray(current[key]))
        ) {
            current[key] = nextKeyIsArrayIndex ? [] : {}
        }

        current = current[key] as Record<string, unknown>
    }

    const finalKey = keys[keys.length - 1]
    if (BLOCKED_KEYS.has(finalKey)) {
        throw new Error(`Invalid path segment: '${finalKey}' is not allowed.`)
    }
    current[finalKey] = value
}

/** Converts a Node.js readable stream into a Buffer by collecting all chunks. */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk)
        } else if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk))
        } else {
            chunks.push(Buffer.from(chunk as Uint8Array))
        }
    }
    return Buffer.concat(chunks as unknown as readonly Uint8Array[])
}

/** Validates that each map entry is an array of string paths. */
export function validateMap(map: Record<string, unknown>): string | null {
    for (const [key, paths] of Object.entries(map)) {
        if (!Array.isArray(paths)) {
            return `Invalid type for map entry '${key}': expected an array of paths.`
        }
        for (const p of paths) {
            if (typeof p !== 'string') {
                return `Invalid path in map entry '${key}': expected string.`
            }
        }
    }
    return null
}

/** Processes a GraphQL multipart request with file uploads. Supports batching per the spec. */
export async function uploadProcess<TContext extends Record<string, unknown>>(
    request: MinimalRequest,
    contextValueInput: TContext,
    server: {
        executeOperation: (
            params: ServerExecuteOperationParams,
            context: { contextValue: TContext }
        ) => Promise<GraphQLResponse<TContext>>
    },
    settings?: { allowedTypes?: string[]; maxFiles?: number; maxFileSize?: number }
): Promise<NextResponse> {
    try {
        const formData = await request.formData()
        const files = await extractFiles(formData)

        const mapRaw = formData.get('map')
        const operationsRaw = formData.get('operations')

        if (!mapRaw || !operationsRaw || typeof mapRaw !== 'string' || typeof operationsRaw !== 'string') {
            return NextResponse.json(
                { errors: [{ message: 'Missing or invalid map/operations in form data.' }] },
                { status: 400 }
            )
        }

        const mapString = mapRaw
        const operationsString = operationsRaw

        // Parse and validate the map field (must be an object, not array).
        let map: Record<string, string[]>
        try {
            map = sanitizeAndValidateJSON(mapString) as Record<string, string[]>
        } catch {
            return NextResponse.json(
                { errors: [{ message: 'Invalid JSON in the map multipart field.' }] },
                { status: 400 }
            )
        }

        const mapError = validateMap(map)
        if (mapError) {
            return NextResponse.json(
                { errors: [{ message: mapError }] },
                { status: 400 }
            )
        }

        // Parse the operations field (object or array for batching).
        let parsedOperations: Record<string, unknown> | Record<string, unknown>[]
        try {
            parsedOperations = parseOperationsJSON(operationsString)
        } catch {
            return NextResponse.json(
                { errors: [{ message: 'Invalid JSON in the operations multipart field.' }] },
                { status: 400 }
            )
        }

        // Check maxFiles limit.
        if (settings?.maxFiles && Object.keys(map).length > settings.maxFiles) {
            return NextResponse.json(
                { errors: [{ message: `${settings.maxFiles} max file uploads exceeded.` }] },
                { status: 413 }
            )
        }

        // Normalize operations into a keyed object for path resolution.
        // Single: paths are "variables.file" → use the operation object directly.
        // Batch: paths are "0.variables.file" → use indices as keys in a wrapper object.
        const isBatch = Array.isArray(parsedOperations)
        let operationsRoot: Record<string, unknown>

        if (isBatch) {
            operationsRoot = {}
            for (let i = 0; i < (parsedOperations as Record<string, unknown>[]).length; i++) {
                const op = (parsedOperations as Record<string, unknown>[])[i]
                if (!op.variables) op.variables = {}
                operationsRoot[String(i)] = op
            }
        } else {
            const singleOp = parsedOperations as Record<string, unknown>
            if (!singleOp.variables) singleOp.variables = {}
            operationsRoot = singleOp
        }

        // Process files and resolve Upload instances at mapped paths.
        const fileProcessingPromises: Promise<void>[] = []

        for (const fileKeyInMap of Object.keys(map)) {
            const file = files[fileKeyInMap]

            if (!file) {
                // Per spec: reject Upload promise when file is missing from the request.
                for (const filePath of map[fileKeyInMap]) {
                    const missingUpload = new Upload()
                    missingUpload.reject(new Error('File missing in the request.'))
                    setValueAtPath(operationsRoot, filePath, missingUpload)
                }
                continue
            }

            if (settings?.maxFileSize && file.size > settings.maxFileSize) {
                return NextResponse.json(
                    { errors: [{ message: `File ${file.name} size is too large. Maximum allowed size is ${(settings.maxFileSize / (1024 * 1024)).toFixed(2)}MB.` }] },
                    { status: 413 }
                )
            }

            const variablePaths = map[fileKeyInMap]

            const filePromise = processUpload(file, settings?.allowedTypes)
                .then(uploadInstance => {
                    for (const filePath of variablePaths) {
                        setValueAtPath(operationsRoot, filePath, uploadInstance)
                    }
                })
                .catch((error: Error) => {
                    for (const filePath of variablePaths) {
                        const uploadError = new Upload()
                        uploadError.reject(new Error(`Failed to process file ${file.name}: ${error.message}`))
                        setValueAtPath(operationsRoot, filePath, uploadError)
                    }
                })

            fileProcessingPromises.push(filePromise)
        }

        await Promise.all(fileProcessingPromises)

        // Execute operations and collect results.
        if (isBatch) {
            const results = []
            const sortedKeys = Object.keys(operationsRoot).sort((a, b) => Number(a) - Number(b))
            for (const key of sortedKeys) {
                const op = operationsRoot[key] as { query: string; variables: Record<string, unknown> }
                const response = await server.executeOperation(
                    { query: op.query, variables: op.variables || {} },
                    { contextValue: contextValueInput }
                )
                results.push(await collectResponse(response))
            }
            return NextResponse.json(results)
        }

        const response = await server.executeOperation(
            { query: (operationsRoot as { query: string }).query, variables: (operationsRoot as { variables: Record<string, unknown> }).variables },
            { contextValue: contextValueInput }
        )

        return NextResponse.json(await collectResponse(response))
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during upload processing.'
        return NextResponse.json(
            { errors: [{ message: `Error processing upload: ${errorMessage}` }] },
            { status: 500 }
        )
    }
}
