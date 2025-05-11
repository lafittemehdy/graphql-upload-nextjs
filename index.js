import { GraphQLScalarType, GraphQLError } from 'graphql';
import { NextResponse } from 'next/server.js';
import { fileTypeFromBuffer } from 'file-type';
import { isText } from 'istextorbinary';
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
/**
 * Extract files from form data.
 * @param formData - The form data containing file entries.
 * @returns An object mapping file keys to FormDataFile objects.
 */
async function extractFiles(formData) {
    const files = {};
    // Convert iterator to array to satisfy TypeScript's iteration rules for older targets
    for (const [key, value] of Array.from(formData.entries())) {
        if (value instanceof File) { // Check if it's a File object (from browser FormData)
            files[key] = value; // Cast to our FormDataFile interface
        }
    }
    return files;
}
/**
 * Stream to buffer utility function.
 * @param stream - The readable stream.
 * @returns A promise that resolves to a buffer.
 */
export async function streamToBuffer(stream) {
    const chunks = []; // Store as Buffer objects
    for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        }
        else if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk)); // Convert string chunks to Buffer
        }
        else {
            // Handle or ignore other chunk types if necessary
            // For now, we assume string or Buffer as common stream chunk types
            chunks.push(Buffer.from(chunk)); // Attempt conversion for other types
        }
    }
    // I can’t sleep at night when I think about this line 👀
    return Buffer.concat(chunks);
}
/**
 * Buffer to stream utility function.
 * @param buffer - The buffer.
 * @returns A readable stream.
 */
export function bufferToStream(buffer) {
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
/**
 * Sanitize and validate JSON input.
 * @param input - The JSON string to sanitize and validate.
 * @returns The parsed JSON object.
 */
export function sanitizeAndValidateJSON(input) {
    try {
        const result = JSON.parse(input);
        if (typeof result !== 'object' || result === null) {
            throw new Error('Invalid JSON structure');
        }
        return result;
    }
    catch (error) {
        console.error('Error parsing JSON:', error);
        throw new Error('Invalid JSON input');
    }
}
/**
 * Sets a value at a deep path within an object.
 * Creates intermediate objects/arrays if they don't exist.
 * @param obj - The object to modify.
 * @param path - The path string (e.g., "variables.files.0").
 * @param value - The value to set.
 */
function setValueAtPath(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const nextKeyIsArrayIndex = /^\d+$/.test(keys[i + 1]); // Check if next key is a number (array index)
        if (!current[key]) {
            current[key] = nextKeyIsArrayIndex ? [] : {};
        }
        else if (nextKeyIsArrayIndex && !Array.isArray(current[key])) {
            // If we expect an array but found an object, this is a path conflict.
            // Or if we expect an object but found an array.
            // For simplicity, we'll overwrite, but a real app might error here.
            console.warn(`Path conflict at ${key}: expected ${nextKeyIsArrayIndex ? "array" : "object"}, found ${typeof current[key]}. Overwriting.`);
            current[key] = nextKeyIsArrayIndex ? [] : {};
        }
        else if (!nextKeyIsArrayIndex && typeof current[key] !== 'object') {
            console.warn(`Path conflict at ${key}: expected object, found ${typeof current[key]}. Overwriting.`);
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}
/**
 * Process an individual file upload.
 * @param file - The file to be uploaded.
 * @param allowedTypes - The list of allowed MIME types.
 * @returns A Promise that resolves to an Upload instance.
 */
async function processUpload(file, allowedTypes) {
    // Validate file properties
    if (!file.name || !file.size || !file.type) {
        throw new Error('Invalid file properties');
    }
    const stream = await file.stream();
    const buffer = await streamToBuffer(stream);
    // Node.js Buffer is a Uint8Array, fileTypeFromBuffer should accept it.
    // If type errors persist here, it might be due to conflicting @types versions or specific library nuances.
    // Convert Node.js Buffer to a Uint8Array view on its underlying ArrayBuffer
    // This is often needed to satisfy strict typings of libraries expecting a generic Uint8Array.
    const uint8ArrayForFileType = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const fileType = await fileTypeFromBuffer(uint8ArrayForFileType);
    // Determine the MIME type
    let mimeType = file.type;
    if (fileType) {
        mimeType = fileType.mime;
    }
    else {
        // Use the Promise-based version of isText
        try {
            const isTextResult = await isText(file.name, buffer);
            // isText returns boolean | null. Treat null as not text.
            if (isTextResult === true) {
                mimeType = 'text/plain';
            }
        }
        catch (err) {
            // Log the error but proceed, as mimeType might still be file.type
            console.warn(`[processUpload] isText check failed for ${file.name}:`, err);
        }
    }
    // Check if the file's MIME type is allowed
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
// The server.executeOperation returns a Promise<GraphQLResponse<TContext>>
// GraphQLResponse is a discriminated union from @apollo/server
export async function uploadProcess(request, contextValueInput, server, settings) {
    try {
        // Extract form data from the request
        const formData = await request.formData();
        const files = await extractFiles(formData);
        // Parse and validate the map and operations from the form data
        const mapString = formData.get('map');
        const operationsString = formData.get('operations');
        if (!mapString || !operationsString) {
            console.error('[uploadProcess] Missing map or operations in form data.');
            throw new Error('Missing map or operations in form data.');
        }
        const map = sanitizeAndValidateJSON(mapString);
        const operations = sanitizeAndValidateJSON(operationsString);
        console.log('[uploadProcess] Parsed map:', JSON.stringify(map, null, 2));
        console.log('[uploadProcess] Keys of extracted files from FormData:', Object.keys(files));
        console.log('[uploadProcess] Initial operations.variables:', JSON.stringify(operations.variables, null, 2));
        const fileProcessingPromises = [];
        // Initialize operations.variables if it doesn't exist (it should from sanitizeAndValidateJSON if ops string was valid)
        if (!operations.variables) {
            operations.variables = {};
        }
        for (const fileKeyInMap of Object.keys(map)) {
            const file = files[fileKeyInMap];
            if (!file) {
                console.warn(`[uploadProcess] File with key "${fileKeyInMap}" (from map) not found in extracted FormData files. Path(s) in map: ${map[fileKeyInMap].join(', ')}`);
                // If a file in the map isn't found, the corresponding operations.variables path will remain as `null` (or its original value).
                // This will likely cause the "Expected non-nullable type Upload! not to be null" error downstream for that specific path.
                continue;
            }
            if (file.size > settings.maxFileSize) {
                return NextResponse.json({ error: `File ${file.name} size is too large. Maximum allowed size is ${settings.maxFileSize / (1024 * 1024)}MB.` });
            }
            const variablePaths = map[fileKeyInMap]; // e.g., ["variables.files.0"]
            const filePromise = processUpload(file, settings.allowedTypes)
                .then(uploadInstance => {
                console.log(`[uploadProcess] Processed file for map key "${fileKeyInMap}", got Upload instance: ${!!uploadInstance}`);
                variablePaths.forEach(path => {
                    console.log(`[uploadProcess] Setting path "${path}" to Upload instance for map key "${fileKeyInMap}"`);
                    setValueAtPath(operations, path, uploadInstance); // Pass 'operations' object itself
                });
            })
                .catch(error => {
                console.error(`[uploadProcess] Error processing file ${file.name} for map key ${fileKeyInMap}:`, error);
                throw new Error(`Failed to process file ${file.name}: ${error.message}`); // Propagate to fail Promise.all
            });
            fileProcessingPromises.push(filePromise);
        }
        await Promise.all(fileProcessingPromises);
        console.log('[uploadProcess] operations.variables AFTER processing and BEFORE executeOperation:', JSON.stringify(operations.variables, (key, value) => {
            if (value instanceof Upload) {
                return `[Upload Instance - resolved file: ${!!value.file}]`;
            }
            if (value && typeof value.then === 'function') {
                return '[Promise]'; // Don't try to stringify promises directly
            }
            return value;
        }, 2));
        // The section to remove unset variables might be problematic if a legitimate variable was meant to be null
        // and wasn't an upload. For now, let's comment it out to simplify debugging the upload part.
        // for (const key in operations.variables) {
        //     if (!operations.variables[key]) {
        //         // This could remove a legitimate null if files[0] was null and not replaced
        //         console.log(`[uploadProcess] Removing unset variable: ${key}`);
        //         delete operations.variables[key];
        //     }
        // }
        // Execute the GraphQL operation
        const response = await server.executeOperation({ query: operations.query, variables: operations.variables }, // Pass the modified operations.variables
        { contextValue: contextValueInput });
        // Return the appropriate response based on the result kind
        // The 'response' is now of type GraphQLResponse from @apollo/server
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
        // Fallback for unexpected response body kind
        console.error('[uploadProcess] Unexpected response body kind:', response.body?.kind);
        return NextResponse.json({ error: 'Unexpected server response format' }, { status: 500 });
    }
    catch (error) {
        console.error('Error processing upload:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: `Error processing upload: ${errorMessage}` });
    }
}
