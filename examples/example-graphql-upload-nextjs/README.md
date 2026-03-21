# Example: GraphQL File Upload with Next.js

A working example of [graphql-upload-nextjs](https://github.com/lafittemehdy/graphql-upload-nextjs) integrated into a Next.js 16 application with Apollo Server 5.

## Stack

- [Next.js](https://nextjs.org) 16 (App Router, Turbopack)
- [React](https://react.dev) 19
- [Apollo Server](https://www.apollographql.com/docs/apollo-server) 5
- [Apollo Client](https://www.apollographql.com/docs/react) 4
- [Tailwind CSS](https://tailwindcss.com) 4
- [Biome](https://biomejs.dev) (linting and formatting)
- [TypeScript](https://www.typescriptlang.org) 5

## Getting Started

```bash
git clone https://github.com/lafittemehdy/graphql-upload-nextjs.git
cd graphql-upload-nextjs/examples/example-graphql-upload-nextjs
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the homepage, or go directly to [http://localhost:3000/api/graphql](http://localhost:3000/api/graphql) to open the Apollo Sandbox.

## Available Mutations

The GraphQL API exposes these mutations for testing file uploads:

**Single file upload:**
```graphql
mutation UploadFile($file: Upload!) {
  uploadFile(file: $file) {
    encoding
    filename
    fileSize
    mimetype
    uri
  }
}
```

**Multiple file upload:**
```graphql
mutation UploadFiles($files: [Upload!]!) {
  uploadFiles(files: $files) {
    encoding
    filename
    fileSize
    mimetype
    uri
  }
}
```

### Testing with Apollo Sandbox

1. Open [http://localhost:3000/api/graphql](http://localhost:3000/api/graphql).
2. Write a mutation (e.g., `UploadFile` above).
3. In the Variables panel, set `{"file": null}`.
4. Use the file upload button in the Sandbox to attach a file to the `file` variable.
5. Run the mutation.

### Validation Rules

- **Allowed MIME types:** `image/jpeg`, `image/png`, `text/plain`
- **Max file size:** 10MB
- **Filename sanitization:** `path.basename()` prevents path traversal

> **Note:** Uploaded files are stored in `./public/` for demonstration purposes. This is insecure for production — use cloud storage or a secure file system location.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the development server (Turbopack). |
| `npm run build` | Build for production. |
| `npm run start` | Start the production server. |
| `npm run lint` | Run Biome linter. |
| `npm run format` | Format code with Biome. |

## Local Development

This example references the parent package via `"graphql-upload-nextjs": "file:../.."`  in `package.json`. Changes to the parent `src/index.ts` are reflected after running `npm run build` in the package root.

## License

MIT. See [LICENSE](https://github.com/lafittemehdy/graphql-upload-nextjs/blob/master/LICENSE).
