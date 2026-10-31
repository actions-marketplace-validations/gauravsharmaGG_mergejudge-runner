import { LlmError, rejectOnAbort, withCallBudget, withLlmRetries, type LlmTransport } from "./http.js";
import { isTruncated, openAiUsage, reportUsage, tokenCount, type LlmProvider, type LlmRequest, type LlmResult, type UsageSink } from "./provider.js";

/** The slice of the Cloudflare Workers AI binding (`env.AI`) MergeJudge uses. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Cloudflare Workers AI through the `AI` binding (Worker runtime only; no API key). */
export class WorkersAiProvider implements LlmProvider {
  readonly label: string;
  readonly providerId: string;
  readonly supportsTools = false; // tool calling differs per model; deep mode falls back to context
  constructor(private ai: WorkersAiBinding, private model: string, private onUsage?: UsageSink, private transport: Partial<LlmTransport> = {},
    /** Extra `ai.run` input fields per model (e.g. `reasoning_effort`); `messages`, `max_tokens` and `response_format` always win. */
    private requestExtras: Record<string, unknown> = {}) {
    this.label = model;
    this.providerId = transport.providerId ?? "workers-ai";
  }
  async complete(req: LlmRequest): Promise<string> {
    const r = await this.completeEx(req);
    if (!r.text) throw new LlmError("parse", { provider: this.providerId });
    return r.text;
  }
  async completeEx(req: LlmRequest): Promise<LlmResult> {
    // The binding has no AbortSignal. The race stops our wait; a timed-out run may still finish in the background.
    const out = (await withLlmRetries(
      (signal) => {
        const pending = this.ai.run(this.model, {
          ...this.requestExtras,
          messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
          max_tokens: req.maxOutputTokens,
          ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
        });
        void pending.catch(() => {}); // a late rejection after we stop waiting must not surface as unhandled
        return Promise.race([pending, rejectOnAbort(signal)]);
      },
      withCallBudget({ ...this.transport, providerId: this.providerId }, req.budgetMs, req.maxRetries),
    )) as { response?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const u = out?.usage;
    const usage = u && typeof u === "object" ? openAiUsage(u.prompt_tokens, u.completion_tokens, 0) : null;
    reportUsage(this.onUsage, usage, req.purpose);
    const r = out?.response ?? out?.choices?.[0]?.message?.content;
    // finish_reason exists only on the OpenAI-style shape; the output-token count is the fallback.
    const outputTokens = tokenCount(u?.completion_tokens);
    const truncated = isTruncated(out?.choices?.[0]?.finish_reason === "length", outputTokens, req.maxOutputTokens);
    if (typeof r === "string" && r) return { text: r, truncated, outputTokens, usage };
    if (r && typeof r === "object") return { text: JSON.stringify(r), truncated, outputTokens, usage }; // some models return parsed JSON
    return { text: "", truncated, outputTokens, usage };
  }
}
