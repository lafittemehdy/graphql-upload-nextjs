/** Defines upload values, MIME detection, validation, and execution shared by both upload APIs. */
import { fileTypeFromBuffer } from 'file-type'
import { GraphQLError, GraphQLScalarType } from 'graphql'
import { isText } from 'istextorbinary'
import { NextResponse } from 'next/server.js'
import { Readable } from 'stream'

const DEFAULT_MIME_TYPE = 'application/octet-stream'

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
    operationName?: string
    query: string
    variables: Record<string, unknown>
}

/** Minimal response shape consumed from Apollo Server executeOperation. */
interface ServerExecuteOperationResponse {
    body: {
        kind: string
        [key: string]: unknown
    }
}

interface IncrementalResponseBody {
    kind: 'incremental'
    initialResult: unknown
    subsequentResults: AsyncIterable<unknown>
}

/** Normalized GraphQL operation shape passed to Apollo Server. */
export interface Operation {
    operationName?: string
    query: string
    variables?: Record<string, unknown>
}

/** Optional upload processing limits and MIME allow-list. */
export interface UploadProcessSettings {
    allowedTypes?: string[]
    maxFileSize?: number
    maxFiles?: number
}

/**
 * Represents an instance of a file upload.
 * Holds a promise that resolves with the file details once processed.
 */
export class Upload<TFile = File> {
    file?: TFile
    promise: Promise<TFile>
    reject: (reason?: Error | string) => void = () => { }
    resolve: (file: TFile) => void = () => { }

    constructor() {
        this.promise = new Promise<TFile>((resolve, reject) => {
            this.resolve = (file: TFile) => {
                this.file = file
                resolve(file)
            }
            this.reject = reject
        })
        this.promise.catch(() => { })
    }
}

/** Custom GraphQL scalar type for handling file uploads. */
export const GraphQLUpload = new GraphQLScalarType<Promise<File>, never>({
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
async function collectResponse(response: ServerExecuteOperationResponse): Promise<unknown> {
    if (response.body.kind === 'single') {
        return response.body.singleResult
    }
    if (response.body.kind === 'incremental') {
        const { initialResult, subsequentResults } = response.body as unknown as IncrementalResponseBody
        const collected = []
        for await (const result of subsequentResults) {
            collected.push(result)
        }
        return { initialResult, subsequentResults: collected }
    }
    return { errors: [{ message: 'Unexpected server response format' }] }
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
 * and returns buffered file metadata with replayable stream access.
 */
export async function processUpload(
    file: FormDataFile,
    allowedTypes?: string[]
): Promise<File> {
    if (!file.name || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) {
        throw new Error('Invalid file properties: name or size is missing or invalid.')
    }

    const blob = file as unknown as Blob

    // Only read the first 4100 bytes for MIME type detection via magic bytes.
    // The runtime has already received the body; detection adds only a bounded prefix copy.
    const DETECTION_BYTES = 4100
    const headerBuffer = Buffer.from(await blob.slice(0, DETECTION_BYTES).arrayBuffer())
    const mimetype = await detectMimeType(headerBuffer, allowedTypes)

    return {
        createReadStream: () => Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]),
        encoding: 'binary',
        fileSize: file.size,
        filename: file.name,
        mimetype,
    }
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

/** Checks whether a value is a plain object record suitable for GraphQL variables. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates the minimal GraphQL operation shape required for execution. */
function validateOperation(operation: unknown, label: string): string | null {
    if (!isObjectRecord(operation)) {
        return `Invalid ${label}: expected an operation object.`
    }
    if (typeof operation.query !== 'string') {
        return `Invalid ${label}: expected query to be a string.`
    }
    if (operation.variables !== undefined && !isObjectRecord(operation.variables)) {
        return `Invalid ${label}: expected variables to be an object when provided.`
    }
    if (operation.operationName !== undefined && typeof operation.operationName !== 'string') {
        return `Invalid ${label}: expected operationName to be a string when provided.`
    }
    return null
}

/** Validates upload process settings before request body processing starts. */
function validateSettings(settings?: UploadProcessSettings): string | null {
    if (settings?.maxFileSize !== undefined && (
        typeof settings.maxFileSize !== 'number' ||
        !Number.isFinite(settings.maxFileSize) ||
        settings.maxFileSize < 0
    )) {
        return 'Invalid maxFileSize setting: expected a finite non-negative number.'
    }

    if (settings?.maxFiles !== undefined && (
        typeof settings.maxFiles !== 'number' ||
        !Number.isSafeInteger(settings.maxFiles) ||
        settings.maxFiles < 0
    )) {
        return 'Invalid maxFiles setting: expected a non-negative safe integer.'
    }

    if (settings?.allowedTypes !== undefined && (!Array.isArray(settings.allowedTypes) ||
        settings.allowedTypes.some(type => typeof type !== 'string' || !type.trim()))) {
        return 'Invalid allowedTypes setting: expected an array of non-empty MIME types.'
    }

    return null
}

/** Sets a value at a dot-notation path in a nested object, creating intermediate containers as needed. */
export function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.')
    let current: Record<string, unknown> = obj

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]

        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            throw new Error(`Invalid path segment: '${key}' is not allowed.`)
        }

        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1])

        if (
            !Object.hasOwn(current, key) ||
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
    if (finalKey === '__proto__' || finalKey === 'constructor' || finalKey === 'prototype') {
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
            if (!p) {
                return `Invalid path in map entry '${key}': path cannot be empty.`
            }
            const segments = p.split('.')
            for (const segment of segments) {
                if (!segment) {
                    return `Invalid path in map entry '${key}': path cannot contain empty segments.`
                }
                if (BLOCKED_KEYS.has(segment)) {
                    return `Invalid path segment in map entry '${key}': '${segment}' is not allowed.`
                }
            }
        }
    }
    return null
}


/** Identifies a bounded file prefix without trusting its name or declared content type. */
export async function detectMimeType(headerBuffer: Buffer, allowedTypes?: string[]): Promise<string> {
    const fileTypeInfo = await fileTypeFromBuffer(
        new Uint8Array(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength)
    )

    let mimetype = DEFAULT_MIME_TYPE
    if (fileTypeInfo) {
        mimetype = fileTypeInfo.mime
    } else {
        try {
            if (await isText(null, headerBuffer)) {
                mimetype = 'text/plain'
            }
        } catch {
            // Fallback: isText detection failed, keeping the unknown binary default.
        }
    }

    if (allowedTypes && !allowedTypes.includes(mimetype)) {
        throw new Error(`File type ${mimetype} is not allowed. Allowed types: ${allowedTypes.join(', ')}`)
    }

    return mimetype
}

/** Distinguishes safe protocol errors from unexpected server exceptions. */
export class UploadRequestError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message)
    }
}

export interface UploadServer<TContext> {
    executeOperation: (
        params: ServerExecuteOperationParams,
        context: { contextValue: TContext }
    ) => Promise<ServerExecuteOperationResponse>
}

/** Checks configuration and the preflight boundary before consuming request bytes. */
export function checkUploadRequest(headers: MinimalRequest['headers'], settings?: UploadProcessSettings): void {
    if (!headers.get('apollo-require-preflight')?.trim() && !headers.get('x-apollo-operation-name')?.trim()) {
        throw new UploadRequestError('Upload requests require an Apollo-Require-Preflight header.')
    }
    const error = validateSettings(settings)
    if (error) throw new UploadRequestError(error)
}

/** Validates every target before replacing nulls; assignment preserves existing container shapes. */
export function prepareOperations<TFile = File>(operationsRaw: string, mapRaw: string, maxFiles?: number) {
    let parsed: Record<string, unknown> | Record<string, unknown>[]
    let map: Record<string, string[]>
    try {
        parsed = parseOperationsJSON(operationsRaw)
        map = sanitizeAndValidateJSON(mapRaw) as Record<string, string[]>
    } catch (error) {
        throw new UploadRequestError((error as Error).message)
    }
    const mapError = validateMap(map)
    if (mapError) throw new UploadRequestError(mapError)
    const batch = Array.isArray(parsed)
    const operations = Array.isArray(parsed) ? parsed : [parsed]
    if (!operations.length) throw new UploadRequestError('Operations batch cannot be empty.')
    for (const [index, operation] of operations.entries()) {
        const error = validateOperation(operation, batch ? `operation at index ${index}` : 'operation')
        if (error) throw new UploadRequestError(error)
    }
    if (maxFiles !== undefined && Object.keys(map).length > maxFiles) {
        throw new UploadRequestError(`${maxFiles} max file uploads exceeded.`, 413)
    }

    const uploads = new Map<string, Upload<TFile>>()
    const locations: { parent: Record<string, unknown>; key: string; upload: Upload<TFile> }[] = []
    const owners = new Map<string, string>()
    for (const [field, paths] of Object.entries(map)) {
        const upload = new Upload<TFile>()
        uploads.set(field, upload)
        for (const path of paths) {
            const keys = path.split('.')
            const offset = batch ? 1 : 0
            if ((batch && (!/^(0|[1-9]\d*)$/.test(keys[0]) || Number(keys[0]) >= operations.length)) ||
                keys[offset] !== 'variables' || keys.length <= offset + 1) {
                throw new UploadRequestError('File paths must target operation variables.')
            }
            if (owners.has(path) && owners.get(path) !== field) {
                throw new UploadRequestError('Multiple files cannot target the same placeholder.')
            }
            owners.set(path, field)
            let parent: unknown = parsed
            for (const key of keys.slice(0, -1)) {
                if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) {
                    throw new UploadRequestError('File paths must reference existing null placeholders.')
                }
                parent = (parent as Record<string, unknown>)[key]
            }
            const key = keys[keys.length - 1]
            if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key) ||
                (parent as Record<string, unknown>)[key] !== null) {
                throw new UploadRequestError('File paths must reference existing null placeholders.')
            }
            locations.push({ parent: parent as Record<string, unknown>, key, upload })
        }
    }
    for (const { parent, key, upload } of locations) parent[key] = upload
    return { operations: parsed as unknown as Operation | Operation[], uploads }
}

/** Preserves operation order, context, and the existing response envelope in both APIs. */
export async function executeOperations<TContext>(operations: Operation | Operation[], context: TContext, server: UploadServer<TContext>): Promise<NextResponse> {
    const results = []
    for (const op of Array.isArray(operations) ? operations : [operations]) {
        const response = await server.executeOperation({
            query: op.query, variables: op.variables || {},
            ...(op.operationName !== undefined && { operationName: op.operationName }),
        }, { contextValue: context })
        results.push(await collectResponse(response))
    }
    return NextResponse.json(Array.isArray(operations) ? results : results[0])
}

/** Only intentional request errors may expose their details to an untrusted client. */
export function uploadErrorResponse(error: unknown): NextResponse {
    return NextResponse.json({ errors: [{ message: error instanceof UploadRequestError
        ? error.message : 'Unexpected error during upload processing.' }] }, {
        status: error instanceof UploadRequestError ? error.status : 500,
    })
}
