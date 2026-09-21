// POST /api/chat  { messages: [...] }  ->  one agent step (one model call + any tool executions)
import { agentStep, modelName, MAX_STEPS } from "./lib/agent.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length || messages.at(-1).role !== "user") return json({ error: "Last message must be from the user" }, 400);
  if (messages.length > 60) return json({ error: "Conversation too long. Start a new chat." }, 400);
  const lastText = typeof messages.at(-1).content === "string" ? messages.at(-1).content : "";
  if (lastText.length > 2000) return json({ error: "Question is too long (2000 characters max)." }, 400);
  try {
    const t0 = Date.now();
    const out = await agentStep(messages);
    return json({ ...out, model: modelName(), max_steps: MAX_STEPS, latency_ms: Date.now() - t0 });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/api/chat" };
