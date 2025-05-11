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
        // This is a simplified example for demonstration purposes only; do not use this code in a production environment.
        uploadFile: async (_parent: void, { file }: { file: Promise<File> }, { ip }: Context) => {
            try {
                const { createReadStream, encoding, fileName, fileSize, mimeType } = await file

                // Use a Promise to handle the asynchronous file saving operation.
                return new Promise((resolve, reject) => {
                    pipeline(
                        createReadStream(),
                        // This example stores the file in the 'public' directory for simplicity, you should NEVER do this.
                        createWriteStream(`./public/${fileName}`),
                        (error) => {
                            if (error) {
                                console.error('File upload pipeline error:', error)
                                reject(new Error('Error during file upload.'))
                            } else {
                                console.log(`${ip} successfully uploaded ${fileName}`)
                                // Resolve the promise with the file details for the GraphQL response.
                                resolve({ encoding, fileName, fileSize, mimeType, uri: `http://localhost:3000/${fileName}` })
                            }
                        }
                    )
                })
            } catch (error) {
                // You should handle any errors that occur during file upload more gracefully.
                console.error('Error handling file upload:', error)
                throw new Error('Failed to handle file upload.')
            }
        },
        uploadFiles: async (_parent: void, { files }: { files: [Promise<File>] }, { ip }: Context) => {
            try {
                const results = await Promise.all(
                    files.map(async (file) => {
                        const { createReadStream, encoding, fileName, fileSize, mimeType } = await file;
                        return new Promise((resolve, reject) => {
                            pipeline(
                                createReadStream(),
                                createWriteStream(`./public/${fileName}`), // Store in 'public' for simplicity
                                (error) => {
                                    if (error) {
                                        console.error('File upload pipeline error:', error);
                                        reject(new Error('Error during file upload.'));
                                    } else {
                                        console.log(`${ip} successfully uploaded ${fileName}`);
                                        resolve({ encoding, fileName, fileSize, mimeType, uri: `http://localhost:3000/${fileName}` });
                                    }
                                }
                            );
                        });
                    })
                );
                return results;
            } catch (error) {
                console.error('Error handling multiple file uploads:', error);
                throw new Error('Failed to handle multiple file uploads.');
            }
        }
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
// Where data and requests meet (and hopefully get along).
const server = new ApolloServer({ resolvers, typeDefs })

interface Context {
    ip: string        // IP address of the client.
    req: NextRequest  // The Next.js request object.
}

// You'll usually want to authenticate users here, but for this example, we'll just get the IP address.
// We centralize the context creation to avoid code duplication.
const contextHandler = async (req: NextRequest, authenticated: string | boolean = false): Promise<Context> => {
    const ip = req.ip || req.headers.get('x-forwarded-for') || ''
    // Since we've already authenticated the user, we skip it here. See the requestHandler for more details.
    if (authenticated) return { ip, req }
    // Default context for normal operations.
    return { ip, req }
}

// Apollo, we have liftoff! 🚀
const handler = startServerAndCreateNextHandler<NextRequest, Context>(server, { context: contextHandler })

// Handle upload requests separately from other GraphQL operations.
// Note: This implementation is basic and needs enhancement for production use.
const requestHandler = async (request: NextRequest) => {
    try {
        // Handle file uploads specifically if the request is multipart/form-data.
        if (request.headers.get('content-type')?.includes('multipart/form-data')) {
            // Authenticate before uploading to prevent abuse.
            // Pass the authenticated user to contextHandler to skip redundant authentication.
            // 'User' is used as a placeholder for the authenticated user.
            const context = await contextHandler(request, 'User')
            return await uploadProcess(
                request,
                context,
                server,
                {
                    // Allow only certain MIME types
                    allowedTypes: ['image/jpeg', 'image/png', 'text/plain'],
                    // Only allow image uploads up to 10MB.
                    maxFileSize: 10 * 1024 * 1024
                }
            )
        }
        // Handle all other requests with the Apollo Server.
        return handler(request)
    } catch (error) {
        // In a production environment, errors should be handled more gracefully.
        console.error('Error in request handling:', error)
        throw new Error('Failed to process request.')
    }
}

// Export request handlers for GET, POST, and OPTIONS methods.
export const GET = requestHandler
export const POST = requestHandler
export const OPTIONS = requestHandler
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

An example project demonstrating how to integrate GraphQL file uploads into a typical Next.js starter application is available in the repository under `graphql-upload-nextjs/examples/example-graphql-upload-nextjs/`. This example uses a relative path to the main package for live code testing and development.

## Development Notes

For development, the example uses a relative path to import the package. This setup allows you to test the code live:

```javascript
import { GraphQLUpload, type File, uploadProcess } from '../../../../../../index'
```

To use the example as a standalone, update the import to:

```javascript
import { GraphQLUpload, type File, uploadProcess } from 'graphql-upload-nextjs'
```

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/lafittemehdy/graphql-upload-nextjs/blob/master/LICENSE) file for more information.

## Acknowledgements

I would like to express my sincere gratitude to [meabed](https://github.com/meabed) for their excellent work on [graphql-upload-ts](https://github.com/meabed/graphql-upload-ts), which served as a valuable reference and inspiration for this project. I am also grateful to [jaydenseric](https://github.com/jaydenseric) for developing the original specifications for [graphql-upload](https://github.com/jaydenseric/graphql-upload).

While this project deviates from the official specifications to prioritize compatibility with Next.js routes, I am committed to refining it further to align with those specifications as closely as possible. Notable enhancements include built-in security features, such as file type verification, as well as support and an example for GraphQL authentication.

Finally, I would like to extend my heartfelt gratitude to my mom for her unwavering support, including hosting me and allowing me to dedicate my time to working on open-source software.