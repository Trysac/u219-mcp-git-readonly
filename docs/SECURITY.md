# Security

## Threat model

The server executes only fixed read-only `git log`, `git diff` and `git blame` commands on behalf of an MCP client connected over stdio. It never uses a shell; `nodeGitRunner` calls `spawn('git', args)` with `stdio: ['ignore', 'pipe', 'pipe']`.

Defended:

- **Argument injection through refs or paths.** Refs are limited to 1–200 characters from `[A-Za-z0-9._/@^~-]` and must not start with `-` or `/`, contain `..` or `@{`, or end with `.lock`. Paths are limited to 1–1024 characters and must be relative; backslashes, NUL bytes, empty/`.`/`..` segments and segments starting with `:` are rejected. All revisions follow `--end-of-options`; all paths follow `--`.
- **Path traversal and absolute paths.** Absolute paths, backslash separators, NUL bytes and traversal segments are rejected before the runner is called.
- **Pathspec magic.** `GIT_LITERAL_PATHSPECS=1` is set and paths beginning with `:` or with a `:`-prefixed segment are rejected.
- **Repository-configured external diff and textconv drivers.** `git diff` uses `--no-ext-diff`, `--no-textconv` and `--no-color`; `git blame` uses `--no-textconv`.
- **Pagers and credential prompts.** `--no-pager` and `GIT_TERMINAL_PROMPT=0` are set for every command. `GIT_CONFIG_NOSYSTEM=1` skips system git configuration in the child process.
- **Unbounded output and hung processes.** The default timeout is 10,000 ms per command; a timeout kills the child with `SIGKILL` and raises `GitToolError` with code `timeout`. Stdout is capped at `maxOutputBytes` (default 1,048,576 bytes) on a UTF-8 boundary; stderr is capped at 10,000 characters in the runner, and thrown git-failure messages use at most 200 trimmed characters. Tool text marks truncation with a final `[truncated]` line.

## Out of scope / not defended

- Vulnerabilities in the git binary itself.
- Malicious hooks or filters in configuration other than those disabled by the fixed flags. The commands used here do not run commit hooks, but user/global git configuration can still be read because `HOME` is passed through; only the system configuration is skipped with `GIT_CONFIG_NOSYSTEM=1`.
- Secrets already committed to the repository; this server is read-only, not a secret scanner.
- Write operations, working-tree status (which can trigger fsmonitor hooks) and multi-repository access.

## Reporting

Please report security issues via the repository's private vulnerability reporting mechanism.
