// Vendored from the MergeJudge core. Keep in sync.
// Test support: the schema the Worker applies to a submitted review result (runner protocol, schemaVersion 1).
import { z } from "zod";
import { ENGINE_RE, MODEL_RE } from "../../core/engines.js";

const lane = z.enum(["auto", "review", "block"]);
export const reviewResultSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["review", "learning-block"]),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(7).max(64),
  prNodeId: z.string().max(200),
  lane,
  agg: z.looseObject({
    lane,
    files: z.array(z.looseObject({ path: z.string().max(1024), lane, reasons: z.array(z.string().max(2000)).max(50) })).max(3000),
    labelReasons: z.array(z.string().max(2000)).max(100),
    summary: z.string().max(20_000),
    rubric: z.array(z.looseObject({})).max(100),
  }),
  body: z.string().max(65_536),
  findings: z.array(z.object({ path: z.string().max(1024), line: z.number().int().positive().optional(), message: z.string().max(4000) })).max(50),
  syncInline: z.boolean(),
  trimmedFiles: z.array(z.string().max(1024)).max(3000).optional(),
  usage: z.looseObject({
    lane, mode: z.enum(["diff", "context", "deep", "rules-only"]), model: z.string().max(200).nullable(),
    cached: z.boolean(), breakdown: z.looseObject({}).nullable(), tokens: z.number().min(0),
    /** Runner 0.2.0+: which engine/model produced the review (shown in the footer). */
    engine: z.string().regex(ENGINE_RE).optional(),
    engineModel: z.string().regex(MODEL_RE).nullable().optional(),
    billing: z.enum(["subscription", "api-key"]).optional(),
  }),
});

export type ReviewResultInput = z.infer<typeof reviewResultSchema>;
