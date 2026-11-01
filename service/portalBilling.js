"use strict";
// CLIENT PORTAL BILLING - PR 3 (David, Nov 1 2026).
//
// One BILLING RECORD per client EMAIL (key pbill_<sha256(email)>): a client with
// several inspectors (PR 2) has one login, one trial and one Stripe subscription,
// and pays for ALL its properties across every inspector, each counted once.
//
// Rules (David):
//   * 15 free days (setting), counted from the first portal account of that email -
//     or from billing go-live for logins that existed before billing was switched on.
//   * then a per-property price, billed monthly (annual at a discount is offered too).
//     EVERY number is a setting (price, intro price, trial days, annual discount) kept in
//     one config document that only E3 Admin can change - nothing is hard-coded.
//   * not paid -> locked. Only E3 Admin can waive ("complimentary"); inspectors cannot.
//   * nothing happens at all until E3 Admin switches billing ON *and* STRIPE_SECRET_KEY
//     is set - until then the portal stays free for everyone exactly as in PR 1/2.
//
// Pure key-value on ProjectReports (same reason as model/portalAccess.js: no indexes).
//   pbillcfg                     settings
//   pbill_<sha256(email)>        one billing record
//   pbillcust_<stripeCustomer>   -> { key }   (webhook lookup)
//   pbillindex                   { emails: { key: email } }   (for the E3 Admin list)

const crypto = require("crypto");
const couchbase = require("../database/couchbase");
const stripe = require("./stripeApi");
const links = require("../model/portalLinks");
const portalAccess = require("../model/portalAccess");

const DAY = 864e5;
const CFG_KEY = "pbillcfg";
const INDEX_KEY = "pbillindex";
const SYNC_EVERY_MS = 6 * 3600 * 1000;
const STANDING_TTL_MS = 60 * 1000;
const GOOD = ["active", "trialing"];
const BAD = ["unpaid", "canceled", "incomplete_expired", "paused"];

const DEFAULTS = {
  docType: "PortalBillingConfig",
  enabled: false,          // E3 Admin switches billing on; sets goLiveAt
  goLiveAt: null,
  currency: "usd",
  trialDays: 15,
  monthlyCents: 500,       // list price per property per MONTH
  introMonthlyCents: 0,    // 0 = no introductory price
  introMonths: 12,
  annualDiscountMonths: 2, // annual price = monthly x (12 - this) unless annualCents is set
  annualCents: null,
  volumeMinProperties: 25, // accounts with at least this many properties get volumePercent off (0 = off)
  volumePercent: 25,       // % off the unit price, monthly and yearly; the intro coupon applies on top
  stripeProducts: {},      // { test: "prod_..", live: "prod_.." } created on first use
  history: [],
};

// ------------------------------------------------------------------ KV helpers
function coll() {
  const c = couchbase.ProjectReports;
  if (!c) throw new Error("Database connection not initialized (ProjectReports).");
  return c;
}
function isNotFound(e) {
  const name = (e && e.constructor && e.constructor.name) || "";
  return name === "DocumentNotFoundError" || (e && e.code === 101) || /document not found/i.test((e && e.message) || "");
}
async function getByKey(id) {
  try { const r = await coll().get(String(id)); return r && r.content != null ? r.content : null; }
  catch (e) { if (isNotFound(e)) return null; console.error("portalBilling get failed:", id, "-", e && e.message); throw e; }
}
async function put(id, doc) {
  try { await coll().upsert(String(id), doc); }
  catch (e) { console.error("portalBilling upsert failed:", id, "-", e && e.message); throw e; }
  return doc;
}
const nowIso = () => new Date().toISOString();
const emailOf = (rec) => String((rec && rec.email) || "").trim().toLowerCase();
const billKey = (email) => "pbill_" + crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, "");

// ---------------------------------------------------------------------- config
let cfgCache = { at: 0, cfg: Object.assign({}, DEFAULTS) };
async function getConfig(force) {
  if (!force && Date.now() - cfgCache.at < 30000) return cfgCache.cfg;
  let doc = null;
  try { doc = await getByKey(CFG_KEY); } catch (e) { return cfgCache.cfg; } // keep last known on a hiccup
  const cfg = Object.assign({}, DEFAULTS, doc || {});
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}
function peekConfig() { return cfgCache.cfg; }

function annualCents(cfg) {
  if (cfg.annualCents != null && cfg.annualCents > 0) return cfg.annualCents;
  return Math.max(1, cfg.monthlyCents * Math.max(1, 12 - (cfg.annualDiscountMonths || 0)));
}
function introPercent(cfg) {
  if (cfg.introMonthlyCents > 0 && cfg.introMonthlyCents < cfg.monthlyCents) {
    return Math.round((1 - cfg.introMonthlyCents / cfg.monthlyCents) * 10000) / 100;
  }
  return 0;
}
// Volume discount (% off the unit price) for an account with this many properties; 0 = none.
function volumePercent(cfg, properties) {
  const min = Number(cfg.volumeMinProperties) || 0;
  const pct = Number(cfg.volumePercent) || 0;
  return min > 0 && pct > 0 && Number(properties) >= min ? pct : 0;
}
const pctOff = (cents, pct) => (pct ? Math.max(1, Math.round((cents * (100 - pct)) / 100)) : cents);
// Prices per property. With `properties` the numbers are what THAT account pays (volume
// discount applied); without it they are the list prices (E3 Admin config, invitation text).
function pricing(cfg, properties) {
  const vol = properties === undefined ? 0 : volumePercent(cfg, properties);
  const ip = introPercent(cfg);
  const monthly = pctOff(cfg.monthlyCents, vol);
  const annual = pctOff(annualCents(cfg), vol);
  return {
    currency: cfg.currency, trialDays: cfg.trialDays,
    monthlyCents: monthly,
    introMonthlyCents: ip ? pctOff(monthly, ip) : 0, introMonths: cfg.introMonths,
    annualCents: annual, annualPerMonthCents: Math.round(annual / 12),
    volumeMinProperties: Number(cfg.volumeMinProperties) || 0, volumePercent: Number(cfg.volumePercent) || 0, volumeApplied: vol,
  };
}
// The sentence shown on the invitation email / accept page - always from the settings.
function priceLine(cfg) {
  const c = cfg || peekConfig();
  const p = pricing(c);
  let s = `Your first ${c.trialDays} days are free. After that the portal is ${money(p.monthlyCents)} per property per month`;
  if (p.introMonthlyCents) s += `, with an introductory rate of ${money(p.introMonthlyCents)} per property per month for your first ${p.introMonths} months`;
  s += ".";
  if (p.volumeMinProperties && p.volumePercent) s += ` Accounts with ${p.volumeMinProperties} or more properties get ${p.volumePercent}% off.`;
  return s;
}

const NUM = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi || Math.round(n) !== n) throw new Error(`${name} must be a whole number from ${lo} to ${hi}.`);
  return n;
};
async function saveConfig(patch, by) {
  const cur = await getConfig(true);
  const next = Object.assign({}, cur);
  const p = patch || {};
  if (p.trialDays !== undefined) next.trialDays = NUM(p.trialDays, 0, 90, "Trial days");
  if (p.monthlyCents !== undefined) next.monthlyCents = NUM(p.monthlyCents, 100, 100000, "Monthly price (cents)");
  if (p.introMonthlyCents !== undefined) next.introMonthlyCents = NUM(p.introMonthlyCents, 0, 100000, "Introductory price (cents)");
  if (p.introMonths !== undefined) next.introMonths = NUM(p.introMonths, 1, 36, "Introductory months");
  if (p.annualDiscountMonths !== undefined) next.annualDiscountMonths = NUM(p.annualDiscountMonths, 0, 11, "Annual discount months");
  if (p.annualCents !== undefined) next.annualCents = p.annualCents === null || p.annualCents === "" ? null : NUM(p.annualCents, 100, 1000000, "Annual price (cents)");
  if (p.volumeMinProperties !== undefined) next.volumeMinProperties = NUM(p.volumeMinProperties, 0, 100000, "Volume discount minimum properties");
  if (p.volumePercent !== undefined) next.volumePercent = NUM(p.volumePercent, 0, 90, "Volume discount percent");
  if (next.introMonthlyCents && next.introMonthlyCents >= next.monthlyCents) throw new Error("The introductory price must be lower than the regular price (or 0 for none).");
  if (p.enabled !== undefined) {
    const on = !!p.enabled;
    if (on && !cur.enabled) next.goLiveAt = nowIso();       // trials of existing logins start here
    next.enabled = on;
  }
  if (p.restartTrials) next.goLiveAt = nowIso();             // e.g. after switching from test to live keys
  next.history = (cur.history || []).concat([{ at: nowIso(), by: by || "", change: Object.keys(p).join(",") }]).slice(-100);
  await put(CFG_KEY, next);
  cfgCache = { at: Date.now(), cfg: next };
  standingCache.clear();
  return next;
}

// ---------------------------------------------------------------- billing record
async function addToIndex(key, email) {
  const idx = (await getByKey(INDEX_KEY)) || { docType: "PortalBillingIndex", id: INDEX_KEY, emails: {} };
  if (idx.emails[key]) return;
  idx.emails[key] = email; idx.updatedAt = nowIso();
  await put(INDEX_KEY, idx);
}
function logTo(bill, event, by, note) {
  bill.log = (bill.log || []).concat([{ at: nowIso(), event, by: by || "", note: note || "" }]).slice(-100);
}
async function saveBill(bill) { bill.updatedAt = nowIso(); await put(bill.id, bill); standingCache.delete(bill.email); return bill; }

async function trialStartFor(rec, cfg) {
  let earliest = null;
  for (const l of links.linksOf(rec)) {
    try {
      const a = await portalAccess.getAccount(l.companyIdentifier, l.clientId);
      const t = a && (a.createdAt || a.acceptedAt);
      if (t && (!earliest || t < earliest)) earliest = t;
    } catch (e) { /* use what we have */ }
  }
  const base = earliest || nowIso();
  const live = cfg.goLiveAt || nowIso();
  return base > live ? base : live;
}

// The billing record for a client login (created on first sight).
async function ensureBill(rec, cfg) {
  const email = emailOf(rec);
  const key = billKey(email);
  let bill = await getByKey(key);
  let dirty = false;
  if (!bill) {
    bill = { docType: "PortalBilling", id: key, email, userId: rec.id || "", log: [], createdAt: nowIso() };
    dirty = true;
  }
  // a subscription made with TEST keys means nothing once live keys are in use
  if (bill.subscriptionId && !!bill.testMode !== stripe.testMode()) {
    logTo(bill, "stale-subscription-cleared", "", `${bill.subscriptionId} was made in ${bill.testMode ? "test" : "live"} mode`);
    ["subscriptionId", "itemId", "status", "interval", "quantity", "unitAmount", "currentPeriodEnd", "cancelAtPeriodEnd", "stripeCustomerId", "everSubscribed", "stripePaused", "stripeResumesAt"].forEach((k) => delete bill[k]);
    bill.goLive = null; dirty = true;
  }
  if (!bill.subscriptionId && (!bill.trialEndsAt || bill.goLive !== (cfg.goLiveAt || null))) {
    const start = await trialStartFor(rec, cfg);
    bill.trialStartedAt = start;
    bill.trialEndsAt = new Date(Date.parse(start) + cfg.trialDays * DAY).toISOString();
    bill.goLive = cfg.goLiveAt || null;
    dirty = true;
  }
  if (dirty) { await saveBill(bill); await addToIndex(key, email).catch(() => {}); }
  return bill;
}

// ------------------------------------------------------------------ the decision
function evaluate(bill, cfg) {
  const t = Date.now();
  if (bill.waived && (!bill.waivedUntil || Date.parse(bill.waivedUntil) > t)) {
    return { state: "complimentary", allowed: true, reason: "", message: "" };
  }
  const st = bill.subscriptionId ? bill.status : "";
  if (GOOD.includes(st)) return { state: "active", allowed: true, reason: "", message: "" };
  if (st === "past_due") {
    return { state: "past_due", allowed: true, reason: "payment", message: "Your last payment did not go through. Please update your payment method to avoid losing access." };
  }
  if (BAD.includes(st)) {
    return { state: "locked", allowed: false, reason: "payment", message: "Your subscription is not active. Subscribe or update your payment method to restore access to your properties." };
  }
  const end = bill.trialEndsAt ? Date.parse(bill.trialEndsAt) : 0;
  if (end > t) {
    return { state: "trial", allowed: true, reason: "", message: "", trialEndsAt: bill.trialEndsAt, daysLeft: Math.max(1, Math.ceil((end - t) / DAY)) };
  }
  return { state: "locked", allowed: false, reason: "trial", message: `Your ${cfg.trialDays}-day free trial has ended. Subscribe to keep viewing your properties.`, trialEndsAt: bill.trialEndsAt || null };
}

const standingCache = new Map(); // email -> { at, v }
const OFF = { enabled: false, state: "off", allowed: true, reason: "", message: "" };

async function countProperties(rec) {
  const clients = require("../model/clients");
  let n = 0;
  for (const l of links.linksOf(rec)) {
    if (!l.active) continue;
    try { n += Number(await clients.portfolioCount(l.companyIdentifier, l.clientId)) || 0; }
    catch (e) { console.error("billing count:", e && e.message); }
  }
  return n;
}

// Called on every portal request (cached 60 s). Fails OPEN: a database hiccup must
// never lock a paying client out.
async function standing(rec) {
  const email = emailOf(rec);
  if (!email) return OFF;
  const hit = standingCache.get(email);
  if (hit && Date.now() - hit.at < STANDING_TTL_MS) return hit.v;
  let v;
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !stripe.configured()) v = OFF;
    else {
      const bill = await ensureBill(rec, cfg);
      v = Object.assign({ enabled: true }, evaluate(bill, cfg));
      if (!v.allowed && v.reason === "trial" && (await countProperties(rec)) === 0) {
        v = Object.assign({}, v, { state: "idle", allowed: true, message: "" }); // nothing to pay for yet
      }
    }
  } catch (e) {
    console.error("billing standing:", e && e.message);
    return OFF;
  }
  standingCache.set(email, { at: Date.now(), v });
  if (standingCache.size > 2000) standingCache.delete(standingCache.keys().next().value);
  return v;
}
function forget(email) { standingCache.delete(String(email || "").trim().toLowerCase()); }

// --------------------------------------------------------- what the client sees
// Keeps the subscription's property count in step with the portal. When the count crosses
// the volume-discount line (either way) the unit price moves with it; otherwise the price
// the client signed up at is left alone (a later list-price change does not reprice anyone).
async function syncQuantity(rec, bill, force, cfg) {
  try {
    if (!bill.subscriptionId || !bill.itemId || !(GOOD.includes(bill.status) || bill.status === "past_due")) return bill;
    if (!force && bill.quantitySyncedAt && Date.now() - Date.parse(bill.quantitySyncedAt) < SYNC_EVERY_MS) return bill;
    const c = cfg || (await getConfig());
    const n = Math.max(1, await countProperties(rec));
    bill.quantitySyncedAt = nowIso();
    if (n !== bill.quantity) {
      const tierChanged = volumePercent(c, bill.quantity || 0) !== volumePercent(c, n);
      if (tierChanged && bill.unitAmount && (bill.interval === "month" || bill.interval === "year")) {
        const p = pricing(c, n);
        const unit = bill.interval === "year" ? p.annualCents : p.monthlyCents;
        await stripe.setQuantityAndPrice(bill.itemId, n, { currency: c.currency, unitAmount: unit, interval: bill.interval, product: await productId(c) });
        logTo(bill, "quantity", "system", `${bill.quantity} -> ${n} properties, ${money(bill.unitAmount)} -> ${money(unit)} per property (volume discount ${p.volumeApplied ? "on" : "off"})`);
        bill.unitAmount = unit;
      } else {
        await stripe.setQuantity(bill.itemId, n);
        logTo(bill, "quantity", "system", `${bill.quantity} -> ${n} properties`);
      }
      bill.quantity = n;
    }
    await saveBill(bill);
  } catch (e) { console.error("billing quantity sync:", e && e.message); }
  return bill;
}

async function clientStatus(rec) {
  const cfg = await getConfig();
  if (!cfg.enabled || !stripe.configured()) return { success: true, enabled: false, state: "off", allowed: true };
  let bill = await ensureBill(rec, cfg);
  bill = await syncQuantity(rec, bill, false, cfg);
  const v = evaluate(bill, cfg);
  const properties = await countProperties(rec);
  return Object.assign({ success: true, enabled: true }, v, {
    properties, testMode: stripe.testMode(),
    pricing: (bill.subscriptionId || bill.everSubscribed) ? Object.assign(pricing(cfg, properties), { introMonthlyCents: 0 }) : pricing(cfg, properties),
    subscription: bill.subscriptionId ? {
      status: bill.status, interval: bill.interval, quantity: bill.quantity, currentPeriodEnd: bill.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!bill.cancelAtPeriodEnd,
    } : null,
    canManage: !!bill.stripeCustomerId,
    waivedUntil: v.state === "complimentary" ? (bill.waivedUntil || null) : null,
  });
}

function appUrl() { return String(process.env.PORTAL_APP_URL || "https://www.e3-web.com").replace(/\/+$/, ""); }

async function productId(cfg) {
  const mode = stripe.testMode() ? "test" : "live";
  if (cfg.stripeProducts && cfg.stripeProducts[mode]) return cfg.stripeProducts[mode];
  const p = await stripe.createProduct("E3 Client Portal - per property");
  const next = Object.assign({}, await getConfig(true));
  next.stripeProducts = Object.assign({}, next.stripeProducts, { [mode]: p.id });
  await put(CFG_KEY, next); cfgCache = { at: Date.now(), cfg: next };
  return p.id;
}

// POST /portal/billing/checkout { interval: "month" | "year" } -> { url }
async function startCheckout(rec, interval) {
  const cfg = await getConfig();
  if (!cfg.enabled || !stripe.configured()) { const e = new Error("Billing is not switched on yet."); e.status = 409; throw e; }
  const bill = await ensureBill(rec, cfg);
  if (bill.subscriptionId && (GOOD.includes(bill.status) || bill.status === "past_due")) {
    const e = new Error("You already have a subscription. Use Manage billing to change it."); e.status = 409; throw e;
  }
  const properties = await countProperties(rec);
  if (properties < 1) { const e = new Error("You have no properties linked to your login yet."); e.status = 409; throw e; }
  const yearly = interval === "year";
  const p = pricing(cfg, properties);
  const product = await productId(cfg);
  const params = {
    email: bill.email, reference: bill.id, customerId: bill.stripeCustomerId || null,
    successUrl: appUrl() + "/?billing=success", cancelUrl: appUrl() + "/?billing=cancel",
    lines: [{ quantity: properties, unitAmount: yearly ? p.annualCents : p.monthlyCents, currency: cfg.currency, interval: yearly ? "year" : "month", product }],
  };
  // The free days and the intro price are for a login's FIRST subscription only: a client
  // who cancels and subscribes again pays from day one, at the regular price (found in
  // testing, Nov 1 2026 - re-subscribing offered the free days and 12 intro months again).
  const returning = !!(bill.subscriptionId || bill.everSubscribed);
  const trialEnd = bill.trialEndsAt ? Date.parse(bill.trialEndsAt) : 0;
  if (!returning && trialEnd > Date.now() + 49 * 3600 * 1000) params.trialEnd = Math.floor(trialEnd / 1000); // card now, first charge when the free days end
  if (!returning && !yearly && introPercent(cfg)) params.couponId = (await stripe.ensureIntroCoupon(introPercent(cfg), cfg.introMonths)).id;
  const s = await stripe.createCheckoutSession(params);
  logTo(bill, "checkout-started", rec.username, `${yearly ? "yearly" : "monthly"} x ${properties}`);
  await saveBill(bill);
  return { success: true, url: s.url };
}

async function openPortal(rec) {
  const cfg = await getConfig();
  const bill = await getByKey(billKey(emailOf(rec)));
  if (!cfg.enabled || !stripe.configured() || !bill || !bill.stripeCustomerId) { const e = new Error("There is no billing account to manage yet."); e.status = 409; throw e; }
  const s = await stripe.createPortalSession(bill.stripeCustomerId, appUrl() + "/");
  return { success: true, url: s.url };
}

// ------------------------------------------------------------------- webhooks
async function applySubscription(subId, emailHint) {
  const sub = await stripe.getSubscription(subId);
  let email = (sub.metadata && sub.metadata.e3_email) || emailHint || "";
  if (!email && sub.customer) {
    const m = await getByKey("pbillcust_" + (typeof sub.customer === "string" ? sub.customer : sub.customer.id));
    if (m && m.key) { const b = await getByKey(m.key); email = b && b.email; }
  }
  if (!email) return null; // not one of ours (e.g. a MemberPress subscription on the same Stripe account)
  const key = billKey(email);
  const bill = (await getByKey(key)) || { docType: "PortalBilling", id: key, email: String(email).toLowerCase(), log: [], createdAt: nowIso() };
  const item = sub.items && sub.items.data && sub.items.data[0];
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id;
  const prevStatus = bill.status;
  Object.assign(bill, {
    stripeCustomerId: customerId || bill.stripeCustomerId, subscriptionId: sub.id, itemId: item ? item.id : bill.itemId,
    status: sub.status, quantity: item ? item.quantity : bill.quantity,
    unitAmount: item && item.price ? item.price.unit_amount : bill.unitAmount,
    interval: item && item.price && item.price.recurring ? item.price.recurring.interval : bill.interval,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : bill.currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end, testMode: !sub.livemode,
    stripePaused: !!sub.pause_collection, stripeResumesAt: sub.pause_collection && sub.pause_collection.resumes_at ? new Date(sub.pause_collection.resumes_at * 1000).toISOString() : null,
    collection: sub.collection_method || bill.collection,
    everSubscribed: true,
  });
  if (prevStatus !== sub.status) logTo(bill, "subscription", "stripe", `${prevStatus || "none"} -> ${sub.status}`);
  await saveBill(bill);
  if (customerId) await put("pbillcust_" + customerId, { docType: "PortalBillingCustomer", key });
  await addToIndex(key, bill.email).catch(() => {});
  return bill;
}

async function handleEvent(evt) {
  const obj = evt && evt.data && evt.data.object;
  if (!obj) return { handled: false };
  switch (evt.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !obj.subscription || !(obj.metadata && obj.metadata.e3_email)) return { handled: false };
      const b = await applySubscription(obj.subscription, obj.metadata.e3_email);
      return { handled: !!b };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const b = await applySubscription(obj.id, obj.metadata && obj.metadata.e3_email);
      return { handled: !!b };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      if (!obj.subscription) return { handled: false };
      const b = await applySubscription(obj.subscription, "");
      if (b) { logTo(b, evt.type === "invoice.paid" ? "invoice-paid" : "payment-failed", "stripe", money(obj.amount_paid || obj.amount_due)); await saveBill(b); }
      return { handled: !!b };
    }
    default: return { handled: false };
  }
}

// ------------------------------------------------------------------ E3 Admin
async function recFor(email) {
  const rec = await links.activeClientByEmail(email);
  if (!rec) { const e = new Error("No active portal login has that email."); e.status = 404; throw e; }
  return rec;
}
function summary(bill, cfg) {
  const v = evaluate(bill, cfg);
  return {
    email: bill.email, state: v.state, allowed: v.allowed, status: bill.status || "", interval: bill.interval || "", quantity: bill.quantity || 0,
    trialEndsAt: bill.trialEndsAt || null, waived: !!bill.waived, waivedUntil: bill.waivedUntil || null, waivedNote: bill.waivedNote || "",
    currentPeriodEnd: bill.currentPeriodEnd || null, collection: bill.collection || "", testMode: !!bill.testMode,
    stripePaused: !!bill.stripePaused, stripeResumesAt: bill.stripeResumesAt || null,
  };
}
// Read-only: an email's billing standing WITHOUT creating a billing record (Portal
// Clients page). null when billing has never seen this login.
async function peekAccount(email, properties) {
  const cfg = await getConfig();
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const bill = await getByKey(billKey(e));
  const base = { enabled: !!cfg.enabled, pricing: pricing(cfg, properties === undefined ? undefined : Number(properties) || 0) };
  if (!bill) return Object.assign(base, { state: cfg.enabled ? "not-started" : "off", email: e, log: [] });
  return Object.assign(base, summary(bill, cfg), { log: bill.log || [] });
}

async function adminList() {
  const cfg = await getConfig();
  const idx = (await getByKey(INDEX_KEY)) || { emails: {} };
  const keys = Object.keys(idx.emails).slice(0, 1000);
  const bills = (await Promise.all(keys.map((k) => getByKey(k).catch(() => null)))).filter(Boolean);
  return bills.map((b) => summary(b, cfg)).sort((a, b) => a.email.localeCompare(b.email));
}
async function adminView(email) {
  const cfg = await getConfig();
  const rec = await recFor(email);
  const bill = await ensureBill(rec, cfg);
  const properties = await countProperties(rec);
  return Object.assign(summary(bill, cfg), { properties, log: bill.log || [], pricing: pricing(cfg, properties) });
}
// Only E3 Admin reaches this (routes/billing-endpoint.js). Inspectors have no route to it.
async function waive(email, waived, note, until, by) {
  const cfg = await getConfig();
  const rec = await recFor(email);
  const bill = await ensureBill(rec, cfg);
  const untilIso = waived && until ? new Date(until).toISOString() : null;
  if (untilIso && !(Date.parse(untilIso) > Date.now())) { const e = new Error("The end date must be in the future."); e.status = 400; throw e; }
  // A client already subscribed must not be charged while fees are waived (David, Nov 1
  // 2026): Stripe stops charging (invoices are voided) and, with an end date, resumes
  // on that date by itself. Done FIRST so a Stripe failure leaves nothing half-changed.
  const live = bill.subscriptionId && (GOOD.includes(bill.status) || bill.status === "past_due") && !!bill.testMode === stripe.testMode();
  if (live) {
    const sub = waived
      ? await stripe.pauseCollection(bill.subscriptionId, untilIso ? Math.floor(Date.parse(untilIso) / 1000) : null)
      : await stripe.resumeCollection(bill.subscriptionId);
    bill.stripePaused = !!(sub && sub.pause_collection);
    bill.stripeResumesAt = sub && sub.pause_collection && sub.pause_collection.resumes_at ? new Date(sub.pause_collection.resumes_at * 1000).toISOString() : null;
  }
  bill.waived = !!waived;
  bill.waivedNote = String(note || "").slice(0, 300);
  bill.waivedUntil = untilIso;
  logTo(bill, waived ? "waived" : "waiver-removed", by,
    bill.waivedNote + (bill.waivedUntil ? " until " + bill.waivedUntil : "") + (live ? (waived ? " - Stripe charging paused" : " - Stripe charging resumed") : ""));
  await saveBill(bill);
  return summary(bill, cfg);
}
async function adminRecount(email, by) {
  const cfg = await getConfig();
  const rec = await recFor(email);
  const bill = await ensureBill(rec, cfg);
  await syncQuantity(rec, bill, true, cfg);
  logTo(bill, "recount", by, "");
  await saveBill(bill);
  return summary(bill, cfg);
}
// Invoice billing for a large client: Stripe emails an invoice; no card needed up front.
async function adminInvoiceBilling(email, interval, daysUntilDue, by) {
  const cfg = await getConfig();
  if (!stripe.configured()) { const e = new Error("Stripe is not configured."); e.status = 409; throw e; }
  const rec = await recFor(email);
  const bill = await ensureBill(rec, cfg);
  if (bill.subscriptionId && (GOOD.includes(bill.status) || bill.status === "past_due")) { const e = new Error("This client already has a subscription."); e.status = 409; throw e; }
  const properties = Math.max(1, await countProperties(rec));
  const yearly = interval === "year";
  const p = pricing(cfg, properties);
  let customerId = bill.stripeCustomerId;
  if (!customerId) { const c = await stripe.createCustomer(bill.email, [rec.first_name, rec.last_name].filter(Boolean).join(" "), { e3_email: bill.email }); customerId = c.id; bill.stripeCustomerId = customerId; }
  const sub = await stripe.createInvoiceSubscription({
    customerId, email: bill.email, quantity: properties, currency: cfg.currency, interval: yearly ? "year" : "month",
    unitAmount: yearly ? p.annualCents : p.monthlyCents, product: await productId(cfg), daysUntilDue: Number(daysUntilDue) || 15,
    couponId: !yearly && introPercent(cfg) && !(bill.subscriptionId || bill.everSubscribed) ? (await stripe.ensureIntroCoupon(introPercent(cfg), cfg.introMonths)).id : null,
  });
  logTo(bill, "invoice-billing", by, `${yearly ? "yearly" : "monthly"} x ${properties}, due in ${Number(daysUntilDue) || 15} days`);
  await saveBill(bill);
  const b = await applySubscription(sub.id, bill.email);
  return summary(b, cfg);
}

module.exports = {
  getConfig, saveConfig, peekConfig, pricing, priceLine, introPercent, annualCents, volumePercent,
  standing, forget, clientStatus, startCheckout, openPortal, handleEvent,
  adminList, adminView, peekAccount, waive, adminRecount, adminInvoiceBilling,
};
