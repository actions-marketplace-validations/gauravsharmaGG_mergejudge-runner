import { describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { applyApproval, type ApprovalActions } from "../core/approval.js";
import { parseConfig } from "../core/config.js";
import { classifyFile, isMergeJudgeConfigPath } from "../core/rules.js";
import type { LlmTriage } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const file = (path: string, over: Partial<PrFile> = {}): PrFile => ({
  path, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a: 1\n+a: 2", ...over,
});

const AUTO_YML = "lanes:\n  auto:\n    - '**/*.yml'\n    - '**/*.yaml'\n    - 'docs/**'\n    - '**/*.md'\n";
const CODE_AUTO = AUTO_YML + "  code_auto:\n    enabled: true\n";
const MERGE_ONLY = "approval:\n  mode: auto-merge-only\n  enabled: true\n";
const BOT = "approval:\n  mode: bot-approve\n  enabled: true\n  bot_approve:\n    auto: true\n    review: true\n  human_approvers:\n    review: 0\n";

function recorder() {
  const calls: string[] = [];
  const actions: ApprovalActions = {
    enableAutoMerge: async () => { calls.push("automerge"); },
    approve: async () => { calls.push("approve"); },
    dismissOwnApprovals: async () => { calls.push("dismiss"); return 1; },
  };
  return { calls, actions };
}

const prLane = (yml: string, files: PrFile[], llm: LlmTriage | null = null) => aggregate(files, [], parseConfig(yml), llm);
const configChange = (agg: ReturnType<typeof prLane>) => agg.files.some((f) => f.configFile);

describe("isMergeJudgeConfigPath", () => {
  it("matches the basename in any directory, case-insensitively", () => {
    for (const p of [".mergejudge.yml", ".mergejudge.yaml", "sub/.mergejudge.yml", "a/b/.MergeJudge.YAML"]) expect(isMergeJudgeConfigPath(p)).toBe(true);
    for (const p of ["mergejudge.yml", ".mergejudge.yml.bak", "docs/intro.md", "x/.mergejudge.json"]) expect(isMergeJudgeConfigPath(p)).toBe(false);
  });
  it("matches a custom config path", () => {
    expect(isMergeJudgeConfigPath("ci/judge.yml", ["./ci/Judge.yml"])).toBe(true);
    expect(isMergeJudgeConfigPath("ci/other.yml", ["ci/judge.yml"])).toBe(false);
  });
});

describe("config file is never auto", () => {
  it("is review under lanes.auto '**/*.yml'", () => {
    const agg = prLane(AUTO_YML, [file(".mergejudge.yml")]);
    expect(agg.lane).toBe("review");
    expect(agg.files[0]!.configFile).toBe(true);
    expect(agg.files[0]!.reasons.join(" ")).toContain("MergeJudge config file");
  });
  it("is review with lanes.code_auto enabled, even if the AI says auto", () => {
    const llm = { files: new Map([[".mergejudge.yml", { lane: "auto", reason: "fine" }]]), findings: [], rubric: [], summary: "" } as unknown as LlmTriage;
    expect(prLane(CODE_AUTO, [file(".mergejudge.yml")], llm).lane).toBe("review");
    expect(prLane(CODE_AUTO, [file(".mergejudge.yml")]).lane).toBe("review");
  });
  it("covers .yaml, a subdirectory, a rename away, a deletion and a rename onto the name", () => {
    for (const f of [
      file(".mergejudge.yaml"),
      file("sub/.mergejudge.yml"),
      file("old/settings.yml", { status: "renamed", previousPath: ".mergejudge.yml" }),
      file(".mergejudge.yml", { status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-a: 1" }),
      file(".mergejudge.yml", { status: "renamed", previousPath: "x.yml" }),
      file(".mergejudge.yml", { status: "added", deletions: 0 }),
    ]) {
      const agg = prLane(AUTO_YML, [f]);
      expect(agg.lane, `${f.status} ${f.previousPath ?? f.path}`).toBe("review");
      expect(configChange(agg)).toBe(true);
    }
  });
  it("honours a custom config path", () => {
    const f = file("ci/judge.yml");
    expect(aggregate([f], [], parseConfig(AUTO_YML), null).lane).toBe("auto");
    expect(aggregate([f], [], parseConfig(AUTO_YML), null, { configPaths: ["ci/judge.yml"] }).lane).toBe("review");
  });
  it("keeps block when something else blocks", () => {
    const secret = "@@ -1 +1 @@\n-a: 1\n+key: AKIAZ7Q4HJ2WN5RT8VLM";
    expect(classifyFile(file(".mergejudge.yml", { patch: secret }), parseConfig(AUTO_YML)).lane).toBe("block");
    expect(prLane(AUTO_YML, [file(".mergejudge.yml", { patch: secret })]).lane).toBe("block");
  });
  it("leaves a docs-only PR on auto", () => {
    const agg = prLane(AUTO_YML, [file("docs/intro.md")]);
    expect(agg.lane).toBe("auto");
    expect(configChange(agg)).toBe(false);
  });
});

describe("approval is withheld for config changes", () => {
  it("auto-merge-only: config PR gets no auto-merge, docs PR still does", async () => {
    const cfg = parseConfig(AUTO_YML + MERGE_ONLY);
    const cfgPr = aggregate([file(".mergejudge.yml")], [], cfg, null);
    const a = recorder();
    const logs: string[] = [];
    await applyApproval(cfg.approval, cfgPr.lane, a.actions, (m) => logs.push(m), { appToken: true, configChange: configChange(cfgPr) });
    expect(a.calls).toEqual([]);
    expect(logs.join()).toContain("approval: PR changes the MergeJudge config file; no bot action");

    // Even if the lane were somehow auto, the signal alone stops auto-merge.
    const b = recorder();
    await applyApproval(cfg.approval, "auto", b.actions, undefined, { appToken: true, configChange: true });
    expect(b.calls).toEqual([]);

    const docs = aggregate([file("docs/intro.md")], [], cfg, null);
    const c = recorder();
    await applyApproval(cfg.approval, docs.lane, c.actions, undefined, { appToken: true, configChange: configChange(docs) });
    expect(docs.lane).toBe("auto");
    expect(c.calls).toEqual(["automerge"]);
  });
  it("auto-merge-only with lanes.code_auto enabled: still no auto-merge", async () => {
    const cfg = parseConfig(CODE_AUTO + MERGE_ONLY);
    const agg = aggregate([file(".mergejudge.yml")], [], cfg, null);
    const a = recorder();
    await applyApproval(cfg.approval, agg.lane, a.actions, undefined, { appToken: true, configChange: configChange(agg) });
    expect(agg.lane).toBe("review");
    expect(a.calls).toEqual([]);
  });
  it("bot-approve (auto and review, 0 human approvers): config PR is not approved and earlier approvals are dismissed", async () => {
    const cfg = parseConfig(AUTO_YML + BOT);
    const agg = aggregate([file(".mergejudge.yml")], [], cfg, null);
    const a = recorder();
    const logs: string[] = [];
    await applyApproval(cfg.approval, agg.lane, a.actions, (m) => logs.push(m), { appToken: true, configChange: configChange(agg) });
    expect(a.calls).toEqual(["dismiss"]);
    expect(logs.join()).toContain("approval: PR changes the MergeJudge config file; no bot approval");

    // Control: without the signal the same review-lane PR would be approved (this is the hole being closed).
    const b = recorder();
    await applyApproval(cfg.approval, "review", b.actions, undefined, { appToken: true });
    expect(b.calls).toEqual(["approve"]);
  });
  it("bot-approve still approves a docs-only PR", async () => {
    const cfg = parseConfig(AUTO_YML + BOT);
    const agg = aggregate([file("docs/intro.md")], [], cfg, null);
    const a = recorder();
    await applyApproval(cfg.approval, agg.lane, a.actions, undefined, { appToken: true, configChange: configChange(agg) });
    expect(a.calls).toEqual(["approve"]);
  });
  it("stays backward compatible when ctx has no configChange", async () => {
    const cfg = parseConfig(MERGE_ONLY);
    const a = recorder();
    await applyApproval(cfg.approval, "auto", a.actions);
    expect(a.calls).toEqual(["automerge"]);
  });
});
