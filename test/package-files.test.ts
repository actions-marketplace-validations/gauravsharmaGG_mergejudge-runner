import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Hosts (the MergeJudge Worker and Action) install this package from git and import core/ directly, so every file a
// core/ module reaches with a relative import must be shipped. Keeping core/ self-contained also keeps runner-only
// Node code (child processes, the runner config file) out of the hosted bundles.
const root = resolve(__dirname, "..");
const shipped: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("published package", () => {
  it("core/ imports only files inside core/ (shipped in package.json files)", () => {
    expect(shipped).toContain("core");
    const bad: string[] = [];
    for (const f of tsFiles(join(root, "core"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = relative(root, resolve(dirname(f), m[1]!));
        if (!target.startsWith("core/")) bad.push(`${relative(root, f)} -> ${m[1]}`);
      }
    }
    expect(bad, "Move the helper into core/ (re-export it from src/ if the runner needs it); src/ is not published").toEqual([]);
  });
});
