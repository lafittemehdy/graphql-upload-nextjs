import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { gql } from "@apollo/client";
import { ApolloServer, type GraphQLResponse } from "@apollo/server";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { type File, GraphQLUpload, uploadProcess } from "graphql-upload-nextjs";
import type { NextRequest } from "next/server.js";

/** Allowed MIME types for file uploads. */
const ALLOWED_TYPES = ["image/jpeg", "image/png", "text/plain"];

/** Maximum file size in bytes (10MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const typeDefs = gql`
  # Custom scalar type for handling file uploads.
  scalar Upload
  type File {
    encoding: String!
    filename: String!
    fileSize: Int!
    mimetype: String!
    uri: String!
  }
  type Query {
    default: Boolean!
  }
  type Mutation {
    uploadFile(file: Upload!): File!
    uploadFiles(files: [Upload!]!): [File!]!
  }
`;

/** Response shape returned by file upload resolvers. */
interface GraphQLFileResponse {
  encoding: string;
  filename: string;
  fileSize: number;
  mimetype: string;
  uri: string;
}

/**
 * Validates, stores, and returns metadata for a single uploaded file.
 * Sanitizes the file name to prevent path traversal attacks.
 */
async function processAndStoreFile(
  fileData: File,
): Promise<GraphQLFileResponse> {
  const { createReadStream, encoding, fileSize, mimetype } = fileData;
  const safeName = path.basename(fileData.filename);

  if (!ALLOWED_TYPES.includes(mimetype)) {
    throw new Error(`File type ${mimetype} is not allowed for ${safeName}.`);
  }

  if (fileSize > MAX_FILE_SIZE) {
    throw new Error(`File ${safeName} size exceeds the limit of 10MB.`);
  }

  return new Promise<GraphQLFileResponse>((resolve, reject) => {
    pipeline(
      createReadStream(),
      // IMPORTANT: Storing files in 'public' is insecure for production. Use secure storage.
      createWriteStream(`./public/${safeName}`),
      (error) => {
        if (error) {
          reject(new Error(`Error during upload of ${safeName}.`));
        } else {
          resolve({
            encoding,
            filename: safeName,
            fileSize,
            mimetype,
            uri: `http://localhost:3000/${safeName}`,
          });
        }
      },
    );
  });
}

const resolvers = {
  Mutation: {
    uploadFile: async (
      _parent: undefined,
      { file }: { file: Promise<File> },
      _context: Context,
    ): Promise<GraphQLFileResponse> => {
      return processAndStoreFile(await file);
    },
    uploadFiles: async (
      _parent: undefined,
      { files }: { files: Promise<File>[] },
      _context: Context,
    ): Promise<GraphQLFileResponse[]> => {
      const resolvedFiles = await Promise.all(files);
      return Promise.all(resolvedFiles.map(processAndStoreFile));
    },
  },
  Query: {
    default: async () => true,
  },
  Upload: GraphQLUpload,
};

const server = new ApolloServer({ resolvers, typeDefs });

/** GraphQL request context with client IP and the original request. */
interface Context {
  ip: string;
  req: NextRequest;
  [key: string]: unknown;
}

/** Creates a GraphQL context with request metadata. */
const contextHandler = async (req: NextRequest): Promise<Context> => {
  const ip = req.headers.get("x-forwarded-for") || "";
  return { ip, req };
};

/** Parameters for Apollo Server's executeOperation method. */
interface ServerExecuteOperationParams {
  query: string;
  variables: Record<string, unknown>;
}

/** Typed wrapper for the Apollo Server instance used with uploadProcess. */
interface ExpectedServerType<TContext extends Record<string, unknown>> {
  executeOperation: (
    params: ServerExecuteOperationParams,
    context: { contextValue: TContext },
  ) => Promise<GraphQLResponse<TContext>>;
}

const handler = startServerAndCreateNextHandler<NextRequest, Context>(server, {
  context: contextHandler,
});

/** Routes requests to the appropriate handler based on content type. */
const requestHandler = async (request: NextRequest) => {
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const context = await contextHandler(request);
    return await uploadProcess(
      request,
      context,
      server as ExpectedServerType<Context>,
    );
  }
  return handler(request);
};

export const GET = requestHandler;
export const OPTIONS = requestHandler;
export const POST = requestHandler;
