import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Separator between log records. */
const RECORD_SEPARATOR = "\x1e";
/** Separator between fields inside a log record. */
const FIELD_SEPARATOR = "\x1f";

/** Default git process timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default maximum number of bytes read from git's stdout. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Maximum allowed length for a git ref. */
export const MAX_REF_LENGTH = 200;
/** Maximum allowed length for a repository-relative path. */
export const MAX_PATH_LENGTH = 1024;

/** Fixed set of environment keys passed to the child process. */
const ALLOWED_ENV_KEYS = ["PATH", "HOME", "SYSTEMROOT", "TEMP"] as const;

/**
 * Type of a function that runs a git command and returns its output in a
 * structured form. Implementations must not use a shell and must bound memory
 * and execution time.
 */
export type GitRunner = (
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<{
  code: number;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}>;

/** Error thrown for invalid tool arguments or timeouts. */
export class GitToolError extends Error {
  readonly code: "invalid_ref" | "invalid_path" | "invalid_argument" | "timeout";

  constructor(code: GitToolError["code"], message: string) {
    super(message);
    this.name = "GitToolError";
    this.code = code;
  }
}

/**
 * Default runner using `child_process.spawn('git', args)` without a shell.
 * The spawned process inherits a restricted environment, output is truncated
 * to `maxOutputBytes` on a UTF-8 boundary, and execution time is bounded by
 * `timeoutMs`.
 */
export const nodeGitRunner: GitRunner = (args, opts) => {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Keep a few bytes beyond the cap so that a code point straddling the
    // limit can still be trimmed correctly by the tool layer.
    const limit = opts.maxOutputBytes;
    const readLimit = limit + 4;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLength >= readLimit) {
        truncated = true;
        return;
      }
      const room = readLimit - stdoutLength;
      if (chunk.length <= room) {
        stdoutChunks.push(chunk);
        stdoutLength += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutLength += room;
        truncated = true;
      }
      if (stdoutLength > limit) truncated = true;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Bound stderr memory to avoid unbounded growth.
      if (stderr.length < 10_000) {
        stderr += chunk.toString("utf8");
        if (stderr.length > 10_000) stderr = stderr.slice(0, 10_000);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      resolve({
        code: code ?? 1, // If killed before exit, report a non-zero code.
        stdout,
        stderr,
        truncated,
        timedOut,
      });
    });
  });
};

/**
 * Cuts a buffer to at most `max` bytes without splitting a UTF-8 code point,
 * reporting whether the output had to be truncated. `truncated` carries a
 * pre-existing truncation signal from the runner (which may keep a few
 * lookahead bytes past the cap and may already have flagged the cut).
 */
function boundOutput(
  buf: Buffer,
  max: number,
  truncated: boolean,
): { stdout: Buffer; truncated: boolean } {
  if (buf.length <= max) return { stdout: buf, truncated };
  let end = max;
  // Walk back over at most three continuation bytes (0b10xxxxxx) to find the
  // lead byte of the code point that straddles the cut.
  let leadIndex = end - 1;
  let continuations = 0;
  while (leadIndex >= 0 && continuations < 3 && ((buf[leadIndex] ?? 0) & 0xc0) === 0x80) {
    leadIndex--;
    continuations++;
  }
  if (leadIndex < 0) {
    end = 0;
  } else {
    const lead = buf[leadIndex] ?? 0;
    let needed = 1;
    if ((lead & 0xe0) === 0xc0) needed = 2;
    else if ((lead & 0xf0) === 0xe0) needed = 3;
    else if ((lead & 0xf8) === 0xf0) needed = 4;
    if (end - leadIndex < needed) end = leadIndex;
  }
  return { stdout: buf.subarray(0, end), truncated: true };
}

/** Validates a git ref according to the strict rules of this library. */
function isValidRef(ref: string): boolean {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("@{")) return false;
  if (ref.endsWith(".lock")) return false;
  return /^[A-Za-z0-9._/@^~-]+$/.test(ref);
}

/** Validates a repository-relative path; rejects absolute, traversal and pathspec magic. */
function isValidPath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith(":")) return false;

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.startsWith(":")) return false; // Disable pathspec magic (e.g. `:(glob)*`).
  }
  return true;
}

/** A parsed entry from `git log`. */
export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** A parsed entry from `git blame --porcelain`. */
export interface GitBlameEntry {
  line: number;
  commit: string;
  author: string;
  content: string;
}

/** Generic tool result wrapper carrying the `truncated` flag. */
export interface GitToolResult<T> {
  result: T;
  truncated: boolean;
}

export interface GitToolsOptions {
  /** Absolute path to the git repository. */
  root: string;
  /** Custom runner for testing; defaults to {@link nodeGitRunner}. */
  runner?: GitRunner;
  /** Per-command timeout in milliseconds; defaults to 10_000. */
  timeoutMs?: number;
  /** Maximum stdout bytes to read; defaults to 1_048_576. */
  maxOutputBytes?: number;
}

/**
 * Creates the three read-only git tools. Each tool validates its arguments
 * strictly and invokes git with a fixed, shell-free argument vector.
 */
export function createGitTools(opts: GitToolsOptions) {
  const root = opts.root;
  const runner = opts.runner ?? nodeGitRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  /** Builds the restricted environment for the child process. */
  const buildEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key] as string;
    }
    env.GIT_LITERAL_PATHSPECS = "1";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_OPTIONAL_LOCKS = "0";
    return env;
  };

  /** Runs a git command with the configured runner and environment. */
  const runGit = async (
    args: string[],
  ): Promise<{
    code: number;
    stdout: Buffer;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }> => {
    const res = await runner(args, {
      cwd: root,
      env: buildEnv(),
      timeoutMs,
      maxOutputBytes,
    });
    // Bound the output here too, so custom runners cannot hand back more than
    // the configured maximum (on a UTF-8 boundary).
    const bounded = boundOutput(res.stdout, maxOutputBytes, res.truncated);
    return {
      ...res,
      stdout: bounded.stdout,
      truncated: bounded.truncated,
    };
  };

  /** Parses the custom log format used by this library. */
  const parseLog = (stdout: Buffer, truncated: boolean): GitLogEntry[] => {
    const text = stdout.toString("utf8");
    const records = text.split(RECORD_SEPARATOR);
    const entries: GitLogEntry[] = [];
    for (const record of records) {
      if (record.length === 0) continue;
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length !== 4) continue; // Skip malformed records.
      const [hash, author, date, subject] = fields;
      if (
        hash === undefined ||
        author === undefined ||
        date === undefined ||
        subject === undefined
      ) {
        continue;
      }
      entries.push({ hash, author, date, subject });
    }
    // When truncated and the last record lacks its terminator, discard it.
    if (truncated && !text.endsWith(RECORD_SEPARATOR) && entries.length > 0) {
      entries.pop();
    }
    return entries;
  };

  /** Parses `git blame --porcelain` output into line entries. */
  const parseBlame = (stdout: Buffer): GitBlameEntry[] => {
    const text = stdout.toString("utf8");
    const lines = text.split("\n");
    const entries: GitBlameEntry[] = [];
    let currentCommit = "";
    let currentAuthor = "";
    let currentLine = 0;

    for (const rawLine of lines) {
      if (rawLine.length === 0) continue;
      if (rawLine.startsWith("\t")) {
        // Content line; the preceding tab is removed.
        const content = rawLine.slice(1);
        currentLine++;
        entries.push({
          line: currentLine,
          commit: currentCommit,
          author: currentAuthor,
          content,
        });
        continue;
      }
      if (rawLine.startsWith("author ")) {
        currentAuthor = rawLine.slice("author ".length);
        continue;
      }
      // Header like `<sha> <orig> <final> [<count>]`; capture commit and final line number.
      const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(rawLine);
      if (header !== null) {
        const commit = header[1];
        const finalLine = Number(header[2]);
        if (commit !== undefined && Number.isInteger(finalLine)) {
          currentCommit = commit;
          currentLine = finalLine - 1; // Will be incremented before first content line.
        }
      }
      // Other porcelain lines (committer, summary, etc.) are ignored.
    }
    return entries;
  };

  /** Converts a git error into a plain Error with a bounded message. */
  const gitFailure = (stderr: string): never => {
    const trimmed = stderr.trim().slice(0, 200);
    throw new Error(`git failed: ${trimmed}`);
  };

  return {
    /**
     * Retrieves the commit log with optional ref, path and max count.
     * @param a.ref - Git ref (default `HEAD`).
     * @param a.path - Repository-relative path filter (optional).
     * @param a.maxCount - Maximum number of commits (1-100, default 20).
     */
    async gitLog(
      a: {
        ref?: string | undefined;
        path?: string | undefined;
        maxCount?: number | undefined;
      } = {},
    ): Promise<GitToolResult<GitLogEntry[]>> {
      const ref = a.ref ?? "HEAD";
      const path = a.path;
      const maxCount = a.maxCount ?? 20;

      if (!isValidRef(ref)) {
        throw new GitToolError("invalid_ref", `invalid ref: ${ref.slice(0, 200)}`);
      }
      if (path !== undefined && !isValidPath(path)) {
        throw new GitToolError("invalid_path", `invalid path: ${path.slice(0, 200)}`);
      }
      if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 100) {
        throw new GitToolError(
          "invalid_argument",
          `maxCount must be an integer between 1 and 100, got ${maxCount}`,
        );
      }

      const format = "%H%x1f%an%x1f%aI%x1f%s%x1e";
      const args = [
        "--no-pager",
        "log",
        `--max-count=${maxCount}`,
        `--format=${format}`,
        "--end-of-options",
        ref,
        "--",
      ];
      if (path !== undefined) args.push(path);

      const res = await runGit(args);
      if (res.timedOut) {
        throw new GitToolError("timeout", "git log timed out");
      }
      if (res.code !== 0) {
        gitFailure(res.stderr);
      }
      const entries = parseLog(res.stdout, res.truncated);
      return { result: entries, truncated: res.truncated };
    },

    /**
     * Produces a raw diff between two refs, optionally filtered by path.
     */
    async gitDiff(a: {
      from: string;
      to: string;
      path?: string | undefined;
    }): Promise<GitToolResult<string>> {
      if (!isValidRef(a.from)) {
        throw new GitToolError("invalid_ref", `invalid from ref: ${a.from.slice(0, 200)}`);
      }
      if (!isValidRef(a.to)) {
        throw new GitToolError("invalid_ref", `invalid to ref: ${a.to.slice(0, 200)}`);
      }
      if (a.path !== undefined && !isValidPath(a.path)) {
        throw new GitToolError("invalid_path", `invalid path: ${a.path.slice(0, 200)}`);
      }

      const args = [
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--end-of-options",
        a.from,
        a.to,
        "--",
      ];
      if (a.path !== undefined) args.push(a.path);

      const res = await runGit(args);
      if (res.timedOut) {
        throw new GitToolError("timeout", "git diff timed out");
      }
      if (res.code !== 0) {
        gitFailure(res.stderr);
      }
      return { result: res.stdout.toString("utf8"), truncated: res.truncated };
    },

    /**
     * Retrieves line-by-line blame information for a path, optionally at a ref.
     */
    async gitBlame(a: {
      path: string;
      ref?: string | undefined;
    }): Promise<GitToolResult<GitBlameEntry[]>> {
      if (!isValidPath(a.path)) {
        throw new GitToolError("invalid_path", `invalid path: ${a.path.slice(0, 200)}`);
      }
      const ref = a.ref ?? "HEAD";
      if (!isValidRef(ref)) {
        throw new GitToolError("invalid_ref", `invalid ref: ${ref.slice(0, 200)}`);
      }

      const args = [
        "--no-pager",
        "blame",
        "--porcelain",
        "--no-textconv",
        "--end-of-options",
        ref,
        "--",
        a.path,
      ];
      const res = await runGit(args);
      if (res.timedOut) {
        throw new GitToolError("timeout", "git blame timed out");
      }
      if (res.code !== 0) {
        gitFailure(res.stderr);
      }
      const entries = parseBlame(res.stdout);
      return { result: entries, truncated: res.truncated };
    },
  };
}

export interface CreateServerOptions extends GitToolsOptions {
  serverName?: string;
  serverVersion?: string;
}

/**
 * Creates an MCP server that registers `git_log`, `git_diff` and `git_blame`
 * as read-only tools.
 */
export function createServer(opts: CreateServerOptions) {
  const tools = createGitTools(opts);
  const server = new McpServer({
    name: opts.serverName ?? "mcp-git-readonly",
    version: opts.serverVersion ?? "1.0.0",
  });

  const formatLog = (result: GitToolResult<GitLogEntry[]>): string => {
    const text = JSON.stringify(result.result);
    return result.truncated ? `${text}\n[truncated]` : text;
  };
  const formatDiff = (result: GitToolResult<string>): string => {
    return result.truncated ? `${result.result}\n[truncated]` : result.result;
  };
  const formatBlame = (result: GitToolResult<GitBlameEntry[]>): string => {
    const text = JSON.stringify(result.result);
    return result.truncated ? `${text}\n[truncated]` : text;
  };

  server.registerTool(
    "git_log",
    {
      description: "Read-only git log of a repository.",
      inputSchema: z.object({
        ref: z.string().min(1).max(200).optional(),
        path: z.string().min(1).max(1024).optional(),
        maxCount: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const res = await tools.gitLog(args);
        return { content: [{ type: "text" as const, text: formatLog(res) }] };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      description: "Read-only git diff between two refs.",
      inputSchema: z.object({
        from: z.string().min(1).max(200),
        to: z.string().min(1).max(200),
        path: z.string().min(1).max(1024).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const res = await tools.gitDiff(args);
        return { content: [{ type: "text" as const, text: formatDiff(res) }] };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "git_blame",
    {
      description: "Read-only git blame for a file.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        ref: z.string().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const res = await tools.gitBlame(args);
        return { content: [{ type: "text" as const, text: formatBlame(res) }] };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * CLI entry point. Expects exactly `--repo <path>`.
 * Starts the stdio MCP server when the arguments are valid, otherwise
 * prints usage to stderr and returns exit code 2.
 */
export async function run(
  argv: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--repo") {
    io.stderr.write("usage: mcp-git-readonly --repo <path>\n");
    return 2;
  }
  const repo = argv[1] as string;
  const server = createServer({ root: repo });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server runs until the transport closes; this return is never reached
  // in normal operation, but provides a clean exit path for tests.
  return 0;
}
