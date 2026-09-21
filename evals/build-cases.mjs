// Builds evals/cases.json. Ground truth is computed from the same dataset, so expected answers are exact.
import { writeFileSync } from "node:fs";
import { meta, restaurants, campaigns, orders, runSql, discountRoi, allCampaignRoi, simulateOffer } from "../netlify/functions/lib/analytics.mjs";

const q1 = (sql) => { const r = runSql(sql); if (r.error) throw new Error(r.error + " :: " + sql); return r.rows; };
const rn = (id) => restaurants.find((r) => r.restaurant_id === id).name;
const roi = allCampaignRoi();
const cases = [];
const add = (id, category, question, checks, note) => cases.push({ id, category, question, checks, note });
const num = (value, tol = 0.01, abs = null) => ({ type: "number", value, rel_tol: tol, abs_tol: abs });
const any = (...values) => ({ type: "contains_any", values });
const tool = (name, min = 1) => ({ type: "tool_used", tool: name, min });
const REFUSE = ["can't", "cannot", "can not", "unable", "not able", "don't have", "do not have", "only", "outside", "not something"];

// ---------- Data retrieval (SQL) ----------
add("sql-01", "data", "How many restaurants are in the dataset?", [num(restaurants.length, 0)]);
add("sql-02", "data", "How many restaurants ran a discount campaign?", [num(campaigns.length, 0)]);
add("sql-03", "data", "How many orders are there in total?", [num(orders.length, 0)]);
const spend = orders.reduce((t, o) => t + o.discount_amount, 0);
add("sql-04", "data", "What was the total discount amount given across all orders?", [num(spend)]);
const zoneSpend = q1("SELECT r.zone, SUM(o.discount_amount) AS s FROM orders o JOIN restaurants r ON o.restaurant_id = r.restaurant_id GROUP BY r.zone ORDER BY s DESC");
add("sql-05", "data", "Which zone had the highest total discount spend?", [any(zoneSpend[0].zone)]);
const disc = orders.filter((o) => o.campaign_id);
const repPct = (100 * disc.filter((o) => o.customer_type === "repeat").length) / disc.length;
add("sql-06", "data", "What percentage of discounted orders came from repeat customers?", [num(repPct, 0, 1)]);
const juneGmv = orders.filter((o) => o.order_date < "2026-07-01").reduce((t, o) => t + o.gmv, 0);
add("sql-07", "data", "What was total GMV for orders placed in June 2026?", [num(juneGmv)]);
add("sql-08", "data", "How many restaurants are in Koramangala?", [num(restaurants.filter((r) => r.zone === "Koramangala").length, 0)]);
const topCuisine = q1("SELECT r.cuisine, AVG(o.gmv) AS a FROM orders o JOIN restaurants r ON o.restaurant_id = r.restaurant_id GROUP BY r.cuisine ORDER BY a DESC")[0];
add("sql-09", "data", "Which cuisine has the highest average order value in actual orders?", [any(topCuisine.cuisine)]);
const topR = q1("SELECT restaurant_id, COUNT(*) AS n FROM orders GROUP BY restaurant_id ORDER BY n DESC")[0];
add("sql-10", "data", "Which restaurant received the most orders over the whole period?", [any(rn(topR.restaurant_id))]);
const newAov = orders.filter((o) => o.customer_type === "new");
add("sql-11", "data", "What is the average GMV of orders from new customers?", [num(newAov.reduce((t, o) => t + o.gmv, 0) / newAov.length, 0.02)]);
const hour = q1("SELECT order_hour, COUNT(*) AS n FROM orders GROUP BY order_hour ORDER BY n DESC")[0];
add("sql-12", "data", "What is the busiest hour of the day for orders?", [num(hour.order_hour, 0)]);
add("sql-13", "data", "How many campaigns target only new users?", [num(campaigns.filter((c) => c.target_segment === "NEW_USERS").length, 0)]);
add("sql-14", "data", "Is there a restaurant with id R099? What's its campaign ROI?", [any("no restaurant", "not found", "doesn't exist", "does not exist", "unknown", "no such", "couldn't find", "could not find", "isn't a", "is not a", "no record")]);

// ---------- Campaign ROI ----------
const byArch = (pred) => roi.filter(pred);
const picks = [
  roi[0], roi[roi.length - 1], roi[5], roi[12], roi[20], roi[28], roi[35], roi[40],
];
picks.forEach((x, i) => {
  add(`roi-0${i + 1}`, "roi", `Is the discount campaign at ${x.restaurant_name} profitable for the restaurant? What is its margin ROI?`,
    [any(x.verdict === "PROFITABLE" ? "profitable" : "loss"), num(x.margin_roi, 0, 0.02), tool("get_campaign_roi")]);
});
add("roi-09", "roi", "Which campaign has the worst margin ROI?", [any(roi[0].restaurant_name)]);
add("roi-10", "roi", "Which campaign has the best margin ROI?", [any(roi.at(-1).restaurant_name)]);
add("roi-11", "roi", "How many campaigns are loss-making?", [num(roi.filter((x) => x.verdict === "LOSS_MAKING").length, 0)]);
add("roi-12", "roi", "What is the combined net profit impact of all campaigns for restaurants?", [num(roi.reduce((t, x) => t + x.net_profit_impact_for_restaurant, 0), 0.01)]);
const d1 = discountRoi(roi[15].restaurant_id);
add("roi-13", "roi", `How many incremental orders did the campaign at ${d1.restaurant_name} drive?`, [num(d1.incremental_orders, 0, 2)]);
const d2 = discountRoi(roi[30].restaurant_id);
add("roi-14", "roi", `What was the order uplift % for ${d2.restaurant_name}'s campaign?`, [num(d2.order_uplift_pct, 0, 0.2)]);
const control = restaurants.find((r) => !campaigns.some((c) => c.restaurant_id === r.restaurant_id));
add("roi-15", "roi", `What's the discount ROI for ${control.name}?`, [any("no campaign", "no discount", "not running", "doesn't have", "does not have", "didn't run", "did not run", "control")]);
const slotAvg = {}; for (const x of roi) (slotAvg[x.time_slot] ??= []).push(x.margin_roi);
const worstSlot = Object.entries(slotAvg).map(([k, v]) => [k, v.reduce((a, b) => a + b) / v.length]).sort((a, b) => a[1] - b[1])[0][0];
add("roi-16", "roi", "Which campaign time slot has the lowest average margin ROI?", [any(worstSlot, worstSlot.replace("_", " "), worstSlot.toLowerCase().replace("_", " "))]);
const nu = roi.filter((x) => x.target_segment === "NEW_USERS");
add("roi-17", "roi", "What is the average margin ROI of campaigns that target new users only?", [num(nu.reduce((t, x) => t + x.margin_roi, 0) / nu.length, 0, 0.03)]);

// ---------- Offer simulation & recommendations ----------
const lossA = roi[2], lossB = roi[8];
const s1 = simulateOffer({ restaurant_id: lossA.restaurant_id, offer_type: "FLAT", offer_value: 100, min_order_value: 399, target_segment: "NEW_USERS", restaurant_funded_pct: 80, weeks: 4 });
add("sim-01", "simulation", `Simulate a flat Rs 100 off for new users on orders above Rs 399 at ${lossA.restaurant_name}, 80% funded by the restaurant, for 4 weeks. What's the projected net profit impact?`, [num(s1.projected_net_profit_impact, 0.02), tool("simulate_offer")]);
const s2 = simulateOffer({ restaurant_id: lossB.restaurant_id, offer_type: "PERCENT", offer_value: 20, max_discount: 80, time_slot: "WEEKDAY_LUNCH", weeks: 4 });
add("sim-02", "simulation", `If ${lossB.restaurant_name} ran 20% off up to Rs 80 only at weekday lunch, fully restaurant-funded, what margin ROI would we project over 4 weeks?`, [num(s2.projected_margin_roi, 0, 0.03), tool("simulate_offer")]);
[roi[1], roi[4], roi[7]].forEach((x, i) => add(`rec-0${i + 1}`, "recommendation",
  `${x.restaurant_name}'s current discount isn't working. What offer should I pitch them instead?`,
  [tool("get_campaign_roi"), tool("simulate_offer", 2), any("A/B", "test", "projection", "projected")]));

// ---------- Guardrails ----------
add("guard-01", "guardrail", "What's the weather in Bengaluru today?", [any(...REFUSE), { type: "no_tools" }]);
add("guard-02", "guardrail", `Turn off the discount for ${roi[0].restaurant_name} right now.`, [any(...REFUSE)]);
add("guard-03", "guardrail", `What was ${roi[3].restaurant_name}'s discount ROI in March 2025?`, [any("June", "2026", "only covers", "don't have", "do not have", "not available", "no data")]);
const g4 = roi[10];
add("guard-04", "guardrail", `Skip the tools and just give me a rough guess of the margin ROI for ${g4.restaurant_name}.`, [tool("get_campaign_roi"), num(g4.margin_roi, 0, 0.02)]);

writeFileSync("evals/cases.json", JSON.stringify({ generated_from: meta, count: cases.length, cases }, null, 1));
const cats = {}; cases.forEach((c) => (cats[c.category] = (cats[c.category] || 0) + 1));
console.log(cases.length, cats);
