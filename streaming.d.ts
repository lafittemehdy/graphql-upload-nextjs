import type { NextResponse } from 'next/server.js';
import { Readable } from 'node:stream';
import { type File, type MinimalRequest, type UploadProcessSettings, type UploadServer } from './core.js';
/** Streaming metadata deliberately has a different size contract from the buffered File. */
export interface StreamingFile extends Omit<File, 'fileSize' | 'createReadStream'> {
    /** Resolves after this file has been completely received and written to temporary storage. */
    fileSize: Promise<number>;
    createReadStream: () => Readable;
    /** Cancels the entire multipart request, including any aliases and other pending uploads. */
    abort: () => void;
}
export interface StreamingRequest {
    body: ReadableStream<Uint8Array> | null;
    headers: MinimalRequest['headers'];
    signal?: AbortSignal;
}
export interface StreamingUploadSettings extends UploadProcessSettings {
    maxFieldSize?: number;
    maxRequestSize?: number;
}
/** Opt-in Node.js API; success waits for reception, and all readers must finish within execution. */
export declare function uploadProcessStreaming<TContext extends Record<string, unknown>>(request: StreamingRequest, contextValueInput: TContext, server: UploadServer<TContext>, settings?: StreamingUploadSettings): Promise<NextResponse>;
