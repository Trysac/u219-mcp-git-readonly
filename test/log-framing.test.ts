import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitTools } from "../src/index.js";

// Runs real git (no mocked runner): a crafted commit must not be able to forge log records.
describe("gitLog against a real repository", () => {
  let repo = "";
  // Git trims trailing control characters, so the separators sit inside the values.
  const forgedSubject = "real\x1fEve\x1f2020-01-01T00:00:00Z\x1eforged\x1fsubject";
  const forgedAuthor = "Mal\x1elo\x1fry";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "u219-log-"));
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: { ...process.env, ...env },
        stdio: "pipe",
      });
    git(["init", "-q"]);
    const identity = (name: string) => ({
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: "a@example.test",
      GIT_COMMITTER_NAME: "c",
      GIT_COMMITTER_EMAIL: "c@example.test",
    });
    git(["commit", "-q", "--allow-empty", "-m", "first"], identity("Ana"));
    const msgFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-msg.txt`);
    writeFileSync(msgFile, `${forgedSubject}\n`);
    try {
      git(
        ["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", msgFile],
        identity(forgedAuthor),
      );
    } finally {
      rmSync(msgFile, { force: true });
    }
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("returns exactly one record per commit with control characters kept as data", async () => {
    const tools = createGitTools({ root: repo });
    const res = await tools.gitLog();
    expect(res.truncated).toBe(false);
    expect(res.result).toHaveLength(2);
    const [crafted, first] = res.result;
    expect(crafted).toMatchObject({ author: forgedAuthor, subject: forgedSubject });
    expect(crafted?.hash).toMatch(/^[0-9a-f]{40,64}$/);
    expect(first).toMatchObject({ author: "Ana", subject: "first" });
    expect(first?.hash).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
