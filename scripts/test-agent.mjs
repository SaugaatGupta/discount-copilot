// Offline tests of the agent loop, both provider formats, and the Netlify handler.
// Uses a scripted fake model, so no API key is needed: node scripts/test-agent.mjs
import handler from "../netlify/functions/chat.mjs";
import { runAgent } from "../netlify/functions/lib/agent.mjs";
import { resolveProvider } from "../netlify/functions/lib/providers.mjs";

const anthropicScript = [
  { stop_reason: "tool_use", content: [{ type: "text", text: "Looking up the restaurant." }, { type: "tool_use", id: "t1", name: "run_sql", input: { query: "SELECT restaurant_id, name FROM restaurants WHERE LOWER(name) LIKE '%supper%'" } }] },
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "get_campaign_roi", input: { id: "ALL" } }, { type: "tool_use", id: "t3", name: "simulate_offer", input: { restaurant_id: "R010", offer_type: "FLAT", offer_value: 100, min_order_value: 399, target_segment: "NEW_USERS" } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Final answer." }] },
];
const openaiScript = [
  { choices: [{ message: { content: "Checking.", tool_calls: [{ id: "c1", type: "function", function: { name: "run_sql", arguments: '{"query":"SELECT COUNT(*) AS n FROM restaurants"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
  { choices: [{ message: { content: "There are 60 restaurants." } }], usage: { prompt_tokens: 30, completion_tokens: 10 } },
];

let seen = [];
function fake(kind) {
  let i = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body); seen.push({ url, body });
    if (kind === "anthropic") { if (!url.endsWith("/messages")) throw new Error("wrong url " + url); return { ok: true, json: async () => ({ ...anthropicScript[i++], usage: { input_tokens: 10, output_tokens: 5 } }) }; }
    if (!url.endsWith("/chat/completions")) throw new Error("wrong url " + url);
    if (!body.tools?.[0]?.function?.parameters) throw new Error("tools were not converted to OpenAI format");
    if (body.messages[0].role !== "system") throw new Error("missing system message");
    return { ok: true, json: async () => openaiScript[i++] };
  };
}
const ok = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exitCode = 1; } else console.log("pass: " + m); };

// 1. Anthropic format
let p = resolveProvider({ ANTHROPIC_API_KEY: "x" });
ok(p.model === "claude-sonnet-4-5" && p.kind === "anthropic", "anthropic provider resolves");
let out = await runAgent("Is the Supper Club discount working?", { provider: p, fetchImpl: fake("anthropic") });
ok(out.steps === 3 && out.answer === "Final answer." && out.trace.length === 3, "anthropic loop runs 3 tools and finishes");

// 2. OpenAI-compatible format (Groq preset)
seen = [];
p = resolveProvider({ GROQ_API_KEY: "x" });
ok(p.base.includes("groq") && p.model === "openai/gpt-oss-120b", "groq provider resolves from GROQ_API_KEY alone");
out = await runAgent("How many restaurants?", { provider: p, fetchImpl: fake("openai") });
ok(out.answer.includes("60") && out.trace[0].tool === "run_sql", "openai-compatible loop converts tool calls and results");
const toolMsg = seen[1].body.messages.find((m) => m.role === "tool");
ok(toolMsg && toolMsg.tool_call_id === "c1", "tool results are sent back as role=tool with the call id");

// 3. Other presets and errors
ok(resolveProvider({ GEMINI_API_KEY: "x" }).base.includes("generativelanguage"), "gemini preset resolves");
ok(resolveProvider({ LLM_PROVIDER: "custom", LLM_API_KEY: "x", LLM_BASE_URL: "https://h/v1", LLM_MODEL: "m" }).base === "https://h/v1", "custom endpoint resolves");
try { resolveProvider({}); ok(false, "missing key throws"); } catch (e) { ok(/No API key/.test(e.message), "missing key gives a clear error"); }

// 4. Netlify handler
process.env.GROQ_API_KEY = "x"; globalThis.fetch = fake("openai");
const res = await handler(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }));
const j = await res.json();
ok(res.status === 200 && j.append.length === 2 && j.trace[0].tool === "run_sql", "handler returns one step with tool trace");
ok((await handler(new Request("http://x/api/chat", { method: "POST", body: "{" }))).status === 400, "handler rejects bad json");
