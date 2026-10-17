// Vendored from the MergeJudge core. Keep in sync.
export type Lane = "auto" | "review" | "block";
export const LANE_ORDER: Record<Lane, number> = { auto: 0, review: 1, block: 2 };

export function maxLane(a: Lane, b: Lane): Lane {
  return LANE_ORDER[a] >= LANE_ORDER[b] ? a : b;
}

export interface PrFile {
  path: string;
  status: string; // added | modified | removed | renamed | ...
  additions: number;
  deletions: number;
  patch?: string; // absent for binary / huge files
  previousPath?: string;
}

export interface FileVerdict {
  path: string;
  lane: Lane;
  reasons: string[];
  /** Where the lane came from: rule only, LLM raised it from auto, or rule + LLM (LLM agreed or raised further). */
  source?: LaneSource;
  /** The LLM's reason when it raised or matched a non-auto lane. */
  llmReason?: string;
  /** lanes.code_auto: a small code file that passed every rule and may only go auto if the AI explicitly says so. The lane stays "review" until then. */
  autoCandidate?: boolean;
  /** lanes.code_auto: this code file is "auto" because the AI explicitly said so (llmReason holds why). Never set by rules alone. */
  codeAuto?: boolean;
}

export type LaneSource = "rule" | "LLM" | "rule + LLM" | "rule + rubric" | "LLM + rubric" | "rule + LLM + rubric";
