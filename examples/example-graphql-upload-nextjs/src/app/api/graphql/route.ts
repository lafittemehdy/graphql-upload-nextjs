import { GraphQLUpload, type File, uploadProcess } from './../../../../../../index.js'
import { ApolloServer, type GraphQLResponse } from '@apollo/server'
import { NextRequest } from 'next/server'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream'
import { startServerAndCreateNextHandler } from '@as-integrations/next'
import { gql } from '@apollo/client'

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
`

interface GraphQLFileResponse {
    encoding: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    uri: string;
}

const resolvers = {
    Mutation: {
        uploadFile: async (_parent: void, { file }: { file: Promise<File> }, { ip }: Context): Promise<GraphQLFileResponse> => {
            try {
                const { createReadStream, encoding, fileName, fileSize, mimeType } = await file
                return new Promise<GraphQLFileResponse>((resolve, reject) => {
                    pipeline(
                        createReadStream(),
                        // IMPORTANT: Storing files in 'public' is insecure for production. Use secure storage.
                        createWriteStream(`./public/${fileName}`),
                        (error) => {
                            if (error) {
                                reject(new Error('Error during file upload.'))
                            } else {
                                resolve({ encoding, fileName, fileSize, mimeType, uri: `http://localhost:3000/${fileName}` })
                            }
                        }
                    )
                })
            } catch (error) {
                throw new Error('Failed to handle file upload.')
            }
        },
        uploadFiles: async (_parent: void, { files }: { files: Promise<File>[] }, { ip }: Context): Promise<GraphQLFileResponse[]> => {
            const resolvedFileObjects = await Promise.all(files);
            
            const processingPromises = resolvedFileObjects.map(async (fileObject) => {
                if (!fileObject || typeof fileObject.createReadStream !== 'function' || !fileObject.fileName) {
                    throw new Error(`Invalid file data encountered for one of the files.`);
                }

                const { createReadStream, encoding, fileName, fileSize, mimeType } = fileObject;
                
                return new Promise<GraphQLFileResponse>((resolve, reject) => {
                    const readStream = createReadStream();
                    if (typeof readStream.pipe !== 'function') {
                        return reject(new Error(`Failed to get a readable stream for ${fileName}.`));
                    }
                    pipeline(
                        readStream,
                        // IMPORTANT: Insecure storage. Use secure solution in production.
                        createWriteStream(`./public/${fileName}`),
                        (error) => {
                            if (error) {
                                reject(new Error(`Error during upload of ${fileName}.`));
                            } else {
                                resolve({ encoding, fileName, fileSize, mimeType, uri: `http://localhost:3000/${fileName}` });
                            }
                        }
                    );
                });
            });

            return Promise.all(processingPromises);
        }
    },
    Query: {
        default: async () => true
    },
    Upload: GraphQLUpload
}

const server = new ApolloServer({ resolvers, typeDefs })

interface Context {
    ip: string
    req: NextRequest
    [key: string]: unknown;
}

const contextHandler = async (req: NextRequest, authenticated: string | boolean = false): Promise<Context> => {
    const ip = req.headers.get('x-forwarded-for') || ''
    if (authenticated) return { ip, req } 
    return { ip, req }
}

interface ServerExecuteOperationParams {
    query: string;
    variables: Record<string, unknown>;
}

interface ExpectedServerType<TContext extends Record<string, unknown>> {
    executeOperation: (
        params: ServerExecuteOperationParams,
        context: { contextValue: TContext }
    ) => Promise<GraphQLResponse<TContext>>;
}

const handler = startServerAndCreateNextHandler<NextRequest, Context>(server, { context: contextHandler })

const requestHandler = async (request: NextRequest) => {
    try {
        if (request.headers.get('content-type')?.includes('multipart/form-data')) {
            // IMPORTANT: Authenticate before processing uploads. Placeholder 'User' used.
            const context = await contextHandler(request, 'User') 
            return await uploadProcess(
                request,
                context,
                server as any, 
                {
                    allowedTypes: ['image/jpeg', 'image/png', 'text/plain'],
                    maxFileSize: 10 * 1024 * 1024 // 10MB
                }
            )
        }
        return handler(request)
    } catch (error) {
        throw new Error('Failed to process request.')
    }
}

export const GET = requestHandler
export const POST = requestHandler
export const OPTIONS = requestHandler