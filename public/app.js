const $ = (s) => document.querySelector(s);
const inr = (n) => "Rs " + Math.round(n).toLocaleString("en-IN");
const inrShort = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e5 ? `${s}Rs ${(a / 1e5).toFixed(1)}L` : `${s}Rs ${Math.round(a / 1e3)}K`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SUGGESTIONS = [
  ["Portfolio health", "Which 5 campaigns are losing restaurants the most money, and why?"],
  ["Pattern hunt", "What share of discount spend goes to repeat customers who'd have ordered anyway?"],
  ["Pitch prep", "Pick the worst-performing campaign and tell me what offer to pitch instead."],
  ["Zone view", "Compare discount spend and margin ROI across zones."],
];

let api = []; // Anthropic-format message history
let busy = false;
let summary = null;

// ---------- Sidebar ----------
async function loadSummary() {
  try { summary = await (await fetch("summary.json")).json(); } catch { return; }
  const k = summary.kpis;
  $("#kpis").innerHTML = [
    ["Active campaigns", `${k.active_campaigns} / ${k.restaurants}`],
    ["Discount spend (4 wks)", inrShort(k.discount_spend)],
    ["Loss-making campaigns", `${k.loss_making_campaigns}`, true],
    ["Net profit impact", inrShort(k.net_profit_impact), k.net_profit_impact < 0],
  ].map(([l, v, bad]) => `<div class="kpi${bad ? " bad" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  renderList();
}
function renderList() {
  if (!summary) return;
  const q = $("#filter").value.toLowerCase(), v = $("#verdict-filter").value;
  const rows = summary.restaurants
    .filter((r) => (!v || r.verdict === v) && (!q || `${r.name} ${r.cuisine} ${r.zone}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.margin_roi ?? 99) - (b.margin_roi ?? 99));
  $("#rlist").innerHTML = rows.map((r) => {
    const chip = r.margin_roi == null ? `<span class="chip none">No campaign</span>` : `<span class="chip ${r.margin_roi >= 1 ? "win" : "loss"}">${r.margin_roi.toFixed(2)}x</span>`;
    return `<li data-name="${esc(r.name)}" data-has="${r.margin_roi != null}"><div><div class="n">${esc(r.name)}</div><div class="m">${esc(r.cuisine)} · ${esc(r.zone)}${r.offer ? " · " + esc(r.offer) : ""}</div></div>${chip}</li>`;
  }).join("") || `<li class="m">No matches</li>`;
}
$("#filter").addEventListener("input", renderList);
$("#verdict-filter").addEventListener("change", renderList);
$("#rlist").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-name]"); if (!li) return;
  const n = li.dataset.name;
  send(li.dataset.has === "true" ? `Is the discount at ${n} working? If not, what should I pitch them instead?` : `${n} has no discount running. Should I pitch them one? Compare two options.`);
  $("#side").classList.remove("open");
});

async function loadEvals() {
  let rep;
  try { const r = await fetch("eval-report.json"); if (!r.ok) throw 0; rep = await r.json(); } catch {
    $("#evals").innerHTML = `<p class="fine">No eval run published yet. Run <code>node evals/run.mjs --url &lt;site&gt;</code> and redeploy to show results here.</p>`; return;
  }
  const s = rep.summary;
  $("#evals").innerHTML = `
    <div class="eval-score">${s.passed}/${s.total} <span style="font-size:15px;color:var(--muted);font-weight:500">passed · ${s.accuracy_pct}%</span></div>
    <p class="fine" style="margin:0 0 12px">Run ${new Date(s.run_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · avg ${s.avg_steps} steps · ${s.avg_seconds}s per question</p>
    ${Object.entries(s.by_category).map(([c, v]) => `<div class="cat"><span>${esc(c)}</span><span>${v.pass}/${v.total}</span></div><div class="bar"><i style="width:${(100 * v.pass) / v.total}%"></i></div>`).join("")}
    <div style="margin-top:12px">${rep.rows.map((r) => `<div class="case"><span class="s ${r.pass ? "p" : "f"}">${r.pass ? "✓" : "✗"}</span><span>${esc(r.question)}${r.pass ? "" : `<br><span class="m" style="color:var(--muted)">Failed: ${esc(r.checks.filter((c) => !c.ok).map((c) => c.check).join("; "))}</span>`}</span></div>`).join("")}</div>
    <p class="fine">Ground-truth answers are computed from the dataset. Each case checks numbers (with tolerance), required tool use and guardrail behaviour.</p>`;
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  ["portfolio", "evals", "about"].forEach((n) => $(`#tab-${n}`).classList.toggle("hidden", n !== t.dataset.tab));
}));
document.documentElement.style.setProperty("--topbar-h", document.querySelector(".topbar").offsetHeight + "px");
$("#toggle-side").addEventListener("click", () => $("#side").classList.toggle("open"));

// ---------- Chat ----------
$("#suggestions").innerHTML = SUGGESTIONS.map(([h, q]) => `<button type="button" data-q="${esc(q)}"><b>${h}</b>${esc(q)}</button>`).join("");
$("#suggestions").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) send(b.dataset.q); });

const TOOL_LABEL = { run_sql: "Running SQL", get_campaign_roi: "Measuring campaign ROI", simulate_offer: "Simulating an offer" };

function addUser(text) {
  $("#empty")?.remove();
  const d = document.createElement("div"); d.className = "msg user"; d.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  $("#thread").appendChild(d); scrollDown();
}
function addBot() {
  const d = document.createElement("div"); d.className = "msg bot";
  d.innerHTML = `<div class="card"><div class="working"><span class="dot"></span><span class="status">Thinking...</span></div><div class="md hidden"></div><details class="trace hidden"><summary></summary><div class="steps"></div></details><div class="meta"></div></div>`;
  $("#thread").appendChild(d); scrollDown(); return d;
}
function scrollDown() { const t = $("#thread"); t.scrollTop = t.scrollHeight; }
function renderStep(el, s) {
  const input = s.tool === "run_sql" ? s.input.query : JSON.stringify(s.input, null, 1);
  let out = s.output; try { out = JSON.stringify(JSON.parse(s.output), null, 1); } catch {}
  const div = document.createElement("div"); div.className = "step";
  div.innerHTML = `<div class="t${s.error ? " err" : ""}">${esc(s.tool)}${s.error ? " (error)" : ""}</div><pre>${esc(input)}</pre><details><summary>Result</summary><pre>${esc(out)}</pre></details>`;
  el.appendChild(div);
}

async function send(text) {
  text = text.trim(); if (!text || busy) return;
  busy = true; $("#send").disabled = true; $("#input").value = ""; autosize();
  addUser(text);
  const bot = addBot(); const status = bot.querySelector(".status"); const steps = bot.querySelector(".steps");
  const pending = [...api, { role: "user", content: text }];
  let nSteps = 0, tokens = 0; const t0 = performance.now(); let model = "";
  try {
    for (let i = 0; i < 8; i++) {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: pending }) });
      let j; try { j = await res.json(); } catch { throw new Error(`Server error (${res.status}). If this is a fresh deploy, check the function logs.`); }
      if (j.error) throw new Error(j.error);
      model = j.model; tokens += j.usage.input_tokens + j.usage.output_tokens;
      pending.push(...j.append);
      j.trace.forEach((s) => { nSteps++; renderStep(steps, s); });
      if (j.trace.length) {
        status.textContent = `${TOOL_LABEL[j.trace.at(-1).tool] || "Working"}... (${nSteps} tool call${nSteps > 1 ? "s" : ""})`;
        bot.querySelector(".trace").classList.remove("hidden");
        bot.querySelector("summary").textContent = `${nSteps} tool call${nSteps > 1 ? "s" : ""}: how I got this`;
      }
      if (j.done) {
        api = pending;
        bot.querySelector(".working").remove();
        const md = bot.querySelector(".md"); md.classList.remove("hidden");
        md.innerHTML = DOMPurify.sanitize(marked.parse(j.answer || "(no answer)"));
        bot.querySelector(".meta").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s · ${tokens.toLocaleString()} tokens · ${model}`;
        break;
      }
      if (i === 7) throw new Error("Hit the step limit. Try a narrower question.");
    }
  } catch (e) {
    bot.querySelector(".working")?.remove();
    const md = bot.querySelector(".md"); md.classList.remove("hidden");
    md.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    busy = false; $("#send").disabled = false; $("#input").focus(); scrollDown();
  }
}

$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send($("#input").value); });
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send($("#input").value); } });
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }
$("#input").addEventListener("input", autosize);
$("#new-chat").addEventListener("click", () => { if (busy) return; api = []; location.reload(); });

loadSummary(); loadEvals();
