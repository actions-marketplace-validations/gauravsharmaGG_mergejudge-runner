/** What this runner declares to the Worker (register + heartbeat) and uses to pick an engine for a job. */
import { ANY_MODEL, ENGINE_BILLING, MODEL_RE, type EngineCap, type EngineName } from "../core/engines.js";
import { ConfigError, type EngineSettings, type RunnerConfig } from "./config.js";

export const GLM_KEY_ENV = "ZAI_API_KEY";

/** The z.ai key: the config file first, then the environment. Empty / whitespace counts as absent. */
export function glmKeyOf(cfg: Pick<RunnerConfig, "glmApiKey">, env: Record<string, string | undefined>): string | undefined {
  const k = (cfg.glmApiKey ?? env[GLM_KEY_ENV] ?? "").trim();
  return k || undefined;
}

/**
 * Declared capabilities, default engine first. Engines the runner cannot actually use are left out: unknown names,
 * and glm without a key. Model names that would not be safe as one CLI argument are dropped.
 */
export function runnerCaps(cfg: RunnerConfig, env: Record<string, string | undefined>, exclude: ReadonlySet<string> = new Set()): EngineCap[] {
  const settings = cfg.engines ?? { [cfg.engine]: {} };
  const names = [cfg.engine, ...Object.keys(settings).filter((n) => n !== cfg.engine)];
  const caps: EngineCap[] = [];
  for (const engine of names) {
    if (!(engine in ENGINE_BILLING) || exclude.has(engine)) continue;
    if (engine === "glm" && !glmKeyOf(cfg, env)) continue;
    const st = settings[engine] ?? {};
    const defaultModel = st.model && MODEL_RE.test(st.model) ? st.model : null;
    const models = [...new Set([...(defaultModel ? [defaultModel] : []), ...(st.models ?? []).filter((m) => m === ANY_MODEL || MODEL_RE.test(m))])];
    caps.push({ engine, billing: ENGINE_BILLING[engine as EngineName], models, defaultModel });
  }
  return caps;
}

/** Default engine: the requested one (must be enabled), else the first enabled (claude-code, codex, glm order), else claude-code. */
export function pickDefaultEngine(requested: string | undefined, enabled: string[]): string {
  if (requested) {
    if (!(requested in ENGINE_BILLING)) throw new ConfigError(`unknown engine "${requested}" (use claude-code, codex or glm)`);
    if (!enabled.includes(requested)) throw new ConfigError(`engine "${requested}" is not available here (${requested === "glm" ? `needs a z.ai key: --glm-key-env NAME or ${GLM_KEY_ENV}` : "not installed or not signed in"})`);
    return requested;
  }
  return enabled[0] ?? "claude-code";
}

/**
 * `--model` flags -> per-engine settings. `--model gpt-5` applies to the default engine; `--model codex=gpt-5` names the engine.
 * The first model of an engine is its default, further ones are also offered (a repo may ask for them); `*` offers any model.
 */
export function buildEngineSettings(enabled: string[], defaultEngine: string, modelFlags: string[]): Record<string, EngineSettings> {
  const out: Record<string, EngineSettings> = Object.fromEntries(enabled.map((e) => [e, {} as EngineSettings]));
  if (!out[defaultEngine]) out[defaultEngine] = {};
  for (const flag of modelFlags) {
    const eq = flag.indexOf("=");
    const engine = eq > 0 ? flag.slice(0, eq) : defaultEngine, model = eq > 0 ? flag.slice(eq + 1) : flag;
    const st = out[engine];
    if (!st) throw new ConfigError(`--model ${flag}: engine "${engine}" is not enabled on this runner`);
    if (model === ANY_MODEL) { st.models = [...new Set([...(st.models ?? []), ANY_MODEL])]; continue; }
    if (!MODEL_RE.test(model)) throw new ConfigError(`--model: "${model}" is not a valid model name`);
    if (!st.model) st.model = model;
    else if (st.model !== model) st.models = [...new Set([...(st.models ?? []), model])];
  }
  return out;
}
