# @trysac/mcp-git-readonly

[![npm](https://img.shields.io/npm/v/@trysac/mcp-git-readonly)](https://www.npmjs.com/package/@trysac/mcp-git-readonly)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Read-only MCP server for a single git repository. It registers exactly three tools — `git_log`, `git_diff` and `git_blame` — with strict validation for refs and repository-relative paths, fixed git argument vectors, no shell, and bounded output. `git_log` and `git_blame` return parsed arrays; `git_diff` returns raw diff text.

## Features

- **Three read-only tools** — `git_log`, `git_diff` and `git_blame`; no write operations, working-tree status or multi-repository access.
- **Argument injection defenses** — refs and paths are validated before any runner call; every command places `--end-of-options` before revisions and `--` before paths.
- **Restricted child environment** — only `PATH`, `HOME`, `SYSTEMROOT` and `TEMP` are passed through, plus `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`.
- **Bounded resources** — per-command timeout (default 10,000 ms), stdout byte cap (default 1,048,576 bytes) with UTF-8-boundary truncation, and stderr bounded to 10,000 characters in the runner and 200 characters in thrown git-failure messages.
- **Parsed and marked results** — log and blame are parsed into JSON arrays; truncated MCP tool text gets a final `[truncated]` line.

## Installation

```sh
npm install @trysac/mcp-git-readonly
```

Requires Node.js 20+ and an ESM-capable runtime.

## Usage

### As a library

```ts
import { createServer } from '@trysac/mcp-git-readonly';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createServer({ root: '/absolute/path/to/repo' });
await server.connect(new StdioServerTransport());
```

### As a library helper

`run(argv, io)` starts a stdio MCP server when `argv` is exactly `['--repo', '<path>']`. Invalid arguments write `usage: mcp-git-readonly --repo <path>` to stderr and return `2`. The supplied source does not include a bundled executable; call it from a script you control:

```ts
import { run } from '@trysac/mcp-git-readonly';

process.exitCode = await run(process.argv.slice(2), process);
```

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `git_log` | `ref?`, `path?`, `maxCount?` | JSON array of `{ hash, author, date, subject }` |
| `git_diff` | `from`, `to`, `path?` | Raw diff text |
| `git_blame` | `path`, `ref?` | JSON array of `{ line, commit, author, content }` |

`ref` defaults to `HEAD`; `maxCount` defaults to `20` and must be an integer from `1` to `100`. Ref validation allows 1–200 characters from `[A-Za-z0-9._/@^~-]`, but rejects refs starting with `-` or `/`, containing `..` or `@{`, or ending with `.lock`. Path validation allows 1–1024 characters, requires repository-relative `/` separators, and rejects absolute paths, backslashes, NUL bytes, empty/`.`/`..` segments, and any segment starting with `:`.

`createGitTools({ root, runner?, timeoutMs?, maxOutputBytes? })` returns `gitLog`, `gitDiff` and `gitBlame`. `createServer(opts)` accepts the same options plus optional `serverName` and `serverVersion`. `GitToolError` has a `code` of `invalid_ref`, `invalid_path`, `invalid_argument` or `timeout`. A non-zero git exit throws `Error('git failed: ...')` with trimmed stderr capped at 200 characters; MCP handlers return that message text with `isError: true`.

## Why not a shell tool or a git MCP server with write access

A shell tool can run arbitrary git commands and mutate the repository; general git MCP servers may expose write operations. This package exposes three read-only commands only, passes fixed argument vectors, and tests pin those vectors.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and limitations.

## Development

```sh
npm install
npx vitest run test/index.test.ts
```
