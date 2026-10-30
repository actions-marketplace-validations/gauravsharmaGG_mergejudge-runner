/**
 * Vitest setup: every test file gets its own temp root (`mjr-run-*`) and `os.tmpdir()` points into it, so all
 * `mjr-*` / `mj-*` dirs the tests and the fake engines create land there. The root is removed when the file ends,
 * so a full `npm run verify` leaves nothing behind in the system temp dir.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "mjr-run-"));
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;

/** Tests make some dirs read-only; give the owner write access back so the removal cannot fail half way. */
function unlock(dir: string): void {
  try { chmodSync(dir, 0o700); } catch { return; }
  let names: import("node:fs").Dirent[];
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) if (d.isDirectory() && !d.isSymbolicLink()) unlock(join(dir, d.name));
}

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { unlock(root); rmSync(root, { recursive: true, force: true }); }
});
