import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { produceReviewResult } from "../core/review.js";
import type { PrFile } from "../core/types.js";
import { retrieveFromWorkspace, WorkspaceError, WorkspaceSource } from "../src/workspace.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
let dir: string;
let outside: string;

function put(rel: string, text: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const changedA: PrFile = {
  path: "src/price.ts", status: "modified", additions: 1, deletions: 1,
  patch: "@@ -1,3 +1,3 @@\n-export function formatPrice(n: number) { return `$${n}`; }\n+export function formatPrice(n: number) { return `€${n}`; }\n",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mj-ws-"));
  outside = mkdtempSync(join(tmpdir(), "mj-ws-out-"));
  git(dir, "init", "-q");
  put("src/price.ts", "export function formatPrice(n: number) { return `€${n}`; }\n");
  put("src/cart.ts", "import { formatPrice } from \"./price\";\nexport const total = (n: number) => formatPrice(n);\n");
  put("src/unrelated.ts", "export const x = 1;\n");
  put(".env", "TOKEN=super-secret-value\n");
  writeFileSync(join(outside, "secret.ts"), "export const leaked = 'outside';\n");
  symlinkSync(join(outside, "secret.ts"), join(dir, "src/link.ts"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("WorkspaceSource", () => {
  it("lists tracked files and reads them", async () => {
    const src = new WorkspaceSource(dir);
    expect(await src.listPaths()).toContain("src/cart.ts");
    expect(await src.readFile("src/cart.ts")).toContain("formatPrice");
  });

  it("never reads outside the workspace (traversal, symlinks) or binary files", async () => {
    put("bin.dat", "a\0b");
    const src = new WorkspaceSource(dir);
    expect(await src.readFile("../" + outside.split("/").pop() + "/secret.ts")).toBeNull();
    expect(await src.readFile("src/link.ts")).toBeNull();
    expect(await src.readFile("bin.dat")).toBeNull();
    expect(await src.readFile("missing.ts")).toBeNull();
  });

  it("says so when the workspace is not a git checkout", async () => {
    const plain = mkdtempSync(join(tmpdir(), "mj-ws-plain-"));
    try {
      await expect(new WorkspaceSource(plain).listPaths()).rejects.toThrow(/actions\/checkout/);
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe("retrieveFromWorkspace", () => {
  const cfg = parseConfig("review:\n  mode: deep\n");

  it("returns the importer of a changed file, and never .env or the symlink target", async () => {
    const r = await retrieveFromWorkspace(dir, [changedA], cfg, "o/r", () => {});
    const paths = r.pieces.map((p) => p.path);
    expect(paths).toContain("src/cart.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("src/link.ts");
    expect(JSON.stringify(r.pieces)).not.toContain("super-secret-value");
    expect(JSON.stringify(r.pieces)).not.toContain("outside");
    expect(r.notes[0]).toMatch(/Deep mode from the Actions checkout/);
  });

  it("throws WorkspaceError for a missing directory", async () => {
    await expect(retrieveFromWorkspace(join(dir, "nope"), [changedA], cfg, "o/r", () => {})).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("deep mode in the review (retrieveDeep)", () => {
  const pr = { number: 1, title: "t", body: "", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } } as never;
  const run = async (retrieveDeep: Parameters<typeof produceReviewResult>[0]["retrieveDeep"]) => {
    const prompts: string[] = [];
    const notes: string[] = [];
    await produceReviewResult({
      pr, cfg: parseConfig("review:\n  mode: deep\n"), cfgRef: "main", files: [changedA],
      provider: { label: "fake", complete: async (req) => { prompts.push(req.user); return "{}"; } },
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => ["src/price.ts"], readFile: async () => "export const fromApi = 1;", searchSymbol: async () => [] },
      retrieveDeep, onNotes: (n) => notes.push(...n),
      log: { info: () => {}, warning: () => {} },
    });
    return { prompt: prompts.join("\n"), notes: notes.join("\n") };
  };

  it("sends the checkout context to the model", async () => {
    const r = await run(() => retrieveFromWorkspace(dir, [changedA], parseConfig("review:\n  mode: deep\n"), "o/r", () => {}));
    expect(r.prompt).toContain("src/cart.ts");
    expect(r.prompt).not.toContain("fromApi");
  });

  it("falls back to context mode and says why when the checkout is unusable", async () => {
    const r = await run(async () => { throw new WorkspaceError("the workspace is not a git checkout"); });
    expect(r.notes).toMatch(/Deep mode unavailable \(the workspace is not a git checkout\)/);
    expect(r.prompt).toContain("fromApi");
  });
});
