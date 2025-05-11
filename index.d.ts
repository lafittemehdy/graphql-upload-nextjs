import { GraphQLScalarType, GraphQLError } from 'graphql';
import { NextResponse } from 'next/server.js';
import type { GraphQLResponse } from '@apollo/server';
export interface File {
    createReadStream: () => NodeJS.ReadableStream;
    encoding: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
}
export interface FileStream extends FormDataFile {
    stream: () => Promise<NodeJS.ReadableStream>;
}
export interface FormDataFile {
    lastModified: number;
    name: string;
    size: number;
    type: string;
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
export declare const GraphQLUpload: GraphQLScalarType<Promise<File> | GraphQLError, never>;
export declare function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer>;
export declare function bufferToStream(buffer: Buffer): NodeJS.ReadableStream;
export declare function sanitizeAndValidateJSON(input: string): unknown;
interface ServerExecuteOperationParams {
    query: string;
    variables: Record<string, unknown>;
}
export interface MinimalRequest {
    formData: () => Promise<FormData>;
    headers: {
        get: (name: string) => string | null;
    };
}
/**
 * Processes a GraphQL multipart request with file uploads.
 */
export declare function uploadProcess<TContext extends Record<string, unknown>>(request: MinimalRequest, contextValueInput: TContext, server: {
    executeOperation: (params: ServerExecuteOperationParams, context: {
        contextValue: TContext;
    }) => Promise<GraphQLResponse<TContext>>;
}, settings: {
    allowedTypes: string[];
    maxFileSize: number;
}): Promise<NextResponse<any>>;
export {};
