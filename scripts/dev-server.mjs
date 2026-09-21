// Minimal local server for UI testing without Netlify CLI: serves public/ and /api/chat.
//   ANTHROPIC_API_KEY=... node scripts/dev-server.mjs     (real model)
//   MOCK=1 node scripts/dev-server.mjs                    (scripted fake model, no key needed)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import handler from "../netlify/functions/chat.mjs";

if (process.env.MOCK) {
  process.env.ANTHROPIC_API_KEY = "mock";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("anthropic.com")) return realFetch(url, init);
    const body = JSON.parse(init.body); const n = body.messages.filter((m) => m.role === "assistant").length % 3;
    const turns = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "a" + Date.now(), name: "get_campaign_roi", input: { id: "ALL" } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "b" + Date.now(), name: "run_sql", input: { query: "SELECT customer_type, SUM(discount_amount) AS spend FROM orders WHERE campaign_id IS NOT NULL GROUP BY customer_type" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "(Mock answer) **5 campaigns lose the most money**, all blanket % discounts.\n\n| Restaurant | Offer | Margin ROI |\n|---|---|---|\n| Example A | 40% off, weekend dinner | -0.53x |\n| Example B | 40% off, weekend dinner | -0.44x |\n\n- Most discount spend went to **repeat customers**\n- Weekend dinner is already peak demand\n\n**Pitch:** a new-user flat offer. Validate with an A/B test." }] },
    ];
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, json: async () => ({ ...turns[n], usage: { input_tokens: 3000, output_tokens: 150 } }) };
  };
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
createServer(async (req, res) => {
  if (req.url.startsWith("/api/chat")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handler(new Request("http://local" + req.url, { method: req.method, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, { "content-type": "application/json" }); return res.end(await r.text());
  }
  const p = join("public", req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  try { const b = await readFile(p); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(process.env.PORT || 8888, () => console.log("http://localhost:" + (process.env.PORT || 8888)));
