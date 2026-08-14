"use strict";
// QuickBooks Online integration (David, Aug 14): create + send the inspection
// invoice from E3, and read back its paid status. Per-tenant OAuth2 - each
// tenant connects THEIR QuickBooks company from the app; tokens live in
// Couchbase (model/qboDAO). Uses Node 20 global fetch - no new dependencies.
//
// Required app settings (Azure): QBO_CLIENT_ID, QBO_CLIENT_SECRET,
// QBO_REDIRECT_URI (https://www.e3-web.com/api/qbo/callback). Optional:
// QBO_ENV=sandbox for Intuit sandbox companies.
const crypto = require("crypto");
const qboDAO = require("../model/qboDAO");

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function apiBase() {
  return (process.env.QBO_ENV === "sandbox")
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}
function configured() {
  return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.QBO_REDIRECT_URI);
}
function basicAuth() {
  return "Basic " + Buffer.from(process.env.QBO_CLIENT_ID + ":" + process.env.QBO_CLIENT_SECRET).toString("base64");
}

// ---- Token security (Intuit payment-processing security rules) ----
// ACCESS tokens live in VOLATILE MEMORY ONLY (this process Map) - they are
// never written to the database. REFRESH tokens are ENCRYPTED (AES-256-GCM,
// key derived from the app's client secret) before being stored.
const TOKEN_MEM = new Map();   // companyIdentifier -> { accessToken, accessExpiresAt }

function encKey() {
  return crypto.createHash("sha256").update("qbo-token-v1:" + process.env.QBO_CLIENT_SECRET).digest();
}
function encryptToken(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptToken(b64) {
  const b = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

// State ties the OAuth callback (which arrives with no JWT) to the tenant that
// started it, signed so it cannot be forged.
function signState(companyIdentifier) {
  const payload = Buffer.from(JSON.stringify({ c: companyIdentifier, t: Date.now() })).toString("base64url");
  const mac = crypto.createHmac("sha256", process.env.QBO_CLIENT_SECRET).update(payload).digest("base64url");
  return payload + "." + mac;
}
function verifyState(state) {
  const [payload, mac] = String(state || "").split(".");
  if (!payload || !mac) return null;
  const expect = crypto.createHmac("sha256", process.env.QBO_CLIENT_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!obj.c || (Date.now() - obj.t) > 15 * 60 * 1000) return null;   // 15-minute window
    return obj.c;
  } catch (e) { return null; }
}

function authorizeUrl(companyIdentifier) {
  const q = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state: signState(companyIdentifier),
  });
  return AUTH_BASE + "?" + q.toString();
}

async function tokenRequest(params) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) throw new Error("QBO token request failed: " + resp.status + " " + (await resp.text()).slice(0, 300));
  return resp.json();
}

async function completeConnect(companyIdentifier, code, realmId) {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: process.env.QBO_REDIRECT_URI });
  const now = Date.now();
  // access token: VOLATILE MEMORY ONLY - never persisted
  TOKEN_MEM.set(companyIdentifier, { accessToken: tok.access_token, accessExpiresAt: now + (tok.expires_in || 3600) * 1000 });
  const conn = {
    realmId,
    refreshTokenEnc: encryptToken(tok.refresh_token),   // encrypted at rest
    refreshExpiresAt: now + (tok.x_refresh_token_expires_in || 8640000) * 1000,
  };
  // grab the QBO company name for the status display (best effort)
  try {
    const r = await fetch(apiBase() + "/v3/company/" + realmId + "/companyinfo/" + realmId + "?minorversion=75",
      { headers: { Authorization: "Bearer " + tok.access_token, Accept: "application/json" } });
    if (r.ok) { const j = await r.json(); conn.qboCompanyName = j.CompanyInfo && j.CompanyInfo.CompanyName; }
  } catch (e) { /* non-fatal */ }
  await qboDAO.upsertConnection(companyIdentifier, conn);
  return { realmId, accessToken: tok.access_token, qboCompanyName: conn.qboCompanyName };
}

// Fresh access token: served from VOLATILE MEMORY when still valid; otherwise
// the encrypted refresh token is decrypted, exchanged, and the ROTATED refresh
// token is re-encrypted and persisted. Access tokens never touch the database.
async function freshConnection(companyIdentifier) {
  const conn = await qboDAO.getConnection(companyIdentifier);
  if (!conn) return null;
  const mem = TOKEN_MEM.get(companyIdentifier);
  if (mem && Date.now() < (mem.accessExpiresAt || 0) - 5 * 60 * 1000) {
    return { realmId: conn.realmId, accessToken: mem.accessToken, qboCompanyName: conn.qboCompanyName };
  }
  // legacy plaintext field (pre-encryption docs) is honoured once, then upgraded
  const storedRefresh = conn.refreshTokenEnc ? decryptToken(conn.refreshTokenEnc) : conn.refreshToken;
  if (!storedRefresh) return null;
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: storedRefresh });
  const now = Date.now();
  TOKEN_MEM.set(companyIdentifier, { accessToken: tok.access_token, accessExpiresAt: now + (tok.expires_in || 3600) * 1000 });
  await qboDAO.upsertConnection(companyIdentifier, {
    realmId: conn.realmId,
    qboCompanyName: conn.qboCompanyName,
    refreshTokenEnc: encryptToken(tok.refresh_token || storedRefresh),
    refreshExpiresAt: now + (tok.x_refresh_token_expires_in || 8640000) * 1000,
    accessToken: undefined, refreshToken: undefined,   // scrub any legacy plaintext
  });
  return { realmId: conn.realmId, accessToken: tok.accessToken || tok.access_token, qboCompanyName: conn.qboCompanyName };
}

async function qapi(conn, method, path, body) {
  const url = apiBase() + "/v3/company/" + conn.realmId + path + (path.includes("?") ? "&" : "?") + "minorversion=75";
  const resp = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + conn.accessToken, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error("QBO " + method + " " + path + " -> " + resp.status + " " + (await resp.text()).slice(0, 400));
  return resp.json();
}

function q(str) { return String(str || "").replace(/'/g, "\\'"); }

async function findOrCreateCustomer(conn, displayName, email) {
  const name = String(displayName || "Client").slice(0, 100).trim() || "Client";
  const found = await qapi(conn, "GET", "/query?query=" + encodeURIComponent("select * from Customer where DisplayName = '" + q(name) + "'"));
  const rows = (found.QueryResponse && found.QueryResponse.Customer) || [];
  if (rows.length) return rows[0];
  const created = await qapi(conn, "POST", "/customer", {
    DisplayName: name,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
  });
  return created.Customer;
}

// First Service-type item, or create "E-3 Inspection" against the first
// income account. QBO invoices require an ItemRef on every line.
async function findOrCreateServiceItem(conn) {
  const found = await qapi(conn, "GET", "/query?query=" + encodeURIComponent("select * from Item where Type = 'Service' maxresults 1"));
  const rows = (found.QueryResponse && found.QueryResponse.Item) || [];
  if (rows.length) return rows[0];
  const acct = await qapi(conn, "GET", "/query?query=" + encodeURIComponent("select * from Account where AccountType = 'Income' maxresults 1"));
  const accts = (acct.QueryResponse && acct.QueryResponse.Account) || [];
  if (!accts.length) throw new Error("No income account in QuickBooks to attach the service item to.");
  const created = await qapi(conn, "POST", "/item", {
    Name: "E-3 Inspection", Type: "Service",
    IncomeAccountRef: { value: accts[0].Id },
  });
  return created.Item;
}

async function createAndSendInvoice(companyIdentifier, opts) {
  const conn = await freshConnection(companyIdentifier);
  if (!conn) throw new Error("QuickBooks is not connected for this company.");
  const customer = await findOrCreateCustomer(conn, opts.customerName, opts.email);
  const item = await findOrCreateServiceItem(conn);
  const inv = await qapi(conn, "POST", "/invoice", {
    CustomerRef: { value: customer.Id },
    BillEmail: opts.email ? { Address: opts.email } : undefined,
    Line: [{
      Amount: opts.amount,
      DetailType: "SalesItemLineDetail",
      Description: opts.description || "E-3 Inspection",
      SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: opts.amount },
    }],
  });
  const invoice = inv.Invoice;
  let emailed = false;
  if (opts.email) {
    try {
      await qapi(conn, "POST", "/invoice/" + invoice.Id + "/send?sendTo=" + encodeURIComponent(opts.email), null);
      emailed = true;
    } catch (e) { console.error("QBO invoice send failed (invoice still created):", e.message); }
  }
  return { invoiceId: invoice.Id, docNumber: invoice.DocNumber, total: invoice.TotalAmt, emailed };
}

async function invoiceStatus(companyIdentifier, invoiceId) {
  const conn = await freshConnection(companyIdentifier);
  if (!conn) return null;
  const j = await qapi(conn, "GET", "/invoice/" + invoiceId);
  const inv = j.Invoice;
  return {
    invoiceId: inv.Id, docNumber: inv.DocNumber,
    total: inv.TotalAmt, balance: inv.Balance,
    paid: Number(inv.Balance) === 0,
    emailStatus: inv.EmailStatus || "",
  };
}

module.exports = { configured, authorizeUrl, verifyState, completeConnect, freshConnection, createAndSendInvoice, invoiceStatus, apiBase };
