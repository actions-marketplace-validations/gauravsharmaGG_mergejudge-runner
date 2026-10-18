import { hasAgentTrailer, isAgentPr } from "./agent.js";
import type { Config } from "./config.js";
import type { Lane } from "./types.js";

/**
 * PR template check (`pr_template`): the description must really answer the configured sections
 * (default Testing / Risk / How to revert). Deterministic, opt-in per repo, and it can only RAISE a lane:
 * the body is untrusted, so a forged description can at worst demand a review it would have got anyway.
 */

/** Configured section names that carry built-in aliases; a custom section matches its own name only. */
export const SECTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  testing: ["tests", "test plan", "how was this tested"],
  risk: ["risks", "risk level"],
  "how to revert": ["rollback", "revert plan", "revert", "how to roll back"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[?:*#]+$/g, "").trim();

/** Every name a configured section answers to, lowercased: the section itself, its alias group, and vice versa. */
export function sectionNames(section: string): string[] {
  const name = norm(section);
  if (!name) return [];
  const group = Object.entries(SECTION_ALIASES).find(([canonical, aliases]) => canonical === name || aliases.includes(name));
  return group ? [...new Set([name, group[0], ...group[1]])] : [name];
}

/** Template noise that is not an answer: checkbox-only lines, placeholder text, and the agent-marker trailer. */
const CHECKBOX_ONLY = /^\s*[-*+]?\s*\[[ xX]?\]\s*$/;
const PLACEHOLDER_ONLY =
  /^(?:\[[^\]]*\]|<[^>]*>|(?:tbd|todo|n\/?a|none|nothing|pending|tba|placeholder|describe\b[^:.!?]{0,60}|-{2,}|\.{3,}|…|\?{1,}))\.?\s*$/i;

/** One `#`-heading line (content optional so "## Testing" and "## Testing plan" both bound a section). */
const isHeadingLine = (line: string) => /^#{1,6}\s+\S/.test(line);

function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/** Matches the line when it opens the section: a markdown heading, or a bold/plain label like `**Testing:**` / `Testing:`. */
function sectionStart(line: string, names: readonly string[]): { content: string } | null {
  const h = /^#{1,6}\s*(?:\*\*)?(.+?)(?:\*\*)?\s*(?:[(：(-][^)#]*?)?(?::)?\s*$/.exec(line);
  if (h && names.includes(norm(h[1]!))) return { content: "" };
  const l = /^(?:\*\*)?(.+?)(?:\*\*)?\s*:(.*)$/.exec(line);
  if (l && names.includes(norm(l[1]!))) return { content: l[2] ?? "" };
  return null;
}

/** The real answer text under one section: same-line label text plus lines until the next section/heading. */
function sectionText(body: string, names: readonly string[], boundaries: readonly string[]): string | null {
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const start = lines.findIndex((l) => sectionStart(l, names));
  if (start < 0) return null;
  let text = sectionStart(lines[start]!, names)!.content;
  for (const line of lines.slice(start + 1)) {
    if (isHeadingLine(line) || boundaries.some((n) => sectionStart(line, [n]))) break;
    text += "\n" + line;
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !CHECKBOX_ONLY.test(l) && !PLACEHOLDER_ONLY.test(l) && !hasAgentTrailer(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Configured sections the body does not really answer, in config order, by their configured names. */
export function missingPrTemplateSections(body: string | null | undefined, sections: readonly string[], minChars: number): string[] {
  if (!body || !sections.length) return sections.slice();
  // Any configured section (any spelling) ends the previous one, so two empty template headings do not merge.
  const boundaries = sections.flatMap((s) => sectionNames(s));
  return sections.filter((s) => {
    const text = sectionText(body, sectionNames(s), boundaries);
    return text === null || text.length < minChars;
  });
}

export interface PrTemplateInput {
  body?: string | null;
  labels?: readonly string[] | null;
}

export interface PrTemplateRaise {
  lane: Exclude<Lane, "auto">;
  reason: string;
  missing: string[];
}

/**
 * The PR-level raise the template check asks for, or null when it does not apply: disabled (the default),
 * `apply_to: agents` on a PR without the agent marker, or every section answered. Never lowers a lane.
 */
export function prTemplateRaise(cfg: Config, pr: PrTemplateInput): PrTemplateRaise | null {
  const t = cfg.pr_template;
  if (!t?.enabled) return null;
  if (t.apply_to !== "all" && !isAgentPr({ labels: pr.labels ?? [], body: pr.body ?? null })) return null;
  const missing = missingPrTemplateSections(pr.body, t.sections, t.min_chars);
  if (!missing.length) return null;
  return {
    lane: t.missing_lane === "block" ? "block" : "review",
    reason: `PR description is missing: ${missing.join(", ")} (pr_template)`,
    missing,
  };
}
