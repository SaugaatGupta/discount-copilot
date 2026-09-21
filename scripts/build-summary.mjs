// Precomputes the sidebar dashboard data: public/summary.json
import { writeFileSync } from "node:fs";
import { meta, restaurants, campaigns, orders, allCampaignRoi, controlTrend } from "../netlify/functions/lib/analytics.mjs";

const roi = allCampaignRoi();
const byR = Object.fromEntries(roi.map((x) => [x.restaurant_id, x]));
const post = orders.filter((o) => o.order_date >= meta.campaign_start);
const spend = post.reduce((t, o) => t + o.discount_amount, 0);
const restSpend = post.reduce((t, o) => t + o.restaurant_funded_discount, 0);
const loss = roi.filter((x) => x.verdict === "LOSS_MAKING");
const summary = {
  meta: { ...meta, orders: orders.length, control_trend: Math.round(controlTrend() * 1000) / 1000 },
  kpis: {
    restaurants: restaurants.length, active_campaigns: campaigns.length,
    discount_spend: Math.round(spend), restaurant_funded_spend: Math.round(restSpend),
    loss_making_campaigns: loss.length,
    net_profit_impact: roi.reduce((t, x) => t + x.net_profit_impact_for_restaurant, 0),
    loss_from_loss_making: loss.reduce((t, x) => t + x.net_profit_impact_for_restaurant, 0),
  },
  restaurants: restaurants.map((r) => ({ id: r.restaurant_id, name: r.name, cuisine: r.cuisine, zone: r.zone,
    offer: byR[r.restaurant_id]?.offer || null, margin_roi: byR[r.restaurant_id]?.margin_roi ?? null,
    net: byR[r.restaurant_id]?.net_profit_impact_for_restaurant ?? null, verdict: byR[r.restaurant_id]?.verdict || "NO_CAMPAIGN" })),
};
writeFileSync("public/summary.json", JSON.stringify(summary, null, 1));
console.log(summary.kpis);
