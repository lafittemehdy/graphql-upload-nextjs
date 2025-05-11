import { GraphQLScalarType, GraphQLError } from 'graphql';
import { NextResponse } from 'next/server.js';
import { fileTypeFromBuffer } from 'file-type';
import { isText } from 'istextorbinary';
/**
 * Represents an instance of a file upload.
 * Holds a promise that resolves with the file details once processed.
 */
export class Upload {
    file;
    promise;
    reject = () => { };
    resolve = () => { };
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = (file) => {
                this.file = file;
                resolve(file);
            };
            this.reject = reject;
        });
        this.promise.catch(() => { });
    }
}
export const GraphQLUpload = new GraphQLScalarType({
    description: 'The Upload scalar type represents a file upload.',
    name: 'Upload',
    parseLiteral(node) { throw new GraphQLError('Upload literal unsupported.', { nodes: node }); },
    parseValue(value) { return value instanceof Upload ? value.promise : new GraphQLError('Upload value invalid.'); },
    serialize() { throw new GraphQLError('Upload serialization unsupported.'); }
});
async function extractFiles(formData) {
    const files = {};
    for (const [key, value] of Array.from(formData.entries())) {
        if (value instanceof globalThis.File) {
            files[key] = value;
        }
    }
    return files;
}
export async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        }
        else if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk));
        }
        else {
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}
export function bufferToStream(buffer) {
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
export function sanitizeAndValidateJSON(input) {
    try {
        const result = JSON.parse(input);
        if (typeof result !== 'object' || result === null) {
            throw new Error('Invalid JSON structure: not an object.');
        }
        return result;
    }
    catch (error) {
        throw new Error(`Invalid JSON input: ${error.message}`);
    }
}
function setValueAtPath(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1]);
        if (!current[key] || typeof current[key] !== (nextKeyIsArrayIndex ? 'object' : 'object')) {
            if (current[key] && ((nextKeyIsArrayIndex && !Array.isArray(current[key])) || (!nextKeyIsArrayIndex && Array.isArray(current[key])))) {
                // Path conflict, overwriting.
            }
            current[key] = nextKeyIsArrayIndex ? [] : {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}
async function processUpload(file, allowedTypes) {
    if (!file.name || typeof file.size !== 'number' || !file.type) {
        throw new Error('Invalid file properties: name, size, or type is missing or invalid.');
    }
    const stream = await file.stream();
    const buffer = await streamToBuffer(stream);
    const uint8ArrayForFileType = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const fileTypeInfo = await fileTypeFromBuffer(uint8ArrayForFileType);
    let mimeType = file.type;
    if (fileTypeInfo) {
        mimeType = fileTypeInfo.mime;
    }
    else {
        try {
            const isTextResult = await isText(file.name, buffer);
            if (isTextResult === true) {
                mimeType = 'text/plain';
            }
        }
        catch (err) {
            // isText check failed, proceed with original mimeType
        }
    }
    if (!allowedTypes.includes(mimeType)) {
        throw new Error(`File type ${mimeType} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
    }
    const upload = new Upload();
    upload.resolve({
        fileSize: file.size,
        fileName: file.name,
        mimeType: mimeType,
        encoding: 'binary',
        createReadStream: () => bufferToStream(buffer)
    });
    return upload;
}
/**
 * Processes a GraphQL multipart request with file uploads.
 */
export async function uploadProcess(request, contextValueInput, server, settings) {
    try {
        const formData = await request.formData();
        const files = await extractFiles(formData);
        const mapString = formData.get('map');
        const operationsString = formData.get('operations');
        if (!mapString || !operationsString) {
            throw new Error('Missing map or operations in form data.');
        }
        const map = sanitizeAndValidateJSON(mapString);
        const operations = sanitizeAndValidateJSON(operationsString);
        const fileProcessingPromises = [];
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
                    uploadError.reject(new Error(`Failed to process file ${file.name}: ${error.message}`));
                    setValueAtPath(operations, path, uploadError);
                });
                throw new Error(`Failed to process file ${file.name}: ${error.message}`);
            });
            fileProcessingPromises.push(filePromise);
        }
        try {
            await Promise.all(fileProcessingPromises);
        }
        catch (processingError) {
            // Individual file processing errors are handled by rejecting Upload.promise.
        }
        const response = await server.executeOperation({ query: operations.query, variables: operations.variables }, { contextValue: contextValueInput });
        if (response.body.kind === 'single') {
            return NextResponse.json(response.body.singleResult);
        }
        else if (response.body.kind === 'incremental') {
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
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during upload processing.';
        return NextResponse.json({ errors: [{ message: `Error processing upload: ${errorMessage}` }] }, { status: 500 });
    }
}
