# Discount Copilot

A GenAI copilot for food-delivery sales reps. Reps ask in plain English whether a restaurant's discount is working, which campaigns are losing money, and what offer to pitch instead. A Claude agent answers by calling tools over the data, and every answer shows the queries behind it.

Concept prototype. All restaurants, orders and campaigns are synthetic. Not affiliated with any company.

## What's inside

| Piece | Where | What it does |
|---|---|---|
| Web app | `public/` | Portfolio sidebar (KPIs, ROI per restaurant), chat, tool-call trace, eval results tab |
| Agent | `netlify/functions/lib/agent.mjs` | The tool-using agent: system prompt, tools and guardrails |
| Providers | `netlify/functions/lib/providers.mjs` | Talks to Anthropic, or any OpenAI-compatible API (Groq, Gemini, OpenRouter, OpenAI) |
| API | `netlify/functions/chat.mjs` | `POST /api/chat`: runs one agent step per request, so each call stays inside serverless time limits |
| Tools | `netlify/functions/lib/analytics.mjs` | `run_sql` (read-only AlaSQL), `get_campaign_roi` (difference-in-differences vs control group), `simulate_offer` |
| Data | `scripts/generate-data.mjs` | Seeded generator: 60 restaurants, 45 campaigns, ~50K orders over 8 weeks |
| Eval harness | `evals/` | 40 cases with ground truth computed from the data, graded on numbers, tool use and guardrails |

### How ROI is measured
- Weeks 1-4 are the pre-period, and campaigns run in weeks 5-8. The 15 restaurants with no campaign are the control group.
- `expected orders = pre-period orders x control-group trend` and `incremental orders = actual - expected`
- `margin ROI = incremental margin / restaurant-funded discount`. A value of 1.0x or higher means the campaign pays for itself.

### Patterns planted in the data (for the agent to find)
1. Deep % discounts (50% off) on high-AOV restaurants: a big discount bill for a small order lift
2. Blanket "all users" discounts: most of the spend goes to repeat customers who would have ordered anyway
3. Discounts in the weekend dinner slot: demand is already at peak, so they drive almost no extra orders

Targeted offers (a flat discount for new users, free delivery on low-AOV orders, off-peak weekday lunch) generally pay back.

## Deploy to Netlify (about 10 minutes)

The app has a serverless function with an npm dependency, so deploy with Git or the Netlify CLI. Netlify Drop (drag and drop) only hosts static files, so the chat won't work there.

**Option A: GitHub (recommended)**
1. Create a new GitHub repo and push this folder to it.
2. In Netlify, go to **Add new site > Import an existing project** and pick the repo. The defaults come from `netlify.toml`, so there's nothing to fill in.
3. Go to **Site configuration > Environment variables** and add one API key (see "Which model" below), for example `GROQ_API_KEY` or `ANTHROPIC_API_KEY`.
4. Redeploy, then open the site and try a suggested question.

**Option B: Netlify CLI**
```bash
npm install
npm install -g netlify-cli
netlify login
netlify init          # create the site
netlify env:set GROQ_API_KEY gsk_...      # or ANTHROPIC_API_KEY, GEMINI_API_KEY, ...
netlify deploy --prod
```

### Which model answers

Set exactly one API key and the app picks the provider for you. Nothing else to configure.

| Env variable | Provider | Default model | Cost |
|---|---|---|---|
| `GROQ_API_KEY` | Groq | `openai/gpt-oss-120b` | Free tier, no card |
| `GEMINI_API_KEY` | Google Gemini | `gemini-2.5-flash` | Free tier, no card |
| `OPENROUTER_API_KEY` | OpenRouter | set `LLM_MODEL` yourself | Free models available |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-5` | Paid, best quality |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o-mini` | Paid |

Optional overrides: `LLM_MODEL` (any model the provider offers), `LLM_PROVIDER` (force one when several keys are set), and `LLM_BASE_URL` with `LLM_PROVIDER=custom` for any other OpenAI-compatible endpoint. The model in use is shown under every answer.

Free tiers have per-minute limits, so a question may occasionally fail with a rate-limit error. Wait a few seconds and ask again, or switch keys.

**Cost control (paid keys):** a typical question uses 10-20K tokens. Set a monthly spend limit before you share the link publicly.

## Run the evals

```bash
node evals/run.mjs --url https://YOUR-SITE.netlify.app
```
This prints pass/fail per case and writes:
- `evals/report.md`: failures, with the agent's answers
- `public/eval-report.json`: shown in the app's Evals tab after you commit and redeploy

Use `--only roi,guardrail` to run a subset. Iterate on the system prompt in `agent.mjs`, rerun, and track the score.

## Local development

```bash
npm install
GROQ_API_KEY=gsk_... node scripts/dev-server.mjs            # http://localhost:8888
MOCK=1 node scripts/dev-server.mjs                          # UI only, scripted fake answers
node scripts/test-agent.mjs                                 # offline tests, no API key needed
npm run generate                                            # regenerate data, summary and eval cases
```
