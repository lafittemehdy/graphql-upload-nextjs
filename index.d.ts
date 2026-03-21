import type { GraphQLResponse } from '@apollo/server';
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
    query: string;
    variables: Record<string, unknown>;
}
/**
 * Represents an instance of a file upload.
 * Holds a promise that resolves with the file details once processed.
 */
export declare class Upload {
    file?: File;
    promise: Promise<File>;
    reject: (reason?: Error | string) => void;
    resolve: (file: File) => void;
    constructor();
}
/** Custom GraphQL scalar type for handling file uploads. */
export declare const GraphQLUpload: GraphQLScalarType<Promise<File>, never>;
/** Converts a Buffer into a Node.js readable stream. */
export declare function bufferToStream(buffer: Buffer): NodeJS.ReadableStream;
/** Parses JSON for the operations field. Accepts objects or arrays (for batching per spec). */
export declare function parseOperationsJSON(input: string): Record<string, unknown> | Record<string, unknown>[];
/** Parses and validates a JSON string, ensuring it resolves to a non-null object (rejects arrays). */
export declare function sanitizeAndValidateJSON(input: string): unknown;
/** Sets a value at a dot-notation path in a nested object, creating intermediate containers as needed. */
export declare function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void;
/** Converts a Node.js readable stream into a Buffer by collecting all chunks. */
export declare function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer>;
/** Validates that each map entry is an array of string paths. */
export declare function validateMap(map: Record<string, unknown>): string | null;
/** Processes a GraphQL multipart request with file uploads. Supports batching per the spec. */
export declare function uploadProcess<TContext extends Record<string, unknown>>(request: MinimalRequest, contextValueInput: TContext, server: {
    executeOperation: (params: ServerExecuteOperationParams, context: {
        contextValue: TContext;
    }) => Promise<GraphQLResponse<TContext>>;
}, settings?: {
    allowedTypes?: string[];
    maxFiles?: number;
    maxFileSize?: number;
}): Promise<NextResponse>;
export {};
