import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream";
import { gql } from "@apollo/client";
import { ApolloServer, type GraphQLResponse } from "@apollo/server";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { type File, GraphQLUpload, uploadProcess } from "graphql-upload-nextjs";
import type { NextRequest } from "next/server.js";

const typeDefs = gql`
    # Custom scalar type for handling file uploads.
    scalar Upload
    type File {
        encoding: String!
        fileName: String!
        fileSize: Int!
        mimeType: String!
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

interface GraphQLFileResponse {
  encoding: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uri: string;
}

const resolvers = {
  Mutation: {
    uploadFile: async (
      _parent: undefined,
      { file }: { file: Promise<File> },
      _context: Context,
    ): Promise<GraphQLFileResponse> => {
      try {
        const { createReadStream, encoding, fileName, fileSize, mimeType } =
          await file;
        const allowedTypes = ["image/jpeg", "image/png", "text/plain"];
        const maxFileSize = 10 * 1024 * 1024; // 10MB

        if (!allowedTypes.includes(mimeType)) {
          throw new Error(`File type ${mimeType} is not allowed.`);
        }

        if (fileSize > maxFileSize) {
          throw new Error(`File size exceeds the limit of 10MB.`);
        }

        return new Promise<GraphQLFileResponse>((resolve, reject) => {
          pipeline(
            createReadStream(),
            // IMPORTANT: Storing files in 'public' is insecure for production. Use secure storage.
            createWriteStream(`./public/${fileName}`),
            (error) => {
              if (error) {
                reject(new Error("Error during file upload."));
              } else {
                resolve({
                  encoding,
                  fileName,
                  fileSize,
                  mimeType,
                  uri: `http://localhost:3000/${fileName}`,
                });
              }
            },
          );
        });
      } catch (_error) {
        throw new Error("Failed to handle file upload.");
      }
    },
    uploadFiles: async (
      _parent: undefined,
      { files }: { files: Promise<File>[] },
      _context: Context,
    ): Promise<GraphQLFileResponse[]> => {
      const resolvedFileObjects = await Promise.all(files);
      const allowedTypes = ["image/jpeg", "image/png", "text/plain"];
      const maxFileSize = 10 * 1024 * 1024; // 10MB

      const processingPromises = resolvedFileObjects.map(async (fileObject) => {
        if (
          !fileObject ||
          typeof fileObject.createReadStream !== "function" ||
          !fileObject.fileName
        ) {
          throw new Error(
            `Invalid file data encountered for one of the files.`,
          );
        }

        const { createReadStream, encoding, fileName, fileSize, mimeType } =
          fileObject;

        if (!allowedTypes.includes(mimeType)) {
          throw new Error(
            `File type ${mimeType} is not allowed for ${fileName}.`,
          );
        }

        if (fileSize > maxFileSize) {
          throw new Error(`File ${fileName} size exceeds the limit of 10MB.`);
        }

        return new Promise<GraphQLFileResponse>((resolve, reject) => {
          const readStream = createReadStream();
          if (typeof readStream.pipe !== "function") {
            return reject(
              new Error(`Failed to get a readable stream for ${fileName}.`),
            );
          }
          pipeline(
            readStream,
            // IMPORTANT: Insecure storage. Use secure solution in production.
            createWriteStream(`./public/${fileName}`),
            (error) => {
              if (error) {
                reject(new Error(`Error during upload of ${fileName}.`));
              } else {
                resolve({
                  encoding,
                  fileName,
                  fileSize,
                  mimeType,
                  uri: `http://localhost:3000/${fileName}`,
                });
              }
            },
          );
        });
      });

      return Promise.all(processingPromises);
    },
  },
  Query: {
    default: async () => true,
  },
  Upload: GraphQLUpload,
};

const server = new ApolloServer({ resolvers, typeDefs });

interface Context {
  ip: string;
  req: NextRequest;
  [key: string]: unknown;
}

const contextHandler = async (
  req: NextRequest,
  authenticated: string | boolean = false,
): Promise<Context> => {
  const ip = req.headers.get("x-forwarded-for") || "";
  if (authenticated) return { ip, req };
  return { ip, req };
};

interface ServerExecuteOperationParams {
  query: string;
  variables: Record<string, unknown>;
}

interface ExpectedServerType<TContext extends Record<string, unknown>> {
  executeOperation: (
    params: ServerExecuteOperationParams,
    context: { contextValue: TContext },
  ) => Promise<GraphQLResponse<TContext>>;
}

const handler = startServerAndCreateNextHandler<NextRequest, Context>(server, {
  context: contextHandler,
});

const requestHandler = async (request: NextRequest) => {
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      // IMPORTANT: Authenticate before processing uploads. Placeholder 'User' used.
      const context = await contextHandler(request, "User");
      return await uploadProcess(
        request,
        context,
        server as ExpectedServerType<Context>,
      );
    }
    return handler(request);
  } catch (_error) {
    throw new Error("Failed to process request.");
  }
};

export const GET = requestHandler;
export const POST = requestHandler;
export const OPTIONS = requestHandler;
