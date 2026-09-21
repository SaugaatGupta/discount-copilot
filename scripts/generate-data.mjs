// Generates a deterministic synthetic dataset: 60 restaurants, their discount campaigns,
// and ~50K orders across 8 weeks. Output: netlify/functions/lib/dataset.mjs
// All names and numbers are fictional.
import { writeFileSync } from "node:fs";

let seed = 20260920;
function rand() { // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];
const normal = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const poisson = (l) => { if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * normal())); let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rand(); } while (p > L); return k - 1; };
const r2 = (x) => Math.round(x * 100) / 100;

const CUISINES = {
  "Biryani":      { aov: 420, words: ["Biryani House", "Dum Kitchen", "Biryani Co."] },
  "North Indian": { aov: 480, words: ["Dhaba", "Tandoor", "Punjabi Rasoi"] },
  "South Indian": { aov: 240, words: ["Tiffins", "Idli Corner", "Darshini"] },
  "Pizza":        { aov: 520, words: ["Pizzeria", "Slice Lab", "Wood Fire"] },
  "Burgers":      { aov: 330, words: ["Burger Bar", "Grill Shack", "Patty Co."] },
  "Chinese":      { aov: 390, words: ["Wok", "Noodle Bar", "Dragon Bowl"] },
  "Desserts":     { aov: 260, words: ["Creamery", "Sweet Studio", "Waffle Bay"] },
  "Healthy":      { aov: 380, words: ["Bowls", "Green Kitchen", "Salad Co."] },
  "Cafe":         { aov: 290, words: ["Cafe", "Brew House", "Coffee Room"] },
  "Fine Dine":    { aov: 1150, words: ["Bistro", "Supper Club", "Kitchen & Bar"] },
};
const PREFIX = ["Copper", "Saffron", "Banyan", "Monsoon", "Indigo", "Terrace", "Cedar", "Lantern", "Pepper", "Cardamom", "Ember", "Marigold", "Tamarind", "Jasmine", "Basil", "Kokum", "Cinder", "Harbour", "Palmyra", "Nilgiri"];
const ZONES = ["Koramangala", "Indiranagar", "HSR Layout", "Whitefield", "Jayanagar", "Marathahalli"];

// Campaign archetypes. uplift = true incremental lift in eligible slot (hidden from the model).
const ARCHETYPES = {
  A: { n: 8,  cuisines: ["Fine Dine", "North Indian", "Pizza"], offer_type: "PERCENT", offer_value: 50, max_discount: 300, min_order_value: 0,   target_segment: "ALL",       time_slot: "ALL_DAY",        funded: 100, uplift: 0.08, newShareInc: 0.25 },
  B: { n: 10, cuisines: ["Biryani", "Chinese", "North Indian", "Healthy"], offer_type: "PERCENT", offer_value: 30, max_discount: 120, min_order_value: 0, target_segment: "ALL", time_slot: "ALL_DAY", funded: 100, uplift: 0.10, newShareInc: 0.22 },
  C: { n: 8,  cuisines: ["Biryani", "Chinese", "Healthy", "Pizza", "North Indian"], offer_type: "FLAT", offer_value: 100, max_discount: 100, min_order_value: 399, target_segment: "NEW_USERS", time_slot: "ALL_DAY", funded: 80, uplift: 0.22, newShareInc: 1 },
  D: { n: 8,  cuisines: ["Cafe", "Desserts", "Burgers", "South Indian"], offer_type: "FREE_DELIVERY", offer_value: 39, max_discount: 39, min_order_value: 199, target_segment: "ALL", time_slot: "ALL_DAY", funded: 60, uplift: 0.22, newShareInc: 0.3 },
  E: { n: 6,  cuisines: ["Burgers", "Pizza", "Chinese", "Biryani"], offer_type: "PERCENT", offer_value: 40, max_discount: 150, min_order_value: 0, target_segment: "ALL", time_slot: "WEEKEND_DINNER", funded: 100, uplift: 0.02, newShareInc: 0.25 },
  F: { n: 5,  cuisines: ["South Indian", "Healthy", "Cafe", "Biryani"], offer_type: "PERCENT", offer_value: 20, max_discount: 80, min_order_value: 0, target_segment: "ALL", time_slot: "WEEKDAY_LUNCH", funded: 100, uplift: 0.45, newShareInc: 0.35 },
};

const START = new Date(Date.UTC(2026, 5, 1)); // Mon 1 Jun 2026
const DAYS = 56, CAMPAIGN_START_DAY = 28;
const dateStr = (d) => new Date(START.getTime() + d * 864e5).toISOString().slice(0, 10);
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_F = [0.88, 0.86, 0.9, 0.93, 1.12, 1.32, 1.27];
const HOURS = [[11,.04],[12,.1],[13,.13],[14,.08],[15,.04],[16,.04],[17,.05],[18,.07],[19,.11],[20,.14],[21,.11],[22,.06],[23,.03]];
const pickHour = () => { let x = rand(), c = 0; for (const [h, p] of HOURS) { c += p; if (x < c) return h; } return 20; };
const inSlot = (slot, dow, hour) => slot === "ALL_DAY" || (slot === "WEEKEND_DINNER" && dow >= 4 && hour >= 19) || (slot === "WEEKDAY_LUNCH" && dow <= 3 && hour >= 12 && hour <= 15);

// Restaurants
const restaurants = [];
const usedNames = new Set();
const cuisineList = Object.keys(CUISINES);
for (let i = 0; i < 60; i++) {
  const cuisine = cuisineList[i % cuisineList.length];
  let name; do { name = `${pick(PREFIX)} ${pick(CUISINES[cuisine].words)}`; } while (usedNames.has(name)); usedNames.add(name);
  restaurants.push({
    restaurant_id: `R${String(i + 1).padStart(3, "0")}`, name, cuisine, zone: ZONES[i % ZONES.length],
    avg_order_value: Math.round(CUISINES[cuisine].aov * (0.85 + rand() * 0.3)),
    commission_rate: r2(0.18 + Math.floor(rand() * 8) / 100),
    food_cost_pct: r2(0.28 + Math.floor(rand() * 10) / 100),
    rating: r2(3.7 + rand() * 0.9),
    _base: 8 + rand() * 10,
  });
}

// Assign campaigns
const campaigns = []; const campaignOf = {};
const free = new Set(restaurants.map((r) => r.restaurant_id));
let cid = 1;
for (const [key, a] of Object.entries(ARCHETYPES)) {
  let count = 0;
  for (const r of restaurants) {
    if (count >= a.n) break;
    if (!free.has(r.restaurant_id) || !a.cuisines.includes(r.cuisine)) continue;
    if (key === "A" && r.avg_order_value < 480) continue;
    free.delete(r.restaurant_id); count++;
    const c = { campaign_id: `C${String(cid++).padStart(3, "0")}`, restaurant_id: r.restaurant_id,
      offer_type: a.offer_type, offer_value: a.offer_value, max_discount: a.max_discount, min_order_value: a.min_order_value,
      target_segment: a.target_segment, time_slot: a.time_slot, start_date: dateStr(CAMPAIGN_START_DAY), end_date: dateStr(DAYS - 1),
      restaurant_funded_pct: a.funded, _arch: key, _uplift: Math.max(0, a.uplift + normal() * 0.025), _newShareInc: a.newShareInc };
    campaigns.push(c); campaignOf[r.restaurant_id] = c;
  }
}

// Orders
const orders = []; let oid = 100000;
function discountFor(c, gmv) {
  if (gmv < c.min_order_value) return 0;
  if (c.offer_type === "PERCENT") return Math.min(c.max_discount, Math.round(gmv * c.offer_value / 100));
  return c.offer_value;
}
for (const r of restaurants) {
  const c = campaignOf[r.restaurant_id];
  for (let d = 0; d < DAYS; d++) {
    const dow = d % 7, week = Math.floor(d / 7);
    const lam = r._base * DOW_F[dow] * (1 + 0.015 * week);
    const n = poisson(lam);
    const mk = (hour, incremental) => {
      const gmv = Math.max(120, Math.round(r.avg_order_value * (1 + 0.25 * normal())));
      let isNew = rand() < 0.18;
      if (incremental) isNew = rand() < c._newShareInc || c.target_segment === "NEW_USERS";
      let disc = 0, cId = null;
      if (c && d >= CAMPAIGN_START_DAY && inSlot(c.time_slot, dow, hour) && (c.target_segment === "ALL" || isNew)) {
        disc = discountFor(c, gmv); if (disc > 0) cId = c.campaign_id;
      }
      orders.push([oid++, r.restaurant_id, dateStr(d), DOW[dow], hour, isNew ? "new" : "repeat", gmv, disc,
        Math.round(disc * (c ? c.restaurant_funded_pct : 0) / 100), cId]);
    };
    const hours = []; for (let k = 0; k < n; k++) hours.push(pickHour());
    hours.forEach((h) => mk(h, false));
    if (c && d >= CAMPAIGN_START_DAY) { // incremental orders caused by the campaign
      const eligible = hours.filter((h) => inSlot(c.time_slot, dow, h)).length;
      const inc = poisson(eligible * c._uplift);
      for (let k = 0; k < inc; k++) { let h; do { h = pickHour(); } while (!inSlot(c.time_slot, dow, h)); mk(h, true); }
    }
  }
}
orders.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0]));

const pub = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));
const out = {
  meta: { city: "Bengaluru", period_start: dateStr(0), period_end: dateStr(DAYS - 1), campaign_start: dateStr(CAMPAIGN_START_DAY), note: "Synthetic data for a concept prototype. Not real restaurants or orders." },
  restaurants: restaurants.map(pub), campaigns: campaigns.map(pub),
  order_columns: ["order_id", "restaurant_id", "order_date", "day_of_week", "order_hour", "customer_type", "gmv", "discount_amount", "restaurant_funded_discount", "campaign_id"],
  orders,
};
writeFileSync("netlify/functions/lib/dataset.mjs", "// Generated by scripts/generate-data.mjs. Synthetic data.\nexport default " + JSON.stringify(out) + ";\n");
writeFileSync("scripts/.truth.json", JSON.stringify(campaigns.map((c) => ({ id: c.campaign_id, r: c.restaurant_id, arch: c._arch, uplift: c._uplift })), null, 1));
console.log(`restaurants=${restaurants.length} campaigns=${campaigns.length} orders=${orders.length}`);
