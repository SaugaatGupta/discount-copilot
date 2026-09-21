# PRD: Discount Copilot for restaurant sales reps

**Status:** Prototype · **Owner:** Saugaat Gupta · **Data:** synthetic

## 1. Problem
Food-delivery sales reps manage dozens of restaurant partners each and are measured on partner growth. Discounts are their main lever. They can't easily tell whether a campaign is creating new demand or just giving money back to customers who would have ordered anyway.

- Checking a campaign today means asking analytics for a cut, then waiting days
- Reps renew whatever ran last time, so loss-making offers keep running and partners churn when they see the margin hit
- Pitches rest on intuition rather than numbers the restaurant owner can trust

In the prototype's data, **31 of 45 campaigns lose money for the restaurant**, and most of the discount spend goes to repeat customers.

## 2. Users and jobs to be done
| User | Job |
|---|---|
| Sales rep (primary) | "Before my partner meeting, tell me if their discount is working and what to pitch instead, with numbers I can show." |
| Sales manager | "Show me which campaigns in my team's book are burning partner margin." |
| Category / growth team | "Which offer types work, for which cuisines and time slots?" |

## 3. Goals and success metrics
| Metric | Target (pilot) |
|---|---|
| Rep weekly active usage | 60% of pilot reps |
| Time to answer "is this discount working?" | Under 1 minute, from days today |
| Share of renewals changed to a better-ROI offer | 25% |
| Partner margin ROI on campaigns touched by the copilot | +0.3x vs control reps |
| Answer accuracy on eval set | 90% or higher before rollout, tracked every release |

**Guardrail metrics:** hallucinated numbers (target 0 in evals), partner complaints, cost per answer.

## 4. Solution
A chat copilot backed by a tool-using LLM agent:
- **run_sql:** read-only queries over orders, restaurants and campaigns
- **get_campaign_roi:** a difference-in-differences read against a no-discount control group, returning uplift, spend, margin ROI and a verdict
- **simulate_offer:** a benchmark-based projection for a proposed offer (type, depth, cap, segment, time slot, funding split)
- A portfolio sidebar ranks every campaign by margin ROI, so reps can start from the worst ones

**Trust design:** every number must come from a tool result, the tool trace sits under each answer, simulations are labelled as projections to A/B test, and the agent declines actions it can't take (such as changing a live campaign).

## 5. Scope
**In (v1):** Q&A on campaign performance, loss-making campaign detection, offer comparison and pitch line, eval harness.

**Out (later):** writing campaign changes back to the partner tool, CRM integration, per-rep book filtering, auto-generated partner decks, causal uplift models to replace the benchmarks.

## 6. Evaluation
There are 40 test cases with ground truth computed from the data:
- 14 data retrieval
- 17 ROI
- 2 simulation
- 3 recommendation
- 4 guardrail

Checks cover numeric accuracy with tolerance, required tool use (for example, a recommendation must simulate at least 2 options) and refusals. The harness runs against any deployment, and results show in the app.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Wrong number shown to a partner | Tool-only numbers, visible trace, eval gate before release |
| Simulations over-trusted | Labelled as projections, with an A/B test recommendation |
| Cost and latency | One model call per request, step limit, option to switch to a smaller model |
| Prompt misuse | Read-only SQL, input limits, scope limited to discounts and sales |

## 8. Rollout
1. Pilot with 10 reps in one city for 4 weeks, with a matched control group of reps
2. Weekly eval and failure review, and prompt and tool fixes
3. Expand to category teams, then add write-back to the campaign tool
