"use strict";
// PORTAL CLIENTS - E3 Admin's view of every property-owner login (David, Nov 1 2026).
//
// A portal login belongs to the property OWNER, not to an inspector: it is listed
// once however many inspectors share properties with it, and it stays when an
// inspector ends the relationship. Billing is per login (service/portalBilling.js).
// Only E3 Admin (routes/billing-endpoint.js e3Admin) reaches these functions.

const links = require("../model/portalLinks");
const billing = require("./portalBilling");

const NAME_TTL_MS = 10 * 60 * 1000;
const nameCache = new Map(); // "t:<company>" | "c:<clientId>" -> { v, at }

async function cached(key, load) {
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.v;
  let v = "";
  try { v = (await load()) || ""; } catch (e) { /* a name is only a label */ }
  nameCache.set(key, { v, at: Date.now() });
  if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value);
  return v;
}
function inspectorName(companyIdentifier) {
  return cached("t:" + companyIdentifier, async () => {
    const t = await require("./tenantService").getTenantByCompanyIdentifier(companyIdentifier);
    return t && t.Tenant && t.Tenant.name;
  });
}
function clientName(clientId) {
  return cached("c:" + clientId, async () => {
    const c = await require("../model/clients").getClientById(clientId);
    return c && c.name;
  });
}

async function describe(rec, withCounts) {
  const clients = require("../model/clients");
  const inspectors = [];
  for (const l of links.linksOf(rec)) {
    const row = {
      companyIdentifier: l.companyIdentifier, clientId: l.clientId,
      inspector: (await inspectorName(l.companyIdentifier)) || l.companyIdentifier,
      clientName: await clientName(l.clientId),
      primary: !!l.primary, active: !!l.active,
      since: l.linkedAt || null, changedAt: l.changedAt || null,
    };
    if (withCounts && row.active) {
      try { row.properties = Number(await clients.portfolioCount(l.companyIdentifier, l.clientId)) || 0; } catch (e) { row.properties = null; }
    }
    inspectors.push(row);
  }
  const email = String(rec.email || "").trim().toLowerCase();
  return {
    id: rec.id,
    email,
    username: rec.username || "",
    formerUsername: rec.formerUsername || "",
    name: [rec.first_name, rec.last_name].filter(Boolean).join(" "),
    mobile: rec.mobile || "",
    createdAt: rec.createdAt || null,
    loginOn: rec.isActive !== false,
    adminDisabledAt: rec.adminDisabledAt || null,
    adminDisabledBy: rec.adminDisabledBy || "",
    inspectors,
    activeInspectors: inspectors.filter((i) => i.active).length,
    properties: withCounts ? inspectors.reduce((n, i) => n + (Number(i.properties) || 0), 0) : null,
  };
}

// GET /api/portalbilling/admin/clients
async function list() {
  const rows = await links.allClientLogins();
  const out = [];
  for (const rec of rows) {
    const d = await describe(rec, true);
    d.billing = d.email ? await billing.peekAccount(d.email) : null;
    if (d.billing) delete d.billing.log; // the list stays small; the detail view has the history
    out.push(d);
  }
  return out.sort((a, b) => (a.name || a.email).toLowerCase().localeCompare((b.name || b.email).toLowerCase()));
}

// GET /api/portalbilling/admin/client?id=
async function view(id) {
  const rec = await links.clientLoginById(id);
  if (!rec) { const e = new Error("Portal client not found."); e.status = 404; throw e; }
  const d = await describe(rec, true);
  d.billing = d.email ? await billing.peekAccount(d.email, d.properties) : null;
  return d;
}

// POST /api/portalbilling/admin/client/login { id, active }
async function setLogin(id, active, by) {
  const rec = await links.clientLoginById(id);
  if (!rec) { const e = new Error("Portal client not found."); e.status = 404; throw e; }
  await links.setLoginActive(rec.id, !!active, by);
  try { require("./clientAccess").forgetUser(rec.username); } catch (e) { /* next request re-reads within 60 s */ }
  billing.forget(rec.email);
  return view(rec.id);
}

module.exports = { list, view, setLogin };
