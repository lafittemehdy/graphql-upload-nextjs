# Next.js Example with GraphQL Upload

This example project demonstrates how to integrate GraphQL file uploads into a typical Next.js starter application created with `create-next-app`. The example uses only the `api/graphql/route` to showcase how to use the middleware and Upload scalar in this package to enable GraphQL multipart requests (file uploads via queries and mutations) with Apollo Server in a Next.js integration.

## Getting Started

To get started with this example, clone the repository and navigate to the project directory:

```bash
git clone https://github.com/lafittemehdy/graphql-upload-nextjs.git
cd graphql-upload-nextjs # Enter the project directory
cd examples/example-graphql-upload-nextjs # Navigate to the example
```

Install the dependencies:

```bash
npm install
# or
pnpm install
# or
yarn install
```

Start the development server, which includes the Apollo Studio Sandbox at `/api/graphql`:

```bash
npm run dev
# or
pnpm run dev
# or
yarn dev
```

Your application will run at [http://localhost:3000](http://localhost:3000), where you can access the homepage of the project or go directly to the sandbox at `/api/graphql`.

## Usage

This example demonstrates how to upload files using GraphQL mutations. The file upload functionality is available to test through the Apollo Sandbox, where you can try mutations and add files with the sandbox interface.

To upload a file, select a file using the file input field, set the key to the variable, and click the mutation button. The uploaded file will be stored in the `public` directory, which is not recommended for production.

## Note

This example imports `graphql-upload-nextjs` directly as a package. If you are developing the package locally, you can use `npm link` to test your changes in this example.

1.  Navigate to the root directory of the `graphql-upload-nextjs` package and run `npm link`.
2.  Navigate to this example's directory (`examples/example-graphql-upload-nextjs`) and run `npm link graphql-upload-nextjs`.

This will create a symbolic link from this project's `node_modules` to your local `graphql-upload-nextjs` package, allowing you to test your changes live.

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.