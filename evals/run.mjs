// Eval harness for Discount Copilot.
//   node evals/run.mjs --url https://your-site.netlify.app   (runs against the deployed API)
//   ANTHROPIC_API_KEY=... node evals/run.mjs --local          (runs the agent in-process)
// Options: --only roi,guardrail   --concurrency 3
// Writes evals/report.json, evals/report.md and public/eval-report.json (shown in the app).
import { readFileSync, writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] ?? true : d; };
const URL_ = arg("url"); const LOCAL = process.argv.includes("--local");
const ONLY = arg("only") ? String(arg("only")).split(",") : null;
const CONC = Number(arg("concurrency", 3));
if (!URL_ && !LOCAL) { console.error("Pass --url <deployed site> or --local"); process.exit(1); }

const { cases } = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url)));
const selected = cases.filter((c) => !ONLY || ONLY.includes(c.category));

async function ask(question) {
  if (LOCAL) { const { runAgent } = await import("../netlify/functions/lib/agent.mjs"); return runAgent(question); }
  const messages = [{ role: "user", content: question }]; const trace = []; const usage = { input_tokens: 0, output_tokens: 0 };
  for (let step = 1; step <= 8; step++) {
    const res = await fetch(`${URL_.replace(/\/$/, "")}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    messages.push(...j.append); trace.push(...j.trace);
    usage.input_tokens += j.usage.input_tokens; usage.output_tokens += j.usage.output_tokens;
    if (j.done) return { answer: j.answer, trace, usage, steps: step };
  }
  return { answer: "(step limit)", trace, usage, steps: 8 };
}

// Pulls every number out of the answer, understanding "Rs 12,400", "1.2 lakh", "3.4L", "12K", "1.1 Cr", "-0.23x", "74.5%".
export function numbers(text) {
  const out = [];
  const re = /(-|−)?\s?(?:Rs\.?|₹|INR)?\s?(\d[\d,]*(?:\.\d+)?)\s*(lakh|lakhs|L\b|K\b|k\b|Cr\b|crore|mn|million)?/gi;
  for (const m of text.matchAll(re)) {
    let v = parseFloat(m[2].replace(/,/g, "")); if (Number.isNaN(v)) continue;
    const u = (m[3] || "").toLowerCase();
    if (u.startsWith("lakh") || u === "l") v *= 1e5; else if (u === "k") v *= 1e3; else if (u.startsWith("cr")) v *= 1e7; else if (u === "mn" || u === "million") v *= 1e6;
    if (m[1]) v = -v;
    out.push(v);
  }
  return out;
}

function grade(c, r) {
  const text = r.answer.toLowerCase().replace(/[’‘]/g, "'");
  const results = c.checks.map((ch) => {
    if (ch.type === "number") {
      const ns = numbers(r.answer);
      const tol = ch.abs_tol ?? Math.abs(ch.value) * ch.rel_tol;
      const ok = ns.some((n) => Math.abs(n - ch.value) <= tol + 1e-9 || Math.abs(Math.abs(n) - Math.abs(ch.value)) <= tol + 1e-9 && ch.value < 0 && /loss|negative|-|−/.test(text));
      return { check: `number≈${ch.value}`, ok };
    }
    if (ch.type === "contains_any") return { check: `mentions one of [${ch.values.slice(0, 4).join(", ")}${ch.values.length > 4 ? ", ..." : ""}]`, ok: ch.values.some((v) => text.includes(v.toLowerCase())) };
    if (ch.type === "tool_used") { const n = r.trace.filter((t) => t.tool === ch.tool).length; return { check: `${ch.tool} x${ch.min}+`, ok: n >= ch.min }; }
    if (ch.type === "no_tools") return { check: "no tool calls", ok: r.trace.length === 0 };
    return { check: ch.type, ok: false };
  });
  return { pass: results.every((x) => x.ok), results };
}

const rows = []; let idx = 0;
async function worker() {
  while (idx < selected.length) {
    const c = selected[idx++]; const t0 = Date.now();
    let r, g;
    try { r = await ask(c.question); g = grade(c, r); } catch (e) { r = { answer: `ERROR: ${e.message}`, trace: [], usage: {}, steps: 0 }; g = { pass: false, results: [{ check: "request", ok: false }] }; }
    rows.push({ id: c.id, category: c.category, question: c.question, pass: g.pass, checks: g.results, answer: r.answer, tools: r.trace.map((t) => t.tool), steps: r.steps, usage: r.usage, seconds: (Date.now() - t0) / 1000 });
    console.log(`${g.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(9)} ${g.results.filter((x) => !x.ok).map((x) => x.check).join("; ")}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
rows.sort((a, b) => a.id.localeCompare(b.id));

const byCat = {}; for (const r of rows) { byCat[r.category] ??= { pass: 0, total: 0 }; byCat[r.category].total++; if (r.pass) byCat[r.category].pass++; }
const passed = rows.filter((r) => r.pass).length;
const avg = (k) => rows.length ? rows.reduce((t, r) => t + (k(r) || 0), 0) / rows.length : 0;
const summary = { run_at: new Date().toISOString(), target: LOCAL ? "local" : URL_, passed, total: rows.length, accuracy_pct: Math.round((1000 * passed) / rows.length) / 10,
  by_category: byCat, avg_steps: Math.round(avg((r) => r.steps) * 10) / 10, avg_seconds: Math.round(avg((r) => r.seconds) * 10) / 10,
  avg_tokens: Math.round(avg((r) => (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0))) };

writeFileSync(new URL("./report.json", import.meta.url), JSON.stringify({ summary, rows }, null, 1));
writeFileSync(new URL("../public/eval-report.json", import.meta.url), JSON.stringify({ summary, rows: rows.map(({ id, category, question, pass, checks, tools }) => ({ id, category, question, pass, checks, tools })) }, null, 1));
const md = [`# Eval report`, ``, `${passed}/${rows.length} passed (${summary.accuracy_pct}%), avg ${summary.avg_steps} steps, ${summary.avg_seconds}s, ${summary.avg_tokens} tokens per question.`, ``,
  `| Category | Passed |`, `|---|---|`, ...Object.entries(byCat).map(([k, v]) => `| ${k} | ${v.pass}/${v.total} |`), ``,
  `## Failures`, ...rows.filter((r) => !r.pass).map((r) => `\n### ${r.id}: ${r.question}\nFailed: ${r.checks.filter((x) => !x.ok).map((x) => x.check).join("; ")}\n\nTools: ${r.tools.join(", ") || "none"}\n\n> ${r.answer.replace(/\n/g, "\n> ")}`)].join("\n");
writeFileSync(new URL("./report.md", import.meta.url), md);
console.log(`\n${passed}/${rows.length} passed (${summary.accuracy_pct}%)`, byCat);
