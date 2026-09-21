// GET /api/health  -> what the server actually sees (no secret values are returned).
// GET /api/health?test=1 -> also makes one tiny call to the model provider and reports the result.
import { resolveProvider, callModel } from "./lib/providers.mjs";

const NAMES = ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

export default async (req) => {
  const out = { ok: true, build: { commit: process.env.COMMIT_REF?.slice(0, 7) || null, deployed_at: process.env.DEPLOY_ID || null }, env: {} };
  for (const n of NAMES) {
    const v = process.env[n];
    out.env[n] = v ? (n.includes("KEY") ? `set (starts with "${v.slice(0, 4)}", length ${v.length})` : `set to "${v}"`) : "not set";
  }
  try {
    const p = resolveProvider();
    out.provider = { chosen: p.name, label: p.label, model: p.model, endpoint: p.base, key_starts_with: p.apiKey.slice(0, 4) };
    if (new URL(req.url).searchParams.get("test")) {
      try {
        const r = await callModel({ messages: [{ role: "user", content: "Reply with the single word: ok" }], system: "Reply with one word.", tools: [], maxTokens: 16 });
        out.live_test = { ok: true, reply: r.content.map((b) => b.text).join(" ").trim().slice(0, 40) };
      } catch (e) { out.live_test = { ok: false, error: String(e.message || e).slice(0, 300) }; }
    }
  } catch (e) {
    out.ok = false; out.provider_error = String(e.message || e);
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/health" };
