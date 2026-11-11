# Testing

## Tools

- Vitest runs the suite in `test/index.test.ts`.
- The test file imports the public API from `../src/index.js`, mocks `node:child_process` with `vi.mock`, and uses `@modelcontextprotocol/sdk` `Client` with `InMemoryTransport.createLinkedPair()` for server tests. `StdioServerTransport` is mocked for the `run` CLI tests.

## Commands

```sh
npx vitest run test/index.test.ts
npx vitest test/index.test.ts
```

## Rules

- Tests go through `src/index.ts` and assert observable behavior: return values, exact git argument vectors, environment flags, thrown error codes/messages, MCP tool results and CLI return codes.
- Validation tests assert that invalid refs, paths and `maxCount` values never call the runner.
- Mock runners are used for tool-level behavior; `nodeGitRunner` is tested separately with a mocked child process, including stdout/stderr bounding, UTF-8 truncation lookahead, spawn errors and timeout killing.
- Edge cases covered include an empty log, refs with `^` and `~`, paths with spaces, non-ASCII blame authors, binary diff text, UTF-8-boundary truncation and malformed or truncated log records.
- Server tests assert that `tools/list` returns exactly `git_blame`, `git_diff` and `git_log`, each with `annotations.readOnlyHint: true` and `openWorldHint: false`, and that errors are returned with `isError: true`.
- Tests are deterministic: no real git process, network or filesystem repository is required; fake timers are used for the timeout test.

## Tiers

All tests are in the single Vitest suite `test/index.test.ts`. The supplied code has no separate conformance tier, external-tool setup or CI-only test file.

## Reports

Vitest reports pass/fail to the console. The test file does not write coverage or other report artifacts.
