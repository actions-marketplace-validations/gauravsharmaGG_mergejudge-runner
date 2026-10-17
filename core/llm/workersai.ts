// Vendored from the MergeJudge core. Keep in sync.
import { isTruncated, openAiUsage, reportUsage, tokenCount, type LlmProvider, type LlmRequest, type LlmResult, type UsageSink } from "./provider.js";

/** The slice of the Cloudflare Workers AI binding (`env.AI`) MergeJudge uses. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Cloudflare Workers AI through the `AI` binding (Worker runtime only; no API key). */
export class WorkersAiProvider implements LlmProvider {
  readonly label: string;
  readonly supportsTools = false; // tool calling differs per model; deep mode falls back to context
  constructor(private ai: WorkersAiBinding, private model: string, private onUsage?: UsageSink) {
    this.label = model;
  }
  async complete(req: LlmRequest): Promise<string> {
    const r = await this.completeEx(req);
    if (!r.text) throw new Error("Workers AI response had no text");
    return r.text;
  }
  async completeEx(req: LlmRequest): Promise<LlmResult> {
    const out = (await this.ai.run(this.model, {
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      max_tokens: req.maxOutputTokens,
      ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
    })) as { response?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const u = out?.usage;
    reportUsage(this.onUsage, u && typeof u === "object" ? openAiUsage(u.prompt_tokens, u.completion_tokens, 0) : null);
    const r = out?.response ?? out?.choices?.[0]?.message?.content;
    // finish_reason exists only on the OpenAI-style shape; the output-token count is the fallback.
    const outputTokens = tokenCount(u?.completion_tokens);
    const truncated = isTruncated(out?.choices?.[0]?.finish_reason === "length", outputTokens, req.maxOutputTokens);
    if (typeof r === "string" && r) return { text: r, truncated, outputTokens };
    if (r && typeof r === "object") return { text: JSON.stringify(r), truncated, outputTokens }; // some models return parsed JSON
    return { text: "", truncated, outputTokens };
  }
}
