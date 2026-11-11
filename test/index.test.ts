import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  createGitTools,
  createServer,
  type GitRunner,
  GitToolError,
  nodeGitRunner,
  run,
} from "../src/index.js";

const stdioMock = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class StdioServerTransport {
    start = stdioMock.start;
    connect = stdioMock.connect;
  },
}));

const mockRunner = (impl: GitRunner) => vi.fn(impl);

function createOkRunner(
  stdout: Buffer | string,
  truncated = false,
  timedOut = false,
  code = 0,
  stderr = "",
): GitRunner {
  return async () => ({
    code,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr,
    truncated,
    timedOut,
  });
}

function hexOfLength(len: number): string {
  return "a".repeat(len);
}

describe("createGitTools", () => {
  describe("validation", () => {
    it.each([
      "--output=/tmp/x",
      "-p",
      "main..dev",
      "a b",
      "/absolute",
      "ends.lock",
      "contains@{bad}",
      "",
    ])("rejects invalid ref %j", async (ref) => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog({ ref })).rejects.toThrowError(GitToolError);
      await expect(tools.gitDiff({ from: ref, to: "HEAD" })).rejects.toThrowError(GitToolError);
      await expect(tools.gitBlame({ path: "a.txt", ref })).rejects.toThrowError(GitToolError);
      expect(runner).not.toHaveBeenCalled();
    });

    it.each([
      "../etc/passwd",
      "/etc/passwd",
      ":(glob)*",
      "a/../../b",
      "\\evil",
      "a//b",
      ".",
      "..",
      `:${"a".repeat(10)}`,
    ])("rejects invalid path %j", async (path) => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog({ path })).rejects.toThrowError(GitToolError);
      await expect(tools.gitDiff({ from: "HEAD~1", to: "HEAD", path })).rejects.toThrowError(
        GitToolError,
      );
      await expect(tools.gitBlame({ path })).rejects.toThrowError(GitToolError);
      expect(runner).not.toHaveBeenCalled();
    });

    it("rejects maxCount outside 1..100 or non-integer", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog({ maxCount: 0 })).rejects.toThrowError(GitToolError);
      await expect(tools.gitLog({ maxCount: 101 })).rejects.toThrowError(GitToolError);
      await expect(tools.gitLog({ maxCount: 1.5 })).rejects.toThrowError(GitToolError);
      expect(runner).not.toHaveBeenCalled();
    });

    it("reports stable error codes for each validation failure", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog({ ref: "-p" })).rejects.toMatchObject({ code: "invalid_ref" });
      await expect(tools.gitDiff({ from: "../etc/passwd", to: "HEAD" })).rejects.toMatchObject({
        code: "invalid_ref",
      });
      await expect(tools.gitBlame({ path: "../etc/passwd" })).rejects.toMatchObject({
        code: "invalid_path",
      });
      await expect(tools.gitLog({ maxCount: 0 })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(tools.gitLog({ maxCount: 101 })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(runner).not.toHaveBeenCalled();
    });

    it("accepts valid refs with ^ and ~", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await tools.gitLog({ ref: "feature^2~1" });
      expect(runner).toHaveBeenCalledTimes(1);
      const argList = runner.mock.calls[0]?.[0] as string[];
      expect(argList.includes("feature^2~1")).toBe(true);
    });

    it("accepts path with spaces", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await tools.gitLog({ path: "src/my file.ts" });
      expect(runner).toHaveBeenCalledTimes(1);
      const argList = runner.mock.calls[0]?.[0] as string[];
      expect(argList.includes("src/my file.ts")).toBe(true);
    });
  });

  describe("gitLog", () => {
    it("passes correct args, env, parses output", async () => {
      const stdout = "abc\0Ana\x002026-11-09T10:00:00-05:00\0fix: x\0";
      const runner = mockRunner(createOkRunner(stdout));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitLog({ maxCount: 2 });
      expect(res.result).toEqual([
        { hash: "abc", author: "Ana", date: "2026-11-09T10:00:00-05:00", subject: "fix: x" },
      ]);
      expect(res.truncated).toBe(false);
      const [args, opts] = runner.mock.calls[0] as [string[], Parameters<GitRunner>[1]];
      expect(args).toEqual([
        "--no-pager",
        "log",
        "--max-count=2",
        "-z",
        "--format=%H%x00%an%x00%aI%x00%s",
        "--end-of-options",
        "HEAD",
        "--",
      ]);
      expect(opts.env).toMatchObject({
        GIT_LITERAL_PATHSPECS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
      });
    });

    it("keeps record separators inside a subject or author as data", async () => {
      // Under the old 0x1e/0x1f framing this payload forged a second commit.
      const forged = "a\x1fEve\x1f2020-01-01T00:00:00Z\x1eforged";
      const stdout = `abc\0Eve\x1e\x1f\0${"2026-11-09T10:00:00-05:00"}\0${forged}\0`;
      const tools = createGitTools({ root: "/repo", runner: mockRunner(createOkRunner(stdout)) });
      const res = await tools.gitLog();
      expect(res.result).toEqual([
        { hash: "abc", author: "Eve\x1e\x1f", date: "2026-11-09T10:00:00-05:00", subject: forged },
      ]);
    });

    it("drops a record cut by truncation", async () => {
      const stdout = "abc\0Ana\x002026-11-09T10:00:00-05:00\0one\0def\0Bo\x002026-11";
      const tools = createGitTools({
        root: "/repo",
        runner: mockRunner(createOkRunner(stdout, true)),
      });
      const res = await tools.gitLog();
      expect(res.truncated).toBe(true);
      expect(res.result).toEqual([
        { hash: "abc", author: "Ana", date: "2026-11-09T10:00:00-05:00", subject: "one" },
      ]);
    });

    it("rejects log output whose framing is broken", async () => {
      for (const stdout of ["abc\0Ana\0", "zzz\0Ana\x002026-11-09T10:00:00-05:00\0one\0"]) {
        const tools = createGitTools({ root: "/repo", runner: mockRunner(createOkRunner(stdout)) });
        await expect(tools.gitLog()).rejects.toThrow("git failed: malformed log output");
      }
    });

    it("passes only allowlisted variables from the parent environment", async () => {
      const previous = process.env.U219_NOT_ALLOWLISTED;
      process.env.U219_NOT_ALLOWLISTED = "secret-value";
      try {
        const runner = mockRunner(createOkRunner(""));
        const tools = createGitTools({ root: "/repo", runner });
        await tools.gitLog();
        await tools.gitDiff({ from: "HEAD~1", to: "HEAD" });
        const allowed = new Set([
          "PATH",
          "HOME",
          "SYSTEMROOT",
          "TEMP",
          "GIT_LITERAL_PATHSPECS",
          "GIT_TERMINAL_PROMPT",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_OPTIONAL_LOCKS",
        ]);
        expect(runner).toHaveBeenCalledTimes(2);
        for (const call of runner.mock.calls) {
          const env = (call as [string[], Parameters<GitRunner>[1]])[1].env;
          expect(env).not.toHaveProperty("U219_NOT_ALLOWLISTED");
          expect(Object.values(env)).not.toContain("secret-value");
          for (const key of Object.keys(env)) expect(allowed.has(key), key).toBe(true);
        }
      } finally {
        if (previous === undefined) delete process.env.U219_NOT_ALLOWLISTED;
        else process.env.U219_NOT_ALLOWLISTED = previous;
      }
    });

    it("defaults maxCount to 20", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      await tools.gitLog();
      const args = runner.mock.calls[0]?.[0] ?? [];
      expect(args[2]).toBe("--max-count=20");
    });

    it("handles empty log", async () => {
      const runner = mockRunner(createOkRunner(""));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitLog();
      expect(res.result).toEqual([]);
    });

    it("cuts a multi-byte payload on a UTF-8 boundary", async () => {
      // 20 repetitions of "aé" (1 + 2 bytes each); a 2-byte cut would split é.
      const stdout = Buffer.from("aé".repeat(20));
      const runner = mockRunner(createOkRunner(stdout));
      const tools = createGitTools({ root: "/repo", runner, maxOutputBytes: 2 });
      const res = await tools.gitLog({ maxCount: 3 });
      // The cut drops the incomplete é, leaving only the ASCII "a".
      expect(res.truncated).toBe(true);
      expect(res.result).toEqual([]);
    });

    it("throws timeout error when runner timedOut", async () => {
      const runner = mockRunner(async () => ({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: "",
        truncated: false,
        timedOut: true,
      }));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog()).rejects.toThrowError(GitToolError);
    });

    it("throws generic error for git failure with stderr capped", async () => {
      const runner = mockRunner(createOkRunner("", false, false, 128, "fatal: bad revision"));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitLog()).rejects.toThrowError("git failed: fatal: bad revision");
    });
  });

  describe("gitDiff", () => {
    it("passes correct args and env, returns raw text", async () => {
      const diffText = "diff --git a/a.txt b/a.txt\n";
      const runner = mockRunner(createOkRunner(diffText));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitDiff({ from: "HEAD~1", to: "HEAD", path: "src/a.ts" });
      expect(res.result).toBe(diffText);
      expect(res.truncated).toBe(false);
      const [args, opts] = runner.mock.calls[0] as [string[], Parameters<GitRunner>[1]];
      expect(args).toEqual([
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--end-of-options",
        "HEAD~1",
        "HEAD",
        "--",
        "src/a.ts",
      ]);
      expect(opts.env).toMatchObject({
        GIT_LITERAL_PATHSPECS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      });
    });

    it("returns a binary diff verbatim", async () => {
      const diffText =
        "diff --git a/img.png b/img.png\n" +
        "index 1111111..2222222 100644\n" +
        "Binary files a/img.png and b/img.png differ\n";
      const runner = mockRunner(createOkRunner(diffText));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitDiff({ from: "HEAD~1", to: "HEAD", path: "img.png" });
      expect(res.result).toBe(diffText);
      expect(res.truncated).toBe(false);
    });

    it("keeps the diff text on a UTF-8 boundary when truncated", async () => {
      // A 2-byte cap splits the first "é"; only the ASCII "a" may survive.
      const stdout = Buffer.from("aé".repeat(20));
      const runner = mockRunner(createOkRunner(stdout));
      const tools = createGitTools({ root: "/repo", runner, maxOutputBytes: 2 });
      const res = await tools.gitDiff({ from: "HEAD~1", to: "HEAD" });
      expect(res.truncated).toBe(true);
      expect(res.result).toBe("a");
      expect(Buffer.byteLength(res.result, "utf8")).toBe(1);
      expect(res.result.includes("\uFFFD")).toBe(false);
    });

    it("cuts exactly at the byte cap when the boundary is clean", async () => {
      const asciiRunner = mockRunner(createOkRunner("abcdef"));
      const asciiTools = createGitTools({
        root: "/repo",
        runner: asciiRunner,
        maxOutputBytes: 3,
      });
      const asciiRes = await asciiTools.gitDiff({ from: "HEAD~1", to: "HEAD" });
      expect(asciiRes.result).toBe("abc");
      expect(asciiRes.truncated).toBe(true);

      const multiRunner = mockRunner(createOkRunner(Buffer.from("aé".repeat(20))));
      const multiTools = createGitTools({
        root: "/repo",
        runner: multiRunner,
        maxOutputBytes: 3,
      });
      const multiRes = await multiTools.gitDiff({ from: "HEAD~1", to: "HEAD" });
      expect(multiRes.result).toBe("aé");
      expect(Buffer.byteLength(multiRes.result, "utf8")).toBe(3);
      expect(multiRes.truncated).toBe(true);
    });

    it("returns truncated flag with appended marker in server formatting", async () => {
      const runner = mockRunner(createOkRunner("diff text", true));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitDiff({ from: "HEAD~1", to: "HEAD" });
      expect(res.truncated).toBe(true);
      // The server formatting adds the marker.
    });

    it("throws timeout error when runner timedOut", async () => {
      const runner = mockRunner(async () => ({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: "",
        truncated: false,
        timedOut: true,
      }));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitDiff({ from: "HEAD~1", to: "HEAD" })).rejects.toThrowError(
        GitToolError,
      );
    });

    it("throws generic error on git failure", async () => {
      const runner = mockRunner(createOkRunner("", false, false, 128, "fatal: bad revision"));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitDiff({ from: "HEAD~1", to: "HEAD" })).rejects.toThrowError(
        "git failed: fatal: bad revision",
      );
    });
  });

  describe("gitBlame", () => {
    it("passes correct args, parses porcelain output", async () => {
      const sha = hexOfLength(40);
      const stdout = `${sha} 1 1\nauthor Ana\n\tconst a = 1;\n`;
      const runner = mockRunner(createOkRunner(stdout));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitBlame({ path: "src/a.ts" });
      expect(res.result).toEqual([
        { line: 1, commit: sha, author: "Ana", content: "const a = 1;" },
      ]);
      expect(res.truncated).toBe(false);
      const args = runner.mock.calls[0]?.[0] ?? [];
      expect(args).toEqual([
        "--no-pager",
        "blame",
        "--porcelain",
        "--no-textconv",
        "--end-of-options",
        "HEAD",
        "--",
        "src/a.ts",
      ]);
    });

    it("handles non-ASCII author", async () => {
      const sha = hexOfLength(40);
      const stdout = `${sha} 1 1\nauthor Jānis Bērziņš\n\tlet a = 2;\n`;
      const runner = mockRunner(createOkRunner(stdout));
      const tools = createGitTools({ root: "/repo", runner });
      const res = await tools.gitBlame({ path: "file.txt" });
      expect(res.result[0]?.author).toBe("Jānis Bērziņš");
    });

    it("throws timeout error when runner timedOut", async () => {
      const runner = mockRunner(async () => ({
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: "",
        truncated: false,
        timedOut: true,
      }));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitBlame({ path: "a.txt" })).rejects.toThrowError(GitToolError);
    });

    it("throws generic error on git failure", async () => {
      const runner = mockRunner(createOkRunner("", false, false, 128, "fatal: bad revision"));
      const tools = createGitTools({ root: "/repo", runner });
      await expect(tools.gitBlame({ path: "a.txt" })).rejects.toThrowError(
        "git failed: fatal: bad revision",
      );
    });
  });
});

describe("nodeGitRunner", () => {
  const makeFakeChild = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  };

  const opts = (overrides: Partial<Parameters<GitRunner>[1]> = {}): Parameters<GitRunner>[1] => ({
    cwd: "/repo",
    env: { PATH: "/usr/bin" },
    timeoutMs: 10_000,
    maxOutputBytes: 4,
    ...overrides,
  });

  it("spawns git without a shell and bounds stdout and stderr", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const promise = nodeGitRunner(["log"], opts());
    child.stdout.emit("data", Buffer.from("abcd"));
    child.stdout.emit("data", Buffer.from("ef"));
    child.stdout.emit("data", Buffer.from("gh"));
    child.stderr.emit("data", Buffer.from("x".repeat(12_000)));
    child.emit("close", 128);
    const res = await promise;
    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      ["log"],
      expect.objectContaining({ cwd: "/repo", stdio: ["ignore", "pipe", "pipe"] }),
    );
    // The runner keeps up to `maxOutputBytes + 4` lookahead bytes for the tool
    // layer, which performs the final UTF-8-boundary trim.
    expect(res.stdout.toString()).toBe("abcdefgh");
    expect(res.truncated).toBe(true);
    expect(res.code).toBe(128);
    expect(res.stderr).toHaveLength(10_000);
    expect(res.timedOut).toBe(false);
  });

  it("keeps lookahead so a chunk ending mid code point can be trimmed", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const tools = createGitTools({
      root: "/repo",
      runner: nodeGitRunner,
      maxOutputBytes: 2,
    });
    const pending = tools.gitDiff({ from: "HEAD~1", to: "HEAD" });
    // "aéx" cut at 2 bytes would split the 2-byte é.
    child.stdout.emit("data", Buffer.from("aéx"));
    child.stdout.emit("data", Buffer.from("yz"));
    child.emit("close", 0);
    const res = await pending;
    expect(res.truncated).toBe(true);
    expect(res.result).toBe("a");
  });

  it("rejects when the process cannot be spawned", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const promise = nodeGitRunner([], opts());
    child.emit("error", new Error("spawn failed"));
    await expect(promise).rejects.toThrow("spawn failed");
  });

  it("kills the process and reports a timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const promise = nodeGitRunner([], opts({ timeoutMs: 10 }));
      vi.advanceTimersByTime(20);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
      const res = await promise;
      expect(res.timedOut).toBe(true);
      expect(res.code).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createServer", () => {
  const setupServer = async (runner: GitRunner) => {
    const server = createServer({ root: "/repo", runner });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    // Connect the server side first so it can answer the client's requests.
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  };

  it("tools/list returns exactly the three tools with correct annotations", async () => {
    const runner = mockRunner(createOkRunner(""));
    const { client } = await setupServer(runner);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(["git_blame", "git_diff", "git_log"]);
    for (const tool of list.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  it("git failure produces isError with capped stderr", async () => {
    const runner = mockRunner(createOkRunner("", false, false, 128, "fatal: bad revision"));
    const { client } = await setupServer(runner);
    const result = await client.callTool({ name: "git_log", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as unknown as Array<{ type: "text"; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toBe("git failed: fatal: bad revision");
  });

  it("formats truncated results with [truncated] suffix", async () => {
    const logStdout = `abc${String.fromCharCode(31)}A${String.fromCharCode(31)}D${String.fromCharCode(31)}S${String.fromCharCode(30)}`;
    const runner = mockRunner(createOkRunner(logStdout, true));
    const { client } = await setupServer(runner);
    const result = await client.callTool({ name: "git_log", arguments: { maxCount: 1 } });
    const content = result.content as unknown as Array<{ type: "text"; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text.endsWith("\n[truncated]")).toBe(true);
  });

  it("returns raw diff text and appends the truncation marker", async () => {
    const runner = mockRunner(createOkRunner("diff --git a/a b/a\n", true));
    const { client } = await setupServer(runner);
    const result = await client.callTool({
      name: "git_diff",
      arguments: { from: "HEAD~1", to: "HEAD" },
    });
    const content = result.content as unknown as Array<{ type: "text"; text: string }>;
    expect(content[0]?.text).toBe("diff --git a/a b/a\n\n[truncated]");
  });

  it("appends the truncation marker to a truncated binary diff", async () => {
    const binaryDiff =
      "diff --git a/img.png b/img.png\n" +
      "index 1111111..2222222 100644\n" +
      "Binary files a/img.png and b/img.png differ\n";
    const runner = mockRunner(createOkRunner(binaryDiff, true));
    const { client } = await setupServer(runner);
    const result = await client.callTool({
      name: "git_diff",
      arguments: { from: "HEAD~1", to: "HEAD" },
    });
    const content = result.content as unknown as Array<{ type: "text"; text: string }>;
    expect(content[0]?.text).toBe(`${binaryDiff}\n[truncated]`);
  });

  it("returns parsed blame entries", async () => {
    const sha = hexOfLength(40);
    const runner = mockRunner(createOkRunner(`${sha} 1 1\nauthor Ana\n\tconst a = 1;\n`));
    const { client } = await setupServer(runner);
    const result = await client.callTool({
      name: "git_blame",
      arguments: { path: "src/a.ts" },
    });
    const content = result.content as unknown as Array<{ type: "text"; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "")).toEqual([
      { line: 1, commit: sha, author: "Ana", content: "const a = 1;" },
    ]);
  });

  it("reports invalid arguments from git_diff and git_blame as errors", async () => {
    const runner = mockRunner(createOkRunner(""));
    const { client } = await setupServer(runner);
    const diffResult = await client.callTool({
      name: "git_diff",
      arguments: { from: "-p", to: "HEAD" },
    });
    expect(diffResult.isError).toBe(true);
    const blameResult = await client.callTool({
      name: "git_blame",
      arguments: { path: "../etc/passwd" },
    });
    expect(blameResult.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("run", () => {
  it("writes usage to stderr and returns 2 for invalid args", async () => {
    const stderrChunks: string[] = [];
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        stderrChunks.push(chunk.toString());
        cb();
      },
    });
    const code = await run([], { stdout: new Writable(), stderr });
    expect(code).toBe(2);
    expect(stderrChunks.join("")).toContain("usage: mcp-git-readonly --repo <path>");
  });

  it("accepts --repo and attempts to start server (mocked transport)", async () => {
    stdioMock.start.mockClear();
    const code = await run(["--repo", "/some/repo"], {
      stdout: new Writable(),
      stderr: new Writable(),
    });
    expect(stdioMock.start).toHaveBeenCalled();
    expect(code).toBe(0);
  });
});
