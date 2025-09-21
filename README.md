# graphql-upload-nextjs

`graphql-upload-nextjs` is a robust package that enables seamless file uploads in a Next.js environment using GraphQL. This package is designed to integrate easily with Apollo Server, allowing you to handle file uploads in your GraphQL mutations with ease and efficiency.

## Features

- Supports file uploads via GraphQL in a Next.js environment.
- Utilizes Apollo Server for handling GraphQL operations.
- Provides utilities for processing and validating file uploads.
- Handles various file types with customizable MIME type and size restrictions.
- Offers a clear and structured approach for integrating file uploads into your GraphQL schema.

## Installation

To install the package, use one of the following commands:

```bash
npm install graphql-upload-nextjs
# or
yarn add graphql-upload-nextjs
# or
pnpm add graphql-upload-nextjs
```

## Usage

### Importing the Package

Import the necessary components from the package:

```javascript
import { GraphQLUpload, type File, uploadProcess } from 'graphql-upload-nextjs'

import { ApolloServer } from '@apollo/server'
import { NextRequest } from 'next/server'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream'
import { startServerAndCreateNextHandler } from '@as-integrations/next'

// Optional: Use the gql module from Apollo Client for syntax highlighting. 
// This package is already installed for the client side.
import { gql } from '@apollo/client'
```

### Defining the GraphQL Schema and Resolvers

Define your GraphQL schema and resolvers:

```javascript
// For this example, we define the GraphQL schema and resolvers below.
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
        default: async () => true
    },
    // Add the custom scalar type for file uploads.
    Upload: GraphQLUpload
}
```

### Creating the Apollo Server

Create the Apollo Server instance and set up the request handler:

```javascript
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

// Export request handlers for GET, POST, and OPTIONS methods.
export const GET = requestHandler;
export const POST = requestHandler;
export const OPTIONS = requestHandler;
```

### Executing the Mutations

When sending requests to your GraphQL server, you'll need to structure your mutation and variables correctly. This package adheres to the [GraphQL multipart request specification](https://github.com/jaydenseric/graphql-multipart-request-spec) for file uploads.

**Single File Upload (`uploadFile` mutation):**

*GraphQL Operation:*
```graphql
mutation UploadFile($file: Upload!) {
  uploadFile(file: $file) {
    fileName
    mimeType
    encoding
    uri
    fileSize
  }
}
```

*GraphQL Variables:*
The key in the variables object (`"file"`) must match the argument name in your GraphQL mutation (`$file`).
When using a GraphQL client library (e.g., Apollo Client, urql, Relay):
*   You'll typically pass the browser's `File` object (e.g., from an `<input type="file">`) directly as the value for the `file` variable.
*   The client library automatically constructs the multipart/form-data request according to the GraphQL multipart request specification.

The `{"file": null}` structure illustrates how the `operations` part of the multipart request is formed, where `null` acts as a placeholder for the actual file content that is sent in a separate part of the request. You generally don't need to construct this manually when using a client library.

*Example with a client library (conceptual):*
```javascript
// In your frontend code
import { gql, useMutation } from '@apollo/client'; // Or your client of choice

const UPLOAD_FILE_MUTATION = gql`
  mutation UploadFile($file: Upload!) {
    uploadFile(file: $file) { fileName }
  }
`;

function MyUploader() {
  const [uploadFileMutation] = useMutation(UPLOAD_FILE_MUTATION);

  const handleChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      uploadFileMutation({ variables: { file } });
    }
  };

  return <input type="file" onChange={handleChange} />;
}
```

**Multiple File Upload (`uploadFiles` mutation):**

*GraphQL Operation:*
```graphql
mutation UploadFiles($files: [Upload!]!) {
  uploadFiles(files: $files) {
    fileName
    mimeType
    encoding
    uri
    fileSize
  }
}
```

*GraphQL Variables:*
Similarly, the key `"files"` must match the argument name (`$files`).
When using a GraphQL client library:
*   You'll pass an array of `File` objects as the value for the `files` variable.
*   The client library handles the multipart request construction.

The `{"files": [null, null]}` structure illustrates the `operations` part, with `null` placeholders for file content sent separately.

*Example with a client library (conceptual):*
```javascript
// In your frontend code
const UPLOAD_FILES_MUTATION = gql`
  mutation UploadFiles($files: [Upload!]!) {
    uploadFiles(files: $files) { fileName }
  }
`;

function MyMultiUploader() {
  const [uploadFilesMutation] = useMutation(UPLOAD_FILES_MUTATION);

  const handleChange = (event) => {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
      uploadFilesMutation({ variables: { files } });
    }
  };

  return <input type="file" multiple onChange={handleChange} />;
}
```

## Example

An example project demonstrating how to integrate GraphQL file uploads into a typical Next.js starter application is available in the repository under `graphql-upload-nextjs/examples/example-graphql-upload-nextjs/`.

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/lafittemehdy/graphql-upload-nextjs/blob/master/LICENSE) file for more information.

## Acknowledgements

I would like to express my sincere gratitude to [meabed](https://github.com/meabed) for their excellent work on [graphql-upload-ts](https://github.com/meabed/graphql-upload-ts), which served as a valuable reference and inspiration for this project. I am also grateful to [jaydenseric](https://github.com/jaydenseric) for developing the original specifications for [graphql-upload](https://github.com/jaydenseric/graphql-upload).

While this project deviates from the official specifications to prioritize compatibility with Next.js routes, I am committed to refining it further to align with those specifications as closely as possible. Notable enhancements include built-in security features, such as file type verification, as well as support and an example for GraphQL authentication.

Finally, I would like to extend my heartfelt gratitude to my mom for her unwavering support, which has allowed me to dedicate my time to working on open-source software.
