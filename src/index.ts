import { GraphQLScalarType, GraphQLError } from 'graphql'
import { type NextRequest, NextResponse } from 'next/server.js'
import type { GraphQLResponse } from '@apollo/server'
import { fileTypeFromBuffer } from 'file-type'
import { isText } from 'istextorbinary'

export interface File {
    createReadStream: () => NodeJS.ReadableStream
    encoding: string
    fileName: string
    fileSize: number
    mimeType: string
}

export interface FileStream extends FormDataFile {
    stream: () => Promise<NodeJS.ReadableStream>
}

export interface FormDataFile {
    lastModified: number
    name: string
    size: number
    type: string
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

export const GraphQLUpload = new GraphQLScalarType({
    description: 'The Upload scalar type represents a file upload.',
    name: 'Upload',
    parseLiteral(node) { throw new GraphQLError('Upload literal unsupported.', { nodes: node }) },
    parseValue(value) { return value instanceof Upload ? value.promise : new GraphQLError('Upload value invalid.') },
    serialize() { throw new GraphQLError('Upload serialization unsupported.') }
})

async function extractFiles(formData: FormData): Promise<{ [key: string]: FormDataFile }> {
    const files: { [key: string]: FormDataFile } = {}
    for (const [key, value] of Array.from(formData.entries())) {
        if (value instanceof globalThis.File) {
            files[key] = value as FormDataFile;
        }
    }
    return files
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        } else if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk));
        } else {
            chunks.push(Buffer.from(chunk as Uint8Array));
        }
    }
    return Buffer.concat(chunks as unknown as readonly Uint8Array[]);
}

export function bufferToStream(buffer: Buffer): NodeJS.ReadableStream {
    const { Readable } = require('stream')
    const stream = new Readable()
    stream.push(buffer)
    stream.push(null)
    return stream
}

export function sanitizeAndValidateJSON(input: string): unknown {
    try {
        const result = JSON.parse(input)
        if (typeof result !== 'object' || result === null) {
            throw new Error('Invalid JSON structure: not an object.')
        }
        return result
    } catch (error) {
        throw new Error(`Invalid JSON input: ${(error as Error).message}`)
    }
}

function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.');
    let current: any = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1]);

        if (!current[key] || typeof current[key] !== (nextKeyIsArrayIndex ? 'object' : 'object')) {
            if (current[key] && ( (nextKeyIsArrayIndex && !Array.isArray(current[key])) || (!nextKeyIsArrayIndex && Array.isArray(current[key])) ) ) {
                // Path conflict, overwriting.
            }
            current[key] = nextKeyIsArrayIndex ? [] : {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}

async function processUpload(
    file: FormDataFile,
    allowedTypes: string[]
): Promise<Upload> {
    if (!file.name || typeof file.size !== 'number' || !file.type) {
        throw new Error('Invalid file properties: name, size, or type is missing or invalid.')
    }

    const stream = await (file as FileStream).stream()
    const buffer = await streamToBuffer(stream)
    
    const uint8ArrayForFileType = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const fileTypeInfo = await fileTypeFromBuffer(uint8ArrayForFileType);

    let mimeType = file.type;
    if (fileTypeInfo) {
        mimeType = fileTypeInfo.mime;
    } else {
        try {
            const isTextResult = await isText(file.name, buffer);
            if (isTextResult === true) {
                mimeType = 'text/plain';
            }
        } catch (err) {
            // isText check failed, proceed with original mimeType
        }
    }

    if (!allowedTypes.includes(mimeType)) {
        throw new Error(`File type ${mimeType} is not allowed. Allowed types: ${allowedTypes.join(', ')}`)
    }

    const upload = new Upload()
    upload.resolve({
        fileSize: file.size,
        fileName: file.name,
        mimeType: mimeType,
        encoding: 'binary',
        createReadStream: () => bufferToStream(buffer)
    })
    return upload;
}

interface ServerExecuteOperationParams {
    query: string;
    variables: Record<string, unknown>;
}

/**
 * Processes a GraphQL multipart request with file uploads.
 */
export async function uploadProcess<TContext extends Record<string, unknown>>(
    request: NextRequest,
    contextValueInput: TContext,
    server: {
        executeOperation: (
            params: ServerExecuteOperationParams,
            context: { contextValue: TContext }
        ) => Promise<GraphQLResponse<TContext>>
    },
    settings: { allowedTypes: string[], maxFileSize: number }
): Promise<NextResponse<any>> {
    try {
        const formData: FormData = await request.formData()
        const files = await extractFiles(formData)

        const mapString = formData.get('map') as string;
        const operationsString = formData.get('operations') as string;

        if (!mapString || !operationsString) {
            throw new Error('Missing map or operations in form data.');
        }
        const map = sanitizeAndValidateJSON(mapString) as Record<string, string[]>;
        const operations = sanitizeAndValidateJSON(operationsString) as { query: string; variables: Record<string, unknown | null> };

        const fileProcessingPromises: Promise<void>[] = [];

        if (!operations.variables) {
            operations.variables = {};
        }

        for (const fileKeyInMap of Object.keys(map)) {
            const file = files[fileKeyInMap];
            if (!file) {
                map[fileKeyInMap].forEach(path => {
                     setValueAtPath(operations, path, null);
                });
                continue;
            }

            if (file.size > settings.maxFileSize) {
                return NextResponse.json({ errors: [{ message: `File ${file.name} size is too large. Maximum allowed size is ${settings.maxFileSize / (1024 * 1024)}MB.` }] }, { status: 413 });
            }

            const variablePaths = map[fileKeyInMap];

            const filePromise = processUpload(file, settings.allowedTypes)
                .then(uploadInstance => {
                    variablePaths.forEach(path => {
                        setValueAtPath(operations, path, uploadInstance);
                    });
                })
                .catch(error => {
                    variablePaths.forEach(path => {
                         const uploadError = new Upload();
                         uploadError.reject(new Error(`Failed to process file ${file.name}: ${(error as Error).message}`));
                         setValueAtPath(operations, path, uploadError);
                    });
                    throw new Error(`Failed to process file ${file.name}: ${(error as Error).message}`);
                });

            fileProcessingPromises.push(filePromise);
        }

        try {
            await Promise.all(fileProcessingPromises);
        } catch (processingError) {
            // Individual file processing errors are handled by rejecting Upload.promise.
        }

        const response = await server.executeOperation(
            { query: operations.query, variables: operations.variables },
            { contextValue: contextValueInput }
        )

        if (response.body.kind === 'single') {
            return NextResponse.json(response.body.singleResult);
        } else if (response.body.kind === 'incremental') {
            const { initialResult, subsequentResults } = response.body;
            const collectedSubsequentResults = [];
            for await (const result of subsequentResults) {
                collectedSubsequentResults.push(result);
            }
            return NextResponse.json({
                initialResult,
                subsequentResults: collectedSubsequentResults,
            });
        }
        return NextResponse.json({ errors: [{ message: 'Unexpected server response format' }] }, { status: 500 });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during upload processing.'
        return NextResponse.json({ errors: [{ message: `Error processing upload: ${errorMessage}` }] }, { status: 500 });
    }
}