// Model providers. The agent speaks one internal format (Anthropic-style content blocks);
// this file talks to Anthropic directly, or to any OpenAI-compatible API (Groq, Gemini,
// OpenRouter, OpenAI), converting messages and tool calls in both directions.
//
// Configure with environment variables. Set ONE api key and everything else has a default:
//   ANTHROPIC_API_KEY   -> Anthropic (default model claude-sonnet-4-5)
//   GROQ_API_KEY        -> Groq, free tier (default model openai/gpt-oss-120b)
//   GEMINI_API_KEY      -> Google Gemini, free tier (default model gemini-2.5-flash)
//   OPENROUTER_API_KEY  -> OpenRouter (set LLM_MODEL yourself)
//   OPENAI_API_KEY      -> OpenAI (default model gpt-4o-mini)
// Optional overrides: LLM_PROVIDER, LLM_MODEL, LLM_API_KEY, LLM_BASE_URL (for any other
// OpenAI-compatible endpoint, used with LLM_PROVIDER=custom).

const PRESETS = {
  anthropic: { kind: "anthropic", base: "https://api.anthropic.com/v1", keys: ["ANTHROPIC_API_KEY", "LLM_API_KEY"], model: "claude-sonnet-4-5", label: "Anthropic" },
  groq:      { kind: "openai", base: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY", "LLM_API_KEY"], model: "openai/gpt-oss-120b", label: "Groq" },
  gemini:    { kind: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "LLM_API_KEY"], model: "gemini-2.5-flash", label: "Gemini" },
  openrouter:{ kind: "openai", base: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY", "LLM_API_KEY"], model: "meta-llama/llama-3.3-70b-instruct", label: "OpenRouter" },
  openai:    { kind: "openai", base: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY", "LLM_API_KEY"], model: "gpt-4o-mini", label: "OpenAI" },
  custom:    { kind: "openai", base: "", keys: ["LLM_API_KEY"], model: "", label: "Custom" },
};

export function resolveProvider(env = process.env) {
  const name = (env.LLM_PROVIDER || Object.keys(PRESETS).find((p) => PRESETS[p].keys.some((k) => k !== "LLM_API_KEY" && env[k])) || "anthropic").toLowerCase();
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown LLM_PROVIDER "${name}". Use one of: ${Object.keys(PRESETS).join(", ")}.`);
  const apiKey = preset.keys.map((k) => env[k]).find(Boolean);
  const base = (env.LLM_BASE_URL || preset.base).replace(/\/$/, "");
  const model = env.LLM_MODEL || (name === "anthropic" ? env.ANTHROPIC_MODEL : null) || preset.model;
  if (!apiKey) throw new Error(`No API key found for provider "${name}". Set ${preset.keys[0]} in your site's environment variables.`);
  if (!base) throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=custom.");
  if (!model) throw new Error("LLM_MODEL is required for this provider.");
  return { name, kind: preset.kind, label: preset.label, base, apiKey, model };
}

// ---- Anthropic <-> OpenAI message conversion ----
function toOpenAiMessages(messages, system) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const results = m.content.filter((b) => b.type === "tool_result");
    if (results.length) { results.forEach((b) => out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) })); continue; }
    out.push({ role: "user", content: m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") });
  }
  return out;
}
function fromOpenAiResponse(json) {
  const choice = json.choices?.[0];
  if (!choice) throw new Error("Model returned no choices: " + JSON.stringify(json).slice(0, 300));
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: String(msg.content) });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { _raw: c.function?.arguments }; }
    content.push({ type: "tool_use", id: c.id || `call_${content.length}`, name: c.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    content,
    stop_reason: (msg.tool_calls || []).length ? "tool_use" : "end_turn",
    usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 },
  };
}
const toOpenAiTools = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export async function callModel({ messages, system, tools, maxTokens = 1024, provider = resolveProvider(), fetchImpl = fetch }) {
  const isAnthropic = provider.kind === "anthropic";
  const url = `${provider.base}/${isAnthropic ? "messages" : "chat/completions"}`;
  const headers = { "content-type": "application/json", ...(isAnthropic ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${provider.apiKey}` }) };
  const body = isAnthropic
    ? { model: provider.model, max_tokens: maxTokens, system, tools, messages }
    : { model: provider.model, max_tokens: maxTokens, tools: toOpenAiTools(tools), tool_choice: "auto", messages: toOpenAiMessages(messages, system) };
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${provider.label} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (isAnthropic) return { content: json.content, stop_reason: json.stop_reason, usage: { input_tokens: json.usage?.input_tokens || 0, output_tokens: json.usage?.output_tokens || 0 } };
  return fromOpenAiResponse(json);
}
