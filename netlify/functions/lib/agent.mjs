// The agent loop: Claude + three tools, with guardrails. Used by the Netlify function and the eval runner.
import { SCHEMA, runSql, discountRoi, allCampaignRoi, simulateOffer } from "./analytics.mjs";
import { callModel, resolveProvider } from "./providers.mjs";

// Which model answers is decided by environment variables (see providers.mjs).
export function modelName() { try { const p = resolveProvider(); return `${p.label} ${p.model}`; } catch { return "not configured"; } }
const MAX_STEPS = 8;

export const SYSTEM = `You are Discount Copilot, an assistant for food-delivery sales reps who manage restaurant partners in Bengaluru.
Reps use you to check whether a restaurant's discount campaign is working, find loss-making campaigns, and prepare a better offer to pitch.

Data you can query:
${SCHEMA}

Tools:
- run_sql: ad-hoc questions (counts, GMV, spend, splits by zone/cuisine/hour/customer type).
- get_campaign_roi: the source of truth for campaign impact (uplift, spend, margin ROI, verdict). Use it for any "is it working / ROI / profitable" question. Pass "ALL" for a ranked list of every campaign.
- simulate_offer: project the impact of a proposed offer before pitching it.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate or invent numbers. If the tools can't answer, say so.
- Resolve restaurant names to ids with run_sql (use LIKE for partial names) before calling other tools.
- For recommendations, compare at least two alternatives with simulate_offer and pick the one with the best projected net profit impact for the restaurant, then say it's a projection to validate with an A/B test.
- You cannot change campaigns, contact restaurants or see data outside these tables. Say so if asked.
- Politely decline questions unrelated to restaurant discounts, sales or this data.
- Money is in Rs; write it like Rs 12,400. Keep answers short and skimmable for a busy sales rep: lead with the answer, then 2-5 bullets of evidence, then (if relevant) a one-line pitch or next step. Use a small table only when comparing several items.`;

export const TOOLS = [
  { name: "run_sql", description: "Run one read-only SELECT query (AlaSQL dialect) over the restaurants, campaigns and orders tables. Returns up to 50 rows.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "A single SELECT statement." } }, required: ["query"] } },
  { name: "get_campaign_roi", description: "Difference-in-differences ROI for one campaign (by restaurant_id like R012 or campaign_id like C004), or pass ALL for every campaign ranked worst to best by margin ROI.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "simulate_offer", description: "Project orders, discount spend and profit impact over N weeks for a proposed offer at a restaurant, using observed benchmark uplifts.",
    input_schema: { type: "object", properties: {
      restaurant_id: { type: "string" }, offer_type: { type: "string", enum: ["PERCENT", "FLAT", "FREE_DELIVERY"] },
      offer_value: { type: "number", description: "% for PERCENT, Rs for FLAT, delivery fee Rs (usually 39) for FREE_DELIVERY" },
      max_discount: { type: "number", description: "Cap in Rs for PERCENT offers" }, min_order_value: { type: "number" },
      target_segment: { type: "string", enum: ["ALL", "NEW_USERS"] }, time_slot: { type: "string", enum: ["ALL_DAY", "WEEKEND_DINNER", "WEEKDAY_LUNCH"] },
      restaurant_funded_pct: { type: "number" }, weeks: { type: "number" } },
      required: ["restaurant_id", "offer_type", "offer_value"] } },
];

export function executeTool(name, input) {
  try {
    if (name === "run_sql") return runSql(input.query);
    if (name === "get_campaign_roi") return String(input.id).toUpperCase() === "ALL" ? allCampaignRoi() : discountRoi(String(input.id).toUpperCase());
    if (name === "simulate_offer") return simulateOffer(input);
    return { error: `Unknown tool ${name}` };
  } catch (e) { return { error: String(e.message || e) }; }
}

// One model call. The client (browser or eval runner) drives the loop so each HTTP request
// stays well inside serverless time limits and the UI can show progress per step.
// messages: Anthropic-format messages (text, tool_use and tool_result blocks).
export async function agentStep(messages, { provider = resolveProvider(), fetchImpl = fetch } = {}) {
  const resp = await callModel({ messages, system: SYSTEM, tools: TOOLS, provider, fetchImpl });
  const assistant = { role: "assistant", content: resp.content };
  const calls = resp.content.filter((b) => b.type === "tool_use");
  const usage = resp.usage;
  if (resp.stop_reason !== "tool_use" || !calls.length) {
    const answer = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { done: true, answer, append: [assistant], trace: [], usage };
  }
  const trace = [];
  const results = calls.map((c) => {
    const out = executeTool(c.name, c.input);
    const json = JSON.stringify(out);
    trace.push({ tool: c.name, input: c.input, output: json.length > 1500 ? json.slice(0, 1500) + "..." : json, error: !!out?.error });
    return { type: "tool_result", tool_use_id: c.id, content: json.slice(0, 20000), is_error: !!out?.error };
  });
  const thinking = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { done: false, thinking, append: [assistant, { role: "user", content: results }], trace, usage };
}

// Full loop, used by the eval runner in "local" mode and tests.
export async function runAgent(question, opts = {}) {
  const messages = [{ role: "user", content: question }];
  const trace = []; const usage = { input_tokens: 0, output_tokens: 0 };
  for (let step = 1; step <= MAX_STEPS; step++) {
    const r = await agentStep(messages, opts);
    messages.push(...r.append); trace.push(...r.trace);
    usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
    if (r.done) return { answer: r.answer, trace, usage, steps: step };
  }
  return { answer: "I couldn't finish that within my step limit. Try a narrower question.", trace, usage, steps: MAX_STEPS };
}
export { MAX_STEPS };
