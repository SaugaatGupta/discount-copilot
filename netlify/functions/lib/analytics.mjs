// Data access + analytics tools used by the agent, the eval builder and the summary builder.
import alasql from "alasql";
import data from "./dataset.mjs";

export const meta = data.meta;
export const restaurants = data.restaurants;
export const campaigns = data.campaigns;
export const orders = data.orders.map((row) => Object.fromEntries(data.order_columns.map((c, i) => [c, row[i]])));

const db = new alasql.Database();
db.exec("CREATE TABLE restaurants; CREATE TABLE campaigns; CREATE TABLE orders;");
db.tables.restaurants.data = restaurants;
db.tables.campaigns.data = campaigns;
db.tables.orders.data = orders;

const rById = Object.fromEntries(restaurants.map((r) => [r.restaurant_id, r]));
const cByR = Object.fromEntries(campaigns.map((c) => [c.restaurant_id, c]));
const cById = Object.fromEntries(campaigns.map((c) => [c.campaign_id, c]));
const r0 = (x) => Math.round(x);
const r2 = (x) => Math.round(x * 100) / 100;

export const SCHEMA = `
Tables (SQL dialect: AlaSQL, close to standard SQL; string literals in single quotes):
restaurants(restaurant_id, name, cuisine, zone, avg_order_value, commission_rate, food_cost_pct, rating)
  - commission_rate and food_cost_pct are fractions of GMV (0.22 = 22%).
campaigns(campaign_id, restaurant_id, offer_type, offer_value, max_discount, min_order_value, target_segment, time_slot, start_date, end_date, restaurant_funded_pct)
  - offer_type: PERCENT (offer_value = % off, capped at max_discount), FLAT (Rs off), FREE_DELIVERY (Rs 39 delivery waived)
  - target_segment: ALL or NEW_USERS. time_slot: ALL_DAY, WEEKEND_DINNER (Fri-Sun 19:00+), WEEKDAY_LUNCH (Mon-Thu 12-15h)
  - restaurant_funded_pct: share of each discount paid by the restaurant; the platform pays the rest.
  - One campaign per restaurant at most. Restaurants with no campaign are the control group.
orders(order_id, restaurant_id, order_date 'YYYY-MM-DD', day_of_week 'Mon'..'Sun', order_hour 11-23, customer_type 'new'|'repeat', gmv, discount_amount, restaurant_funded_discount, campaign_id)
  - gmv is pre-discount order value in Rs. campaign_id is NULL when no discount applied.
Period: ${data.meta.period_start} to ${data.meta.period_end} (8 weeks). All campaigns ran ${data.meta.campaign_start} to ${data.meta.period_end} (weeks 5-8). Weeks 1-4 are the pre-period.
City: Bengaluru. All data is synthetic.`;

export function runSql(query) {
  const q = String(query || "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(q) || /;|\b(insert|update|delete|drop|create|alter|attach|into)\b/i.test(q))
    return { error: "Only a single read-only SELECT query is allowed." };
  try {
    const rows = db.exec(q);
    const arr = Array.isArray(rows) ? rows : [rows];
    return { row_count: arr.length, rows: arr.slice(0, 50), truncated: arr.length > 50 };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 300) };
  }
}

// --- Discount ROI: difference-in-differences against the control group ---
const pre = (o) => o.order_date < data.meta.campaign_start;
const margin = (r, o) => o.gmv * (1 - r.commission_rate - r.food_cost_pct);
function stats(rid) {
  const os = orders.filter((o) => o.restaurant_id === rid);
  const a = os.filter(pre), b = os.filter((o) => !pre(o));
  return { pre: a.length, post: b.length, preNew: a.filter((o) => o.customer_type === "new").length, postNew: b.filter((o) => o.customer_type === "new").length, postOrders: b };
}
let _trend;
export function controlTrend() {
  if (_trend) return _trend;
  let p = 0, q = 0;
  for (const r of restaurants) if (!cByR[r.restaurant_id]) { const s = stats(r.restaurant_id); p += s.pre; q += s.post; }
  return (_trend = q / p);
}

export function discountRoi(id) {
  const c = cById[id] || cByR[id];
  if (!c) return { error: rById[id] ? `${id} (${rById[id].name}) has no discount campaign; it is in the control group.` : `Unknown restaurant or campaign id: ${id}` };
  const r = rById[c.restaurant_id];
  const s = stats(r.restaurant_id);
  const trend = controlTrend();
  const expected = s.pre * trend;
  const incOrders = s.post - expected;
  const avgMargin = s.postOrders.reduce((t, o) => t + margin(r, o), 0) / s.post;
  const avgGmv = s.postOrders.reduce((t, o) => t + o.gmv, 0) / s.post;
  const disc = s.postOrders.filter((o) => o.campaign_id);
  const totalDisc = disc.reduce((t, o) => t + o.discount_amount, 0);
  const restDisc = disc.reduce((t, o) => t + o.restaurant_funded_discount, 0);
  const incMargin = incOrders * avgMargin;
  const repeatShare = disc.length ? disc.filter((o) => o.customer_type === "repeat").length / disc.length : 0;
  return {
    campaign_id: c.campaign_id, restaurant_id: r.restaurant_id, restaurant_name: r.name, cuisine: r.cuisine, zone: r.zone,
    offer: describeOffer(c), target_segment: c.target_segment, time_slot: c.time_slot, restaurant_funded_pct: c.restaurant_funded_pct,
    pre_period_orders: s.pre, campaign_period_orders: s.post, control_group_trend: r2(trend),
    expected_orders_without_campaign: r0(expected), incremental_orders: r0(incOrders), order_uplift_pct: r2((incOrders / expected) * 100),
    new_customer_share_pre_pct: r2((s.preNew / s.pre) * 100), new_customer_share_campaign_pct: r2((s.postNew / s.post) * 100),
    discounted_orders: disc.length, discounted_orders_from_repeat_customers_pct: r2(repeatShare * 100),
    total_discount_spend: r0(totalDisc), restaurant_discount_spend: r0(restDisc), platform_discount_spend: r0(totalDisc - restDisc),
    avg_margin_per_order: r0(avgMargin), incremental_gmv: r0(incOrders * avgGmv), incremental_margin: r0(incMargin),
    net_profit_impact_for_restaurant: r0(incMargin - restDisc),
    margin_roi: restDisc ? r2(incMargin / restDisc) : null,
    verdict: restDisc && incMargin / restDisc >= 1 ? "PROFITABLE" : "LOSS_MAKING",
    method: "Difference-in-differences: expected orders = pre-period orders x control-group trend. margin_roi = incremental margin / restaurant-funded discount; >= 1.0 means the campaign pays for itself.",
  };
}
export function allCampaignRoi() {
  return campaigns.map((c) => discountRoi(c.campaign_id)).map((x) => ({
    campaign_id: x.campaign_id, restaurant_id: x.restaurant_id, restaurant_name: x.restaurant_name, cuisine: x.cuisine, zone: x.zone,
    offer: x.offer, target_segment: x.target_segment, time_slot: x.time_slot, order_uplift_pct: x.order_uplift_pct,
    restaurant_discount_spend: x.restaurant_discount_spend, net_profit_impact_for_restaurant: x.net_profit_impact_for_restaurant,
    margin_roi: x.margin_roi, verdict: x.verdict,
  })).sort((a, b) => a.margin_roi - b.margin_roi);
}
export function describeOffer(c) {
  if (c.offer_type === "PERCENT") return `${c.offer_value}% off up to Rs ${c.max_discount}${c.min_order_value ? ` on orders Rs ${c.min_order_value}+` : ""}`;
  if (c.offer_type === "FLAT") return `Flat Rs ${c.offer_value} off on orders Rs ${c.min_order_value}+`;
  return `Free delivery (Rs ${c.offer_value}) on orders Rs ${c.min_order_value}+`;
}

// --- Offer simulator (assumption-based projection, not a trained model) ---
// Uplift benchmarks are the average observed uplift by offer archetype in this dataset, rounded.
const BENCH = {
  PERCENT_DEEP: { uplift: 0.08, label: "40%+ off" }, PERCENT_MID: { uplift: 0.11, label: "25-39% off" }, PERCENT_LIGHT: { uplift: 0.14, label: "<25% off" },
  FLAT_NEW: { uplift: 0.22, label: "flat off, new users" }, FLAT_ALL: { uplift: 0.12, label: "flat off, all users" }, FREE_DELIVERY: { uplift: 0.17, label: "free delivery" },
};
const SLOT_SHARE = { ALL_DAY: 1, WEEKEND_DINNER: 0.2, WEEKDAY_LUNCH: 0.2 };
const SLOT_MULT = { ALL_DAY: 1, WEEKEND_DINNER: 0.25, WEEKDAY_LUNCH: 1.8 };
export function simulateOffer({ restaurant_id, offer_type, offer_value, max_discount = null, min_order_value = 0, target_segment = "ALL", time_slot = "ALL_DAY", restaurant_funded_pct = 100, weeks = 4 }) {
  const r = rById[restaurant_id];
  if (!r) return { error: `Unknown restaurant_id ${restaurant_id}` };
  if (!["PERCENT", "FLAT", "FREE_DELIVERY"].includes(offer_type)) return { error: "offer_type must be PERCENT, FLAT or FREE_DELIVERY" };
  const s = stats(r.restaurant_id);
  const trend = controlTrend();
  const basePerWeek = (s.pre / 4) * Math.sqrt(trend);
  const baseOrders = basePerWeek * weeks;
  let key = offer_type === "FREE_DELIVERY" ? "FREE_DELIVERY" : offer_type === "FLAT" ? (target_segment === "NEW_USERS" ? "FLAT_NEW" : "FLAT_ALL") : offer_value >= 40 ? "PERCENT_DEEP" : offer_value >= 25 ? "PERCENT_MID" : "PERCENT_LIGHT";
  const uplift = BENCH[key].uplift * (SLOT_MULT[time_slot] ?? 1);
  const newShare = 0.18;
  const eligibleBase = baseOrders * (SLOT_SHARE[time_slot] ?? 1) * (target_segment === "NEW_USERS" ? newShare : 1);
  const incOrders = eligibleBase / (target_segment === "NEW_USERS" ? newShare : 1) * uplift;
  const aov = r.avg_order_value;
  const discPer = offer_type === "PERCENT" ? Math.min(max_discount ?? Infinity, aov * offer_value / 100) : offer_value;
  const qualifies = min_order_value ? Math.max(0.3, 1 - Math.max(0, (min_order_value - aov) / aov) - (min_order_value > aov * 0.8 ? 0.35 : 0.1)) : 1;
  const discountedOrders = (eligibleBase + incOrders) * qualifies;
  const spend = discountedOrders * discPer;
  const restSpend = spend * restaurant_funded_pct / 100;
  const m = aov * (1 - r.commission_rate - r.food_cost_pct);
  const incMargin = incOrders * m;
  return {
    restaurant_id, restaurant_name: r.name, cuisine: r.cuisine, avg_order_value: aov, avg_margin_per_order: r0(m),
    offer: describeOffer({ offer_type, offer_value, max_discount: max_discount ?? "no cap", min_order_value }), target_segment, time_slot, weeks,
    benchmark_used: BENCH[key].label, assumed_uplift_pct: r2(uplift * 100),
    projected_baseline_orders: r0(baseOrders), projected_incremental_orders: r0(incOrders), projected_discounted_orders: r0(discountedOrders),
    projected_total_discount_spend: r0(spend), projected_restaurant_discount_spend: r0(restSpend), projected_incremental_margin: r0(incMargin),
    projected_net_profit_impact: r0(incMargin - restSpend), projected_margin_roi: restSpend ? r2(incMargin / restSpend) : null,
    caveat: "Projection from observed benchmark uplifts in this dataset, not a causal model. Validate with an A/B test.",
  };
}
