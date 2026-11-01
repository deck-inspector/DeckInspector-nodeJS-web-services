"use strict";
// STRIPE (REST) for the client portal - PR 3 (David, Nov 1 2026).
//
// No SDK: the portal only needs five calls, so this talks to Stripe's REST API
// with axios (already a dependency) and checks webhook signatures with crypto.
// Nothing is billed unless STRIPE_SECRET_KEY is set (and billing is switched on
// by E3 Admin - see service/portalBilling.js).
//
// App Service settings (David pastes these himself; never typed by Claude):
//   STRIPE_SECRET_KEY       restricted or secret key (rk_... / sk_...), test key first
//   STRIPE_WEBHOOK_SECRET   signing secret of the webhook endpoint (whsec_...)

const axios = require("axios");
const crypto = require("crypto");

const API = "https://api.stripe.com/v1";
const API_VERSION = "2024-06-20";

function secretKey() { return process.env.STRIPE_SECRET_KEY || ""; }
function webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ""; }
function configured() { return !!secretKey(); }
function testMode() { return /^(sk|rk)_test_/.test(secretKey()); }

// Stripe wants application/x-www-form-urlencoded with bracket nesting:
//   { line_items: [{ quantity: 2 }] }  ->  line_items[0][quantity]=2
function flatten(obj, prefix, out) {
  out = out || [];
  if (obj === undefined || obj === null) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (typeof obj === "object") {
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? `${prefix}[${k}]` : k, out);
  } else {
    out.push(encodeURIComponent(prefix) + "=" + encodeURIComponent(String(obj)));
  }
  return out;
}
function form(obj) { return flatten(obj, "", []).join("&"); }

async function call(method, path, params, opts) {
  if (!configured()) throw new Error("Stripe is not configured.");
  const headers = {
    Authorization: "Bearer " + secretKey(),
    "Stripe-Version": API_VERSION,
  };
  if (opts && opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const cfg = { method, url: API + path, headers, timeout: 20000 };
  if (method === "GET") cfg.params = params || undefined;
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; cfg.data = form(params || {}); }
  try {
    const r = await axios(cfg);
    return r.data;
  } catch (e) {
    const se = e && e.response && e.response.data && e.response.data.error;
    const err = new Error((se && se.message) || (e && e.message) || "Stripe request failed");
    err.stripe = se || null;
    err.status = e && e.response && e.response.status;
    throw err;
  }
}

// A Checkout page for a new subscription. `lines` is [{ quantity, unitAmount, currency, interval, name }].
async function createCheckoutSession(p) {
  const params = {
    mode: "subscription",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    allow_promotion_codes: "true",
    client_reference_id: p.reference,
    metadata: { e3_email: p.email, e3_ref: p.reference },
    subscription_data: { metadata: { e3_email: p.email, e3_ref: p.reference } },
    line_items: p.lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: l.currency,
        unit_amount: l.unitAmount,
        recurring: { interval: l.interval },
        product: l.product,
      },
    })),
  };
  if (p.customerId) params.customer = p.customerId; else params.customer_email = p.email;
  if (p.trialEnd) params.subscription_data.trial_end = p.trialEnd;
  // Stripe refuses a Checkout Session that has both discounts and allow_promotion_codes.
  if (p.couponId) { params.discounts = [{ coupon: p.couponId }]; delete params.allow_promotion_codes; }
  return call("POST", "/checkout/sessions", params);
}

// One product ("E3 Client Portal - per property"); prices are created inline from the settings.
async function createProduct(name) {
  return call("POST", "/products", { name });
}
async function createCustomer(email, name, metadata) {
  return call("POST", "/customers", { email, name: name || undefined, metadata });
}
// Invoice billing (large clients): Stripe emails an invoice instead of charging a card.
async function createInvoiceSubscription(p) {
  const params = {
    customer: p.customerId, collection_method: "send_invoice", days_until_due: p.daysUntilDue,
    metadata: { e3_email: p.email, e3_ref: "invoice" },
    items: [{ quantity: p.quantity, price_data: { currency: p.currency, unit_amount: p.unitAmount, recurring: { interval: p.interval }, product: p.product } }],
  };
  if (p.couponId) params.discounts = [{ coupon: p.couponId }];
  return call("POST", "/subscriptions", params);
}

// Stripe's hosted page where the client updates the card, sees invoices, cancels.
async function createPortalSession(customerId, returnUrl) {
  return call("POST", "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
}

async function getSubscription(id) {
  return call("GET", "/subscriptions/" + encodeURIComponent(id), { "expand[]": "items.data" });
}

// Change the number of properties on the subscription (pro-rated by Stripe).
async function setQuantity(itemId, quantity) {
  return call("POST", "/subscription_items/" + encodeURIComponent(itemId), {
    quantity, proration_behavior: "create_prorations",
  });
}

// A reusable introductory-price coupon (percent off for N months). Created once per
// (percent, months) pair; the id is deterministic so repeat calls find it.
async function ensureIntroCoupon(percentOff, months) {
  const id = `e3portal_intro_${String(percentOff).replace(".", "_")}_${months}m`;
  try {
    return await call("GET", "/coupons/" + id);
  } catch (e) {
    if (!(e && e.status === 404)) throw e;
  }
  return call("POST", "/coupons", {
    id, percent_off: percentOff, duration: "repeating", duration_in_months: months,
    name: "E3 Client Portal introductory price",
  });
}

// Webhook signature (Stripe-Signature: t=...,v1=...). `raw` must be the exact request bytes.
function verifyWebhook(raw, header, toleranceSec) {
  const secret = webhookSecret();
  if (!secret) return { ok: false, reason: "no-secret" };
  if (!raw || !header) return { ok: false, reason: "missing" };
  const parts = {};
  String(header).split(",").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) { const k = kv.slice(0, i).trim(); (parts[k] = parts[k] || []).push(kv.slice(i + 1).trim()); }
  });
  const t = parts.t && parts.t[0];
  if (!t || !parts.v1) return { ok: false, reason: "malformed" };
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!(age <= (toleranceSec || 300))) return { ok: false, reason: "stale" };
  const expected = crypto.createHmac("sha256", secret).update(t + "." + raw.toString("utf8"), "utf8").digest("hex");
  const eb = Buffer.from(expected, "utf8");
  const match = parts.v1.some((sig) => {
    const sb = Buffer.from(sig, "utf8");
    return sb.length === eb.length && crypto.timingSafeEqual(sb, eb);
  });
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}

module.exports = {
  configured, testMode, form,
  createCheckoutSession, createPortalSession, getSubscription, setQuantity, ensureIntroCoupon,
  createProduct, createCustomer, createInvoiceSubscription,
  verifyWebhook,
};
