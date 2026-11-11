# mcp-git-readonly

[![npm version](https://img.shields.io/npm/v/@trysac/mcp-git-readonly.svg)](https://www.npmjs.com/package/@trysac/mcp-git-readonly)
[![license: MIT](https://img.shields.io/npm/l/@trysac/mcp-git-readonly.svg)](LICENSE)
[![CI](https://github.com/Trysac/u219-mcp-git-readonly/actions/workflows/ci.yml/badge.svg)](https://github.com/Trysac/u219-mcp-git-readonly/actions/workflows/ci.yml)

Read-only MCP server for one git repository with log, diff and blame tools, argument-injection-safe refs and paths, no external diff drivers and capped output

## Problem

Describe in two or three sentences the concrete problem this utility solves, who hits it, and why existing
packages do not solve it well. Keep it factual; link to an issue or decision record when there is one.

## Install

```sh
npm install @trysac/mcp-git-readonly
```

Requires Node.js 20 or newer. The package ships ES modules with TypeScript declarations.

## Usage

```ts
import { greet } from "@trysac/mcp-git-readonly";

// Build a greeting; surrounding whitespace is ignored.
const message = greet("  Ada ");
console.log(message); // "Hello, Ada!"

try {
  greet("   ");
} catch (error) {
  console.error((error as Error).message); // "name must not be empty"
}
```

## API

| Export | Signature | Description |
|---|---|---|
| `greet` | `(name: string) => string` | Placeholder API; replace it with the real one. |

## Development

```sh
npm install
npm run check   # lint, format, types, tests with coverage, docs, secrets
```

See [AGENTS.md](AGENTS.md) for the full command list and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[MIT](LICENSE) © 2026 Miguel Gomez
