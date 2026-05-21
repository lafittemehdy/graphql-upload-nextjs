# Contributing

Thank you for dedicating time to improve `graphql-upload-nextjs`.

## Development Setup

Initialize, build, and test the core package:

```bash
npm install
npm run build
npm test

```

Verify the example application independently:

```bash
cd examples/example-graphql-upload-nextjs
npm install
npm run build
npm run lint

```

## Pull Requests

We maintain strict engineering standards for incoming code:

* Keep scope tight. Maintain public API compatibility unless breaking changes are explicitly discussed in advance.
* Write or update tests to cover any behavioral changes.
* Pass the root build and test suite entirely before opening a pull request.
* Update the README when altering user-facing behavior, configuration options, or examples.
* Exclude generated tarballs, local upload outputs, and dependency directories from your commits.

## Reporting Issues

Clear, reproducible reports lead to faster fixes. When opening an issue, please include:

* The `graphql-upload-nextjs` package version.
* Your active Node.js and Next.js versions.
* A minimal reproduction repository or the exact request payload.
* A concise description of the expected and actual behavior.

For security vulnerabilities, please refer directly to `SECURITY.md` for proper disclosure steps.