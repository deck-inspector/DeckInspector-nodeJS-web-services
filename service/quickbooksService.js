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
  if (!resp.ok) {
    const tid = resp.headers.get("intuit_tid") || "n/a";
    throw new Error("QBO token request failed: " + resp.status + " intuit_tid=" + tid + " " + (await resp.text()).slice(0, 300));
  }
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
  // intuit_tid: Intuit's per-request trace id - captured on every call and
  // included in logs/errors so Intuit support can trace issues (questionnaire).
  const tid = resp.headers.get("intuit_tid") || "n/a";
  if (!resp.ok) throw new Error("QBO " + method + " " + path + " -> " + resp.status + " intuit_tid=" + tid + " " + (await resp.text()).slice(0, 400));
  if (method !== "GET") console.log("QBO " + method + " " + path.split("?")[0] + " ok intuit_tid=" + tid);
  return resp.json();
}

function q(str) { return String(str || "").replace(/'/g, "\\'"); }

// Customer lookup is TOLERANT: exact DisplayName first, then a
// case/punctuation-insensitive scan, then the contact email. Only when none
// of those match is a customer created (the app never UPDATES a customer -
// per the Intuit compliance answers, so the phone/address we want on the
// invoice are written onto the INVOICE, not back onto the customer record).
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function findOrCreateCustomer(conn, displayName, email, phone) {
  const name = String(displayName || "Client").slice(0, 100).trim() || "Client";
  const exact = await qapi(conn, "GET", "/query?query=" + encodeURIComponent(
    "select * from Customer where DisplayName = '" + q(name) + "'"));
  let rows = (exact.QueryResponse && exact.QueryResponse.Customer) || [];
  if (rows.length) return rows[0];

  // tolerant pass - "James Escamilla" vs "Escamilla, James" / "James  Escamilla."
  const all = await qapi(conn, "GET", "/query?query=" + encodeURIComponent(
    "select * from Customer maxresults 1000"));
  const list = (all.QueryResponse && all.QueryResponse.Customer) || [];
  const want = norm(name);
  const wantSorted = want.split(" ").sort().join(" ");
  let hit = list.find(c => norm(c.DisplayName) === want)
         || list.find(c => norm(c.DisplayName).split(" ").sort().join(" ") === wantSorted);
  if (!hit && email) {
    const e = String(email).toLowerCase().trim();
    hit = list.find(c => c.PrimaryEmailAddr && String(c.PrimaryEmailAddr.Address || "").toLowerCase().trim() === e);
  }
  if (hit) return hit;

  const created = await qapi(conn, "POST", "/customer", {
    DisplayName: name,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
    PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
  });
  return created.Customer;
}

// Fallback ONLY: used if QuickBooks refuses an invoice line that carries no
// Product/Service. David picks the real item in QBO himself.
async function findOrCreateServiceItem(conn) {
  const found = await qapi(conn, "GET", "/query?query=" + encodeURIComponent(
    "select * from Item where Type = 'Service' maxresults 1"));
  const rows = (found.QueryResponse && found.QueryResponse.Item) || [];
  if (rows.length) return rows[0];
  const acct = await qapi(conn, "GET", "/query?query=" + encodeURIComponent(
    "select * from Account where AccountType = 'Income' maxresults 1"));
  const accts = (acct.QueryResponse && acct.QueryResponse.Account) || [];
  if (!accts.length) throw new Error("No income account in QuickBooks to attach the service item to.");
  const created = await qapi(conn, "POST", "/item", {
    Name: "E-3 Inspection", Type: "Service",
    IncomeAccountRef: { value: accts[0].Id },
  });
  return created.Item;
}

// "Due on receipt" (or whatever the tenant named it) - matched by name, not id.
async function findTerm(conn, wanted) {
  const want = norm(wanted || "due on receipt");
  const res = await qapi(conn, "GET", "/query?query=" + encodeURIComponent(
    "select * from Term maxresults 200"));
  const rows = (res.QueryResponse && res.QueryResponse.Term) || [];
  return rows.find(t => norm(t.Name) === want)
      || rows.find(t => norm(t.Name).indexOf("due on receipt") !== -1)
      || null;
}

// Sales-form CUSTOM FIELDS are addressed by DefinitionId (1..3), and which id
// is "P.O. Number" differs per company - so read the company preferences and
// match on the NAME the customer gave the field. Survives renames/reordering.
async function customFieldMap(conn) {
  const map = {};
  try {
    const res = await qapi(conn, "GET", "/query?query=" + encodeURIComponent("select * from Preferences"));
    const prefs = ((res.QueryResponse && res.QueryResponse.Preferences) || [])[0] || {};
    const groups = (prefs.SalesFormsPrefs && prefs.SalesFormsPrefs.CustomField) || [];
    for (const g of groups) {
      for (const f of (g.CustomField || [])) {
        const m = String(f.Name || "").match(/SalesCustomName(\d)/i);
        if (m && f.StringValue) map[norm(f.StringValue)] = m[1];
      }
    }
  } catch (e) { console.error("QBO: could not read custom field preferences:", e.message); }
  return map;
}

function ymd(d) {
  if (!d) return undefined;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return undefined;
  // format in Pacific time - the invoice date must match the inspection date
  // the office sees on the project card, not a UTC-shifted day.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
  return p;   // en-CA gives YYYY-MM-DD
}

// opts: { customerName, phone, email, ship:{line1,city,stateZip}, txnDate,
//         poNumber, lines:[{description, amount, serviceDate}] }
async function createAndSendInvoice(companyIdentifier, opts) {
  const conn = await freshConnection(companyIdentifier);
  if (!conn) throw new Error("QuickBooks is not connected for this company.");

  // The QBO CUSTOMER is the PROPERTY (matches David's books - customer list is
  // properties, e.g. "4423 Hoover St. / Apartments"); the owner's name + phone
  // go in the invoice's Bill To box only.
  const customer = await findOrCreateCustomer(conn, opts.propertyName || opts.customerName, opts.email, opts.phone);
  const [term, cfMap] = await Promise.all([findTerm(conn, "Due on receipt"), customFieldMap(conn)]);

  const txn = ymd(opts.txnDate);
  // No Description is sent - when David picks the Product/Service in QBO the
  // item's own default description fills the blank cell (his sample invoice).
  const lines = (opts.lines || []).filter(l => l && Number(l.amount) > 0).map(l => ({
    Amount: Number(l.amount),
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      Qty: 1, UnitPrice: Number(l.amount),
      ServiceDate: ymd(l.serviceDate || opts.txnDate),
    },
  }));
  if (!lines.length) throw new Error("No priced lines to invoice.");

  // BillTo: owner name on line 1, owner phone on the line BELOW it (David).
  const billAddr = { Line1: String(opts.customerName || "").trim() || undefined };
  if (opts.phone) billAddr.Line2 = String(opts.phone).trim();

  const ship = opts.ship || {};
  const shipAddr = {};
  if (ship.line1) shipAddr.Line1 = String(ship.line1).trim();
  if (ship.city) shipAddr.City = String(ship.city).trim();
  if (ship.stateZip) {
    const m = String(ship.stateZip).trim().match(/^([A-Za-z]{2})[,\s]+(\S.*)$/);
    if (m) { shipAddr.CountrySubDivisionCode = m[1].toUpperCase(); shipAddr.PostalCode = m[2].trim(); }
    else shipAddr.Line2 = String(ship.stateZip).trim();
  }

  const custom = [];
  const poId = cfMap[norm("P.O. Number")] || cfMap[norm("PO Number")]; const ipId = cfMap[norm("Inspection Property")]; const ipVal = [ship.line1, ship.city].filter(Boolean).join(", "); if (ipId && ipVal) custom.push({ DefinitionId: ipId, Name: "Inspection Property", Type: "StringType", StringValue: ipVal.slice(0, 31) });
  if (poId && opts.poNumber) {
    custom.push({ DefinitionId: poId, Name: "P.O. Number", Type: "StringType", StringValue: String(opts.poNumber) });
  }

  // NOTE: DocNumber is deliberately NOT sent - QuickBooks auto-numbers the
  // invoice (requires "Custom transaction numbers" to be OFF in QBO settings).
  const payload = {
    CustomerRef: { value: customer.Id },
    BillEmail: opts.email ? { Address: opts.email } : undefined,
    BillAddr: billAddr.Line1 ? billAddr : undefined,
    TxnDate: txn,
    DueDate: txn,                    // Due on receipt
    SalesTermRef: term ? { value: term.Id } : undefined,
    CustomField: custom.length ? custom : undefined,
    Line: lines,
  };

  let inv;
  try {
    inv = await qapi(conn, "POST", "/invoice", payload);
  } catch (e) {
    // Some QBO companies reject a line with no Product/Service. Retry once
    // with a fallback item so the invoice still lands; David re-picks the
    // item in QuickBooks.
    if (!/item/i.test(e.message)) throw e;
    console.warn("QBO rejected item-less lines, retrying with a fallback item:", e.message);
    const item = await findOrCreateServiceItem(conn);
    for (const l of payload.Line) l.SalesItemLineDetail.ItemRef = { value: item.Id };
    inv = await qapi(conn, "POST", "/invoice", payload);
  }

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
