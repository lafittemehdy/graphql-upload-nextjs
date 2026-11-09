/** Preserves the buffered upload API and exports the optional streaming integration. */
import type { NextResponse } from 'next/server.js';
import { type MinimalRequest, type UploadServer } from './core.js';
export { type File, type FileStream, type FormDataFile, type MinimalRequest, GraphQLUpload, Upload, bufferToStream, parseOperationsJSON, sanitizeAndValidateJSON, setValueAtPath, streamToBuffer, validateMap, } from './core.js';
export { type StreamingFile, type StreamingRequest, type StreamingUploadSettings, uploadProcessStreaming } from './streaming.js';
/** Fully receives files before executing GraphQL; existing callers retain numeric file sizes. */
export declare function uploadProcess<TContext extends Record<string, unknown>>(request: MinimalRequest, contextValueInput: TContext, server: UploadServer<TContext>, settings?: {
    allowedTypes?: string[];
    maxFileSize?: number;
    maxFiles?: number;
}): Promise<NextResponse>;
