/** Shares the example GraphQL schema and context across buffered and streaming routes. */
import { gql } from "@apollo/client";
import { ApolloServer } from "@apollo/server";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import {
  type File,
  GraphQLUpload,
  type StreamingFile,
} from "graphql-upload-nextjs";
import type { NextRequest } from "next/server.js";
import { type GraphQLFileResponse, processAndStoreFile } from "./storeUpload";

export { ALLOWED_TYPES, MAX_FILE_SIZE } from "./storeUpload";

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

const resolvers = {
  Mutation: {
    uploadFile: async (
      _parent: undefined,
      { file }: { file: Promise<File | StreamingFile> },
      _context: Context,
    ): Promise<GraphQLFileResponse> => {
      return processAndStoreFile(await file);
    },
    uploadFiles: async (
      _parent: undefined,
      { files }: { files: Promise<File | StreamingFile>[] },
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

export const server = new ApolloServer({ resolvers, typeDefs });

/** GraphQL request context with client IP and the original request. */
interface Context {
  ip: string;
  req: NextRequest;
  [key: string]: unknown;
}

/** Creates a GraphQL context with request metadata. */
export const contextHandler = async (req: NextRequest): Promise<Context> => {
  const ip = req.headers.get("x-forwarded-for") || "";
  return { ip, req };
};

export const handler = startServerAndCreateNextHandler<NextRequest, Context>(
  server,
  {
    context: contextHandler,
  },
);
