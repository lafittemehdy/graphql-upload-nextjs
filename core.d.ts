import { GraphQLScalarType } from 'graphql';
import { NextResponse } from 'next/server.js';
/** Represents a processed file with metadata and stream access. */
export interface File {
    createReadStream: () => NodeJS.ReadableStream;
    encoding: string;
    fileSize: number;
    filename: string;
    mimetype: string;
}
/** Raw file entry extracted from multipart FormData. */
export interface FormDataFile {
    lastModified: number;
    name: string;
    size: number;
    type: string;
}
/** Extends FormDataFile with a stream method for reading file contents. */
export interface FileStream extends FormDataFile {
    stream: () => ReadableStream;
}
/** Minimal request interface compatible with Next.js and Web API requests. */
export interface MinimalRequest {
    formData: () => Promise<FormData>;
    headers: {
        get: (name: string) => string | null;
    };
}
/** Parameters for Apollo Server's executeOperation method. */
interface ServerExecuteOperationParams {
    operationName?: string;
    query: string;
    variables: Record<string, unknown>;
}
/** Minimal response shape consumed from Apollo Server executeOperation. */
interface ServerExecuteOperationResponse {
    body: {
        kind: string;
        [key: string]: unknown;
    };
}
/** Normalized GraphQL operation shape passed to Apollo Server. */
export interface Operation {
    operationName?: string;
    query: string;
    variables?: Record<string, unknown>;
}
/** Optional upload processing limits and MIME allow-list. */
export interface UploadProcessSettings {
    allowedTypes?: string[];
    maxFileSize?: number;
    maxFiles?: number;
}
/**
 * Represents an instance of a file upload.
 * Holds a promise that resolves with the file details once processed.
 */
export declare class Upload<TFile = File> {
    file?: TFile;
    promise: Promise<TFile>;
    reject: (reason?: Error | string) => void;
    resolve: (file: TFile) => void;
    constructor();
}
/** Custom GraphQL scalar type for handling file uploads. */
export declare const GraphQLUpload: GraphQLScalarType<Promise<File>, never>;
/** Converts a Buffer into a Node.js readable stream. */
export declare function bufferToStream(buffer: Buffer): NodeJS.ReadableStream;
/** Parses JSON for the operations field. Accepts objects or arrays (for batching per spec). */
export declare function parseOperationsJSON(input: string): Record<string, unknown> | Record<string, unknown>[];
/**
 * Processes a file from FormData, detects its MIME type via magic bytes,
 * and returns buffered file metadata with replayable stream access.
 */
export declare function processUpload(file: FormDataFile, allowedTypes?: string[]): Promise<File>;
/** Parses and validates a JSON string, ensuring it resolves to a non-null object (rejects arrays). */
export declare function sanitizeAndValidateJSON(input: string): unknown;
/** Sets a value at a dot-notation path in a nested object, creating intermediate containers as needed. */
export declare function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void;
/** Converts a Node.js readable stream into a Buffer by collecting all chunks. */
export declare function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer>;
/** Validates that each map entry is an array of string paths. */
export declare function validateMap(map: Record<string, unknown>): string | null;
/** Identifies a bounded file prefix without trusting its name or declared content type. */
export declare function detectMimeType(headerBuffer: Buffer, allowedTypes?: string[]): Promise<string>;
/** Distinguishes safe protocol errors from unexpected server exceptions. */
export declare class UploadRequestError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export interface UploadServer<TContext> {
    executeOperation: (params: ServerExecuteOperationParams, context: {
        contextValue: TContext;
    }) => Promise<ServerExecuteOperationResponse>;
}
/** Checks configuration and the preflight boundary before consuming request bytes. */
export declare function checkUploadRequest(headers: MinimalRequest['headers'], settings?: UploadProcessSettings): void;
/** Validates every target before replacing nulls; assignment preserves existing container shapes. */
export declare function prepareOperations<TFile = File>(operationsRaw: string, mapRaw: string, maxFiles?: number): {
    operations: Operation | Operation[];
    uploads: Map<string, Upload<TFile>>;
};
/** Preserves operation order, context, and the existing response envelope in both APIs. */
export declare function executeOperations<TContext>(operations: Operation | Operation[], context: TContext, server: UploadServer<TContext>): Promise<NextResponse>;
/** Only intentional request errors may expose their details to an untrusted client. */
export declare function uploadErrorResponse(error: unknown): NextResponse;
export {};
