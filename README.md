# graphql-upload-nextjs

The `graphql-upload-nextjs` package supports the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec) for the Next.js App Router and Apollo Server. It has an `Upload` scalar, buffered uploads and an optional streaming API. The package declares Node.js 22.13+, Apollo Server 5, GraphQL 16 and Next.js 16 support. Check the engine requirements of your chosen dependency versions too, as they may require a newer Node.js patch release.

## Installation

Install the package and its integrations via npm:

```sh
npm install graphql-upload-nextjs @apollo/server @as-integrations/next graphql next
```

## Choosing an upload API

The package offers two upload APIs: `uploadProcess` and `uploadProcessStreaming`.

The `uploadProcess` API keeps the existing buffered calling contract and continues to expose file sizes as numbers. It waits for native `request.formData()` to consume the body, then starts resolver execution once the uploads have been received and prepared. Files can be read from the received `Blob` objects multiple times. The configured size and count limits are checked after body parsing, and the runtime manages the received file storage.

The `uploadProcessStreaming` API is opt-in. It uses [Busboy](https://github.com/mscdex/busboy) to parse `request.body` incrementally, so resolver execution can start as soon as the `operations` and `map` fields have been validated. Each file can be read from private temporary storage whilst the upload is still in progress. Its `fileSize` property is a `Promise<number>`. Limits are enforced during reception, and the API requires a writable `os.tmpdir()` directory.

Buffering is a perfectly legitimate option for small uploads when your upstream server enforces a suitable total request-body limit. Streaming is useful for larger uploads, concurrent traffic and processing files as you receive them. Next.js does provide access to a raw request-body stream, so buffering is an implementation choice rather than an inevitable App Router limitation.

Both APIs support individual files, nested variable paths, file lists, operation batching, deduplication, `operationName` and the same `GraphQLUpload` scalar. MIME detection looks at up to 4,100 bytes and ignores the MIME type provided by the client. Unrecognised binary contents fall back to `application/octet-stream`, and text-like contents to `text/plain`. The detection is heuristic: it doesn't guarantee that a file is safe or well formed.

## Buffered uploads and existing usage

Existing consumers can keep their imports, handler calls, resolver types and numeric `fileSize` values. Define `scalar Upload` in the GraphQL schema and register `Upload: GraphQLUpload` in the resolvers. Valid buffered requests retain their behaviour; the stricter handling of malformed or ambiguous inputs is described under [Public API compatibility](#public-api-compatibility).

In a Next.js route, create an `ApolloServer` instance with your app's schema and resolvers. Create a context function using the `NextRequest`, then initialise the Apollo handler with `startServerAndCreateNextHandler`. In the `POST` handler, pass multipart requests, the resolved context, the server and any settings to `uploadProcess`. Otherwise, pass the request to the normal Apollo handler.

For instance, you might allow `image/jpeg`, `image/png` and `text/plain`, set `maxFileSize` to 10 MiB and `maxFiles` to 10. The [buffered example route](examples/example-graphql-upload-nextjs/src/app/api/graphql/route.ts) shows the handler, and the [shared schema and resolvers](examples/example-graphql-upload-nextjs/src/lib/graphql.ts) show the integration.

In a buffered resolver, `await file` gives you a `File` with `filename`, `encoding`, `mimetype`, a numeric `fileSize` and `createReadStream()`. Await the full stream pipeline before returning from the resolver.

### Buffered settings

- `allowedTypes` defaults to unrestricted. It accepts an array of non-empty MIME strings and compares them against the detected MIME type. An empty array allows no mapped file types.
- `maxFileSize` defaults to unrestricted and accepts a finite, non-negative byte limit.
- `maxFiles` defaults to unrestricted and accepts a non-negative safe integer. It limits the number of mapped file entries and the number of physical file parts separately; those counts aren't added together. Unmapped file parts still count towards the physical-file limit.

**These settings don't cap the resources consumed by `request.formData()`.** You'll need an enforced body-size limit before the handler, along with request timeouts and concurrency limits appropriate to your host. Simply checking `Content-Length` won't enforce a limit for streamed requests or a dishonest client.

## Opt-in streaming

Use `uploadProcessStreaming` only on endpoints whose resolvers follow the streaming contract. Existing buffered endpoints won't automatically switch over.

In a streaming Next.js route, set `export const runtime = 'nodejs'` and pass the request, resolved context, server and streaming settings to `uploadProcessStreaming`. For instance, you might allow `image/jpeg`, `image/png` and `text/plain`, with `maxFieldSize` of 1 MiB, `maxFileSize` of 10 MiB, `maxFiles` of 10 and `maxRequestSize` of 100 MiB. See the [streaming example route](examples/example-graphql-upload-nextjs/src/app/api/graphql-streaming/route.ts).

The request must expose an unread, unlocked `body` stream and a multipart `Content-Type`. Native Next.js requests also provide an abort `signal` so the library can cancel work when a disconnect is reported. Adapters that only expose `formData()` should continue using the buffered API.

### Streaming resolver contract

The resolver receives a `Promise<StreamingFile>`. Await it to get the upload, then pass `upload.createReadStream()` and your app's writable destination to Node.js's stream pipeline. Await the pipeline, then `upload.fileSize` for the final byte count. You can then return the filename, file size and MIME type.

The destination must be an application-owned writable stream. The [runnable storage example](examples/example-graphql-upload-nextjs/src/lib/storeUpload.ts) uses random identifiers with MIME-based extensions and exclusive writes. If writing or processing that file fails, it attempts to remove that destination. It doesn't roll back other files that have already been stored successfully.

A few details matter when writing a streaming resolver:

- The upload promise resolves once the bounded MIME detection prefix is available. Small files may already have finished reception by then.
- Each call to `createReadStream()` starts at byte zero and reads independently, even when one physical file is mapped to several variables or batch operations.
- The `fileSize` promise resolves once the full file has been received and written to temporary storage. Reception failure or cancellation rejects it if it hasn't already settled.
- Create and finish all readers during resolver execution. Cleanup closes outstanding readers, and new streams are rejected once handler cleanup has started. On normal completion, temporary storage is released before the handler returns.
- Calling `upload.abort()` cancels the **entire multipart request**, including other uploads and aliases. Destroying an individual reader only stops that reader.

GraphQL execution can start before later file parts have been validated. A late limit violation, malformed part or disconnect can't roll back database changes or other external side effects. Your app has to deal with partial writes and define its own commit/rollback policy.

Successful responses wait for reception, file writes and MIME validation to finish. The API streams incoming files but keeps the existing JSON response envelope. Apollo incremental results are accumulated into that envelope rather than streamed over HTTP.

### Streaming settings

- `allowedTypes` defaults to unrestricted and uses the same detected MIME allow-list as the buffered API.
- `maxFieldSize` defaults to 1 MiB and applies separately to each `operations` or `map` field.
- `maxFileSize` defaults to 10 MiB and applies to every received file, including unmapped files.
- `maxFiles` defaults to 10. It separately limits mapped entries and received physical file parts, as in the buffered API.
- `maxRequestSize` defaults to 100 MiB and caps actual received body bytes, including fields, multipart framing and ignored parts.

All numeric streaming limits are inclusive, non-negative safe integers. A limit of zero allows zero bytes or files; it doesn't disable the limit. MiB means 1,048,576 bytes.

The host still needs sufficient disk space, request timeouts, concurrency controls and process-crash recovery. A reverse proxy or hosting platform may buffer a request before the handler sees it, or delay an early error response until the client finishes sending, so check the full deployment path. This implementation requires Node.js and writable temporary storage; it doesn't support the Edge runtime.

## Client requests and security

Both upload APIs require a non-empty `Apollo-Require-Preflight` or `X-Apollo-Operation-Name` header before reading the body. Set this header on your upload client:

```ts
headers: { 'Apollo-Require-Preflight': 'true' }
```

Use an upload-aware GraphQL transport such as [apollo-upload-client](https://github.com/jaydenseric/apollo-upload-client). Keep your CORS allow-list restricted to origins you trust. The preflight requirement isn't authentication; authentication, authorisation and quotas remain your app's responsibility. Apply the same auth and context policies to JSON and multipart routes. Direct Apollo execution doesn't invoke a separate HTTP adapter's context callback.

Map paths must point to existing `null` placeholders within operation variables. For batched requests, each path starts with the operation index. A single physical file can map to several paths, but different file fields can't compete for the same placeholder. The parser rejects dangerous prototype keys in paths, duplicate physical file field names and duplicate control fields. Identical file contents are allowed. Missing files reject their associated upload promises.

The streaming parser requires `operations` first, then `map`, then uniquely named file fields. It rejects extra control fields. The buffered API retains its more flexible field-order handling, though clients following the multipart specification should always use the specified order. `FormData.entries()` exposes entry order, so buffered ordering validation is possible; strict ordering is deliberately confined to the opt-in parser for backwards compatibility.

Malformed requests return 400, and configured size or count limit violations return 413. Streaming disconnects return 499 when a response can still be delivered. GraphQL execution errors keep Apollo's result envelope. Unexpected exceptions caught during upload processing return a generic 500 without exposing the exception details.

Store uploaded files outside public directories, sanitise display filenames and use server-generated storage keys. MIME sniffing isn't malware scanning or authorisation. The example download endpoint is for development: add authentication and ownership checks before serving private uploads in production.

### Apollo Server dependency advisory

As of 2026-11-14, Apollo Server 5.5.2 restricts its transitive GraphQL Tools dependencies to versions affected by [GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3). This concerns merging untrusted incremental GraphQL results; it is separate from this package's multipart path validation.

Until Apollo publishes compatible patched dependency ranges, apply the following override in **your application's root** package.json, reinstall, and run your application's tests and audit:

```json
{
  "overrides": {
    "@graphql-tools/utils@>=10.10.1 <12.0.2": "12.0.2"
  }
}
```

For pnpm, put the same selector under `overrides` in your root pnpm-workspace.yaml. Dependency packages cannot enforce overrides on their consumers. The repository and example apply patched overrides, and the packed Apollo consumer is tested separately. Remove the application override when your upstream dependency graph resolves patched versions itself.

## Public API compatibility

`setValueAtPath` creates an own container when a path encounters an inherited property. Existing own-property object and array paths retain their behavior; inherited containers are not mutated.

The existing exports are still there: `File`, `FileStream`, `FormDataFile`, `MinimalRequest`, `GraphQLUpload`, `Upload`, `uploadProcess`, `bufferToStream`, `parseOperationsJSON`, `sanitizeAndValidateJSON`, `setValueAtPath`, `streamToBuffer` and `validateMap`. `Upload` now accepts an optional file type parameter; its default is still `File`.

The new exports are `StreamingFile`, `StreamingRequest`, `StreamingUploadSettings` and `uploadProcessStreaming`. Existing buffered callers don't need these new types. Valid buffered requests retain their behaviour. Ambiguous duplicate inputs are now rejected, numeric JSON object keys preserve their sibling properties, malformed body syntax produces a client error, and unexpected server exception details are no longer exposed.

## Examples and verification

The [example project](examples/example-graphql-upload-nextjs/) has two endpoints: `/api/graphql` takes buffered uploads, and `/api/graphql-streaming` takes streamed ones. Both share the same schema and storage implementation.

From the repository root, build and check the package:

```sh
npm ci
npm run build
npm test
npm run test:types
```

Then build and check the example, return to the root and run the production HTTP tests:

```sh
cd examples/example-graphql-upload-nextjs
npm ci
npm run build
npm run lint
cd ../..
npm run test:integration
```

`npm test` runs unit and integration tests using real Web Requests and Apollo. They cover early reads before upload completion, exact byte boundaries, batching, deduplication, malformed inputs, cancellation, temporary-storage failures and cleanup.

`npm run test:types` compiles the legacy consumer contracts against the package's generated declarations. `npm run test:integration` launches a temporary Next.js production server, checks both endpoints and downloads, proves early destination writes over HTTP and verifies cleanup on disconnect. It then stops its test server. CI runs package tests on Node.js 22, 24 and 26, and the production example checks on Node.js 24.

### Known verification limits

For synthetic server requests, encode client `FormData` first or provide an explicit byte stream. Node.js 24.22.1's bundled native `FormData` encoder can emit an unhandled error if its generated body is cancelled, reproducible without this package. That reproducer uses a synthetic outgoing body, whereas incoming Next.js HTTP bodies are covered by the production tests. The test runner still treats unhandled errors as failures.

The source build type-checks the package's TypeScript. The consumer type check verifies the generated public API with `skipLibCheck` enabled, matching the example's Next.js configuration. A full transitive declaration check currently reports errors in Next.js's bundled declarations and missing ambient React types. Those errors also reproduce when importing `next/server.js` alone, so that check isn't claimed to pass.

For further project information, see [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).

## Licence and acknowledgements

This project is licensed under the MIT Licence. See [LICENSE](LICENSE) for the licence text.

Thanks to [jaydenseric](https://github.com/jaydenseric) for the GraphQL multipart request spec and [graphql-upload](https://github.com/jaydenseric/graphql-upload), which uses Busboy and fs-capacitor for its streaming architecture. Thanks also to [meabed](https://github.com/meabed) for [graphql-upload-ts](https://github.com/meabed/graphql-upload-ts), a very useful reference.

Finally, a very sincere thanks to my Mum for her ongoing support, which has enabled me to devote my time to open source.
