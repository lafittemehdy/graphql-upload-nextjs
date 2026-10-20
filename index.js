import { fileTypeFromBuffer } from 'file-type';
import { GraphQLError, GraphQLScalarType } from 'graphql';
import { isText } from 'istextorbinary';
import { NextResponse } from 'next/server.js';
import { Readable } from 'stream';
const DEFAULT_MIME_TYPE = 'application/octet-stream';
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
/** Custom GraphQL scalar type for handling file uploads. */
export const GraphQLUpload = new GraphQLScalarType({
    description: 'The Upload scalar type represents a file upload.',
    name: 'Upload',
    parseLiteral(node) {
        throw new GraphQLError('Upload literal unsupported.', { nodes: node });
    },
    parseValue(value) {
        if (value instanceof Upload)
            return value.promise;
        throw new GraphQLError('Upload value invalid.');
    },
    serialize() {
        throw new GraphQLError('Upload serialization unsupported.');
    },
});
/** Converts a Buffer into a Node.js readable stream. */
export function bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
/** Collects a GraphQL response into a serializable result object. */
async function collectResponse(response) {
    if (response.body.kind === 'single') {
        return response.body.singleResult;
    }
    if (response.body.kind === 'incremental') {
        const { initialResult, subsequentResults } = response.body;
        const collected = [];
        for await (const result of subsequentResults) {
            collected.push(result);
        }
        return { initialResult, subsequentResults: collected };
    }
    return { errors: [{ message: 'Unexpected server response format' }] };
}
/** Extracts File entries from multipart FormData. */
async function extractFiles(formData) {
    const files = Object.create(null);
    for (const [key, value] of formData.entries()) {
        if (value instanceof globalThis.File) {
            files[key] = value;
        }
    }
    return files;
}
/** Parses JSON for the operations field. Accepts objects or arrays (for batching per spec). */
export function parseOperationsJSON(input) {
    let result;
    try {
        result = JSON.parse(input);
    }
    catch {
        throw new Error('Invalid JSON in the operations multipart field.');
    }
    if (typeof result !== 'object' || result === null) {
        throw new Error('Invalid type for the operations multipart field.');
    }
    return result;
}
/**
 * Processes a file from FormData, detects its MIME type via magic bytes,
 * and returns a resolved Upload instance with streaming file access.
 */
async function processUpload(file, allowedTypes) {
    if (!file.name || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) {
        throw new Error('Invalid file properties: name or size is missing or invalid.');
    }
    const blob = file;
    // Only read the first 4100 bytes for MIME type detection via magic bytes.
    // This avoids buffering the entire file into memory.
    const DETECTION_BYTES = 4100;
    const headerBuffer = Buffer.from(await blob.slice(0, DETECTION_BYTES).arrayBuffer());
    const fileTypeInfo = await fileTypeFromBuffer(new Uint8Array(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength));
    let mimetype = DEFAULT_MIME_TYPE;
    if (fileTypeInfo) {
        mimetype = fileTypeInfo.mime;
    }
    else {
        try {
            if (await isText(null, headerBuffer)) {
                mimetype = 'text/plain';
            }
        }
        catch {
            // Fallback: isText detection failed, keeping the unknown binary default.
        }
    }
    if (allowedTypes && !allowedTypes.includes(mimetype)) {
        throw new Error(`File type ${mimetype} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
    }
    const upload = new Upload();
    upload.resolve({
        createReadStream: () => Readable.fromWeb(blob.stream()),
        encoding: 'binary',
        fileSize: file.size,
        filename: file.name,
        mimetype,
    });
    return upload;
}
/** Parses and validates a JSON string, ensuring it resolves to a non-null object (rejects arrays). */
export function sanitizeAndValidateJSON(input) {
    let result;
    try {
        result = JSON.parse(input);
    }
    catch (error) {
        throw new Error(`Invalid JSON input: ${error.message}`);
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Invalid JSON structure: expected a non-null object.');
    }
    return result;
}
/** Dangerous property names that could lead to prototype pollution. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Checks whether a value is a plain object record suitable for GraphQL variables. */
function isObjectRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Validates the minimal GraphQL operation shape required for execution. */
function validateOperation(operation, label) {
    if (!isObjectRecord(operation)) {
        return `Invalid ${label}: expected an operation object.`;
    }
    if (typeof operation.query !== 'string') {
        return `Invalid ${label}: expected query to be a string.`;
    }
    if (operation.variables !== undefined && !isObjectRecord(operation.variables)) {
        return `Invalid ${label}: expected variables to be an object when provided.`;
    }
    if (operation.operationName !== undefined && typeof operation.operationName !== 'string') {
        return `Invalid ${label}: expected operationName to be a string when provided.`;
    }
    return null;
}
/** Validates upload process settings before request body processing starts. */
function validateSettings(settings) {
    if (settings?.maxFileSize !== undefined && (typeof settings.maxFileSize !== 'number' ||
        !Number.isFinite(settings.maxFileSize) ||
        settings.maxFileSize < 0)) {
        return 'Invalid maxFileSize setting: expected a finite non-negative number.';
    }
    if (settings?.maxFiles !== undefined && (typeof settings.maxFiles !== 'number' ||
        !Number.isSafeInteger(settings.maxFiles) ||
        settings.maxFiles < 0)) {
        return 'Invalid maxFiles setting: expected a non-negative safe integer.';
    }
    if (settings?.allowedTypes !== undefined && (!Array.isArray(settings.allowedTypes) ||
        settings.allowedTypes.some(type => typeof type !== 'string' || !type.trim()))) {
        return 'Invalid allowedTypes setting: expected an array of non-empty MIME types.';
    }
    return null;
}
/** Sets a value at a dot-notation path in a nested object, creating intermediate containers as needed. */
export function setValueAtPath(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (BLOCKED_KEYS.has(key)) {
            throw new Error(`Invalid path segment: '${key}' is not allowed.`);
        }
        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1]);
        if (!current[key] ||
            typeof current[key] !== 'object' ||
            (nextKeyIsArrayIndex && !Array.isArray(current[key])) ||
            (!nextKeyIsArrayIndex && Array.isArray(current[key]))) {
            current[key] = nextKeyIsArrayIndex ? [] : {};
        }
        current = current[key];
    }
    const finalKey = keys[keys.length - 1];
    if (BLOCKED_KEYS.has(finalKey)) {
        throw new Error(`Invalid path segment: '${finalKey}' is not allowed.`);
    }
    current[finalKey] = value;
}
/** Converts a Node.js readable stream into a Buffer by collecting all chunks. */
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
/** Validates that each map entry is an array of string paths. */
export function validateMap(map) {
    for (const [key, paths] of Object.entries(map)) {
        if (!Array.isArray(paths)) {
            return `Invalid type for map entry '${key}': expected an array of paths.`;
        }
        for (const p of paths) {
            if (typeof p !== 'string') {
                return `Invalid path in map entry '${key}': expected string.`;
            }
            if (!p) {
                return `Invalid path in map entry '${key}': path cannot be empty.`;
            }
            const segments = p.split('.');
            for (const segment of segments) {
                if (!segment) {
                    return `Invalid path in map entry '${key}': path cannot contain empty segments.`;
                }
                if (BLOCKED_KEYS.has(segment)) {
                    return `Invalid path segment in map entry '${key}': '${segment}' is not allowed.`;
                }
            }
        }
    }
    return null;
}
/** Processes a GraphQL multipart request with file uploads. Supports batching per the spec. */
export async function uploadProcess(request, contextValueInput, server, settings) {
    try {
        // Multipart forms can bypass browser preflight and Apollo's executeOperation skips HTTP CSRF checks.
        if (!request.headers.get('apollo-require-preflight')?.trim() &&
            !request.headers.get('x-apollo-operation-name')?.trim()) {
            return NextResponse.json({ errors: [{ message: 'Upload requests require an Apollo-Require-Preflight header.' }] }, { status: 400 });
        }
        const settingsError = validateSettings(settings);
        if (settingsError) {
            return NextResponse.json({ errors: [{ message: settingsError }] }, { status: 400 });
        }
        const formData = await request.formData();
        const files = await extractFiles(formData);
        const fileCount = Array.from(formData.values()).filter(value => value instanceof globalThis.File).length;
        const mapRaw = formData.get('map');
        const operationsRaw = formData.get('operations');
        if (!mapRaw || !operationsRaw || typeof mapRaw !== 'string' || typeof operationsRaw !== 'string') {
            return NextResponse.json({ errors: [{ message: 'Missing or invalid map/operations in form data.' }] }, { status: 400 });
        }
        const mapString = mapRaw;
        const operationsString = operationsRaw;
        // Parse and validate the map field (must be an object, not array).
        let map;
        try {
            map = sanitizeAndValidateJSON(mapString);
        }
        catch {
            return NextResponse.json({ errors: [{ message: 'Invalid JSON in the map multipart field.' }] }, { status: 400 });
        }
        const mapError = validateMap(map);
        if (mapError) {
            return NextResponse.json({ errors: [{ message: mapError }] }, { status: 400 });
        }
        // Parse the operations field (object or array for batching).
        let parsedOperations;
        try {
            parsedOperations = parseOperationsJSON(operationsString);
        }
        catch {
            return NextResponse.json({ errors: [{ message: 'Invalid JSON in the operations multipart field.' }] }, { status: 400 });
        }
        if (Array.isArray(parsedOperations)) {
            for (let i = 0; i < parsedOperations.length; i++) {
                const operationError = validateOperation(parsedOperations[i], `operation at index ${i}`);
                if (operationError) {
                    return NextResponse.json({ errors: [{ message: operationError }] }, { status: 400 });
                }
            }
        }
        else {
            const operationError = validateOperation(parsedOperations, 'operation');
            if (operationError) {
                return NextResponse.json({ errors: [{ message: operationError }] }, { status: 400 });
            }
        }
        const isBatch = Array.isArray(parsedOperations);
        if (isBatch && parsedOperations.length === 0) {
            return NextResponse.json({ errors: [{ message: 'Operations batch cannot be empty.' }] }, { status: 400 });
        }
        for (const paths of Object.values(map)) {
            for (const filePath of paths) {
                const segments = filePath.split('.');
                const offset = isBatch ? 1 : 0;
                if ((isBatch && (!/^(0|[1-9]\d*)$/.test(segments[0]) ||
                    Number(segments[0]) >= parsedOperations.length)) ||
                    segments[offset] !== 'variables' || segments.length <= offset + 1) {
                    return NextResponse.json({ errors: [{ message: 'File paths must target operation variables.' }] }, { status: 400 });
                }
                let target = parsedOperations;
                for (const segment of segments) {
                    if (target === null || typeof target !== 'object' || !Object.hasOwn(target, segment)) {
                        return NextResponse.json({ errors: [{ message: 'File paths must reference existing null placeholders.' }] }, { status: 400 });
                    }
                    target = target[segment];
                }
                if (target !== null) {
                    return NextResponse.json({ errors: [{ message: 'File paths must reference existing null placeholders.' }] }, { status: 400 });
                }
            }
        }
        // Include unmapped files in the request limit.
        if (settings?.maxFiles !== undefined && Math.max(Object.keys(map).length, fileCount) > settings.maxFiles) {
            return NextResponse.json({ errors: [{ message: `${settings.maxFiles} max file uploads exceeded.` }] }, { status: 413 });
        }
        // Normalize operations into a keyed object for path resolution.
        // Single: paths are "variables.file" → use the operation object directly.
        // Batch: paths are "0.variables.file" → use indices as keys in a wrapper object.
        let operationsRoot;
        if (isBatch) {
            const batchOperations = parsedOperations;
            operationsRoot = {};
            for (let i = 0; i < batchOperations.length; i++) {
                const op = batchOperations[i];
                if (!op.variables)
                    op.variables = {};
                operationsRoot[String(i)] = op;
            }
        }
        else {
            const singleOp = parsedOperations;
            if (!singleOp.variables)
                singleOp.variables = {};
            operationsRoot = singleOp;
        }
        // Process files and resolve Upload instances at mapped paths.
        const fileProcessingPromises = [];
        for (const fileKeyInMap of Object.keys(map)) {
            const file = files[fileKeyInMap];
            if (!file) {
                // Per spec: reject Upload promise when file is missing from the request.
                for (const filePath of map[fileKeyInMap]) {
                    const missingUpload = new Upload();
                    missingUpload.reject(new Error('File missing in the request.'));
                    setValueAtPath(operationsRoot, filePath, missingUpload);
                }
                continue;
            }
            if (settings?.maxFileSize !== undefined && file.size > settings.maxFileSize) {
                return NextResponse.json({ errors: [{ message: `File ${file.name} size is too large. Maximum allowed size is ${(settings.maxFileSize / (1024 * 1024)).toFixed(2)}MB.` }] }, { status: 413 });
            }
            const variablePaths = map[fileKeyInMap];
            const filePromise = processUpload(file, settings?.allowedTypes)
                .then(uploadInstance => {
                for (const filePath of variablePaths) {
                    setValueAtPath(operationsRoot, filePath, uploadInstance);
                }
            })
                .catch((error) => {
                for (const filePath of variablePaths) {
                    const uploadError = new Upload();
                    uploadError.reject(new Error(`Failed to process file ${file.name}: ${error.message}`));
                    setValueAtPath(operationsRoot, filePath, uploadError);
                }
            });
            fileProcessingPromises.push(filePromise);
        }
        await Promise.all(fileProcessingPromises);
        // Execute operations and collect results.
        if (isBatch) {
            const results = [];
            const sortedKeys = Object.keys(operationsRoot).sort((a, b) => Number(a) - Number(b));
            for (const key of sortedKeys) {
                const op = operationsRoot[key];
                const response = await server.executeOperation({ query: op.query, variables: op.variables || {}, ...(op.operationName !== undefined && { operationName: op.operationName }) }, { contextValue: contextValueInput });
                results.push(await collectResponse(response));
            }
            return NextResponse.json(results);
        }
        const operation = operationsRoot;
        const response = await server.executeOperation({ query: operation.query, variables: operation.variables || {}, ...(operation.operationName !== undefined && { operationName: operation.operationName }) }, { contextValue: contextValueInput });
        return NextResponse.json(await collectResponse(response));
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during upload processing.';
        return NextResponse.json({ errors: [{ message: `Error processing upload: ${errorMessage}` }] }, { status: 500 });
    }
}
