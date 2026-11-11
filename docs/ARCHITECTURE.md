# Architecture

`@trysac/mcp-git-readonly` consists of:

- **`GitRunner`** — an injectable abstraction that runs git commands and returns structured output. The default `nodeGitRunner` uses `child_process.spawn` without a shell.
- **`createGitTools`** — builds the three tool functions, each validating inputs, constructing the fixed argument vector and parsing output.
- **`createServer`** — wires the tools into an `McpServer` with read-only annotations.
- **`run`** — CLI entry point that starts the stdio MCP server.

Validation rules are centralized: refs match `[A-Za-z0-9._/@^~-]{1,200}` with additional prohibitions; paths are relative, ≤1024 characters, contain no `..` or empty segments and cannot start with `:`.

Output truncation happens at the runner level before parsing; incomplete log records are discarded.
