# Project record: mcp-git-readonly

## Objective

Provide an MCP server for one git repository with exactly three read-only tools: `git_log`, `git_diff` and `git_blame`. The server must validate refs and repository-relative paths before invoking the runner, use fixed git argument vectors without a shell, disable external diff/textconv drivers and pagers, and bound execution time and output size. The observable outcome is that valid calls produce the documented parsed log/blame arrays or raw diff text, invalid arguments raise `GitToolError` before the runner is called, and oversized or timed-out git processes are reported through `truncated` flags or `timeout` errors.

## Scope

In scope:

- A single repository rooted at an absolute path supplied as `root`.
- Read-only log, diff and blame operations.
- Ref validation (1–200 characters, strict allowlist and prohibited patterns) and path validation (1–1024 characters, relative, no traversal or pathspec magic).
- Fixed child-process environment and git flags: `--end-of-options`, `--no-pager`, `--no-ext-diff`, `--no-textconv`, `--no-color`, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`.
- Per-command timeout, stdout byte cap with UTF-8-boundary truncation, stderr caps and `[truncated]` markers in MCP tool text.
- Parsing of the custom git log format and `git blame --porcelain` output.
- MCP server registration of `git_log`, `git_diff` and `git_blame`, and the `run(argv, io)` CLI helper.

Out of scope:

- Write operations of any kind.
- Working-tree status (which can trigger fsmonitor hooks).
- Access to multiple repositories.
- Running a shell or accepting arbitrary git arguments.
- Secret scanning of repository contents.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Recorded values; unmeasured entries remain pending.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 3274885 / 119251 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 0.1428 | factory ledger |

## Factory run u219 (measured from API usage)

| Date (UTC) | Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-11 | generation | deepseek-v4-pro | yes | 4188 | 21961 | 0 | 1280 | 0.0463 |
| 2026-11-11 | fix-1 | deepseek-flash | no | 41513 | 23810 | 0 | 1323392 | 0.0245 |
| 2026-11-11 | fix-2 | deepseek-flash | no | 21426 | 11977 | 0 | 410624 | 0.0116 |
| 2026-11-11 | fix-3 | deepseek-flash | no | 17281 | 1102 | 0 | 36480 | 0.0034 |
| 2026-11-11 | audit | deepseek-flash | no | 32577 | 26132 | 0 | 644864 | 0.0225 |
| 2026-11-11 | fix-4 | deepseek-flash | no | 31721 | 14417 | 0 | 536960 | 0.0150 |
| 2026-11-11 | threat-model | deepseek-flash | no | 30419 | 11487 | 0 | 123648 | 0.0118 |
| 2026-11-11 | docs | deepseek-flash | no | 18128 | 8365 | 0 | 384 | 0.0077 |

Total: $0.1428. Prices: deepseek line, as measured by its adapter. Providers serve the current version of each model id, so the date tells which version answered; versions, launch stages and price sources per line are in the factory's model register (docs/MODELS.md).
