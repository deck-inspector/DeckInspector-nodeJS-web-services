"use strict";
// E3 INSPECTION ASSOCIATION MEMBERSHIP CHECK (David, Oct 31 2026).
//
// Only an inspection company whose admin holds an ACTIVE Association membership
// may invite clients to the portal. The Association site runs MemberPress; its
// REST API (Developer Tools add-on) answers "is this email an active member?".
//
// App Service settings:
//   ASSOC_SITE_URL      default https://www.e3-inspection-association.com
//   ASSOC_MP_API_KEY    MemberPress -> Developer Tools -> REST API key
//   ASSOC_MEMBERSHIPS   comma-separated membership titles that count (default:
//                       Inspector, Contractors, Manufacturer, Municipal; any
//                       active membership counts when left empty)
//
// Until the key is configured the check is NOT enforced (it answers active:true
// with checked:false and logs once) so the invitation flow keeps working while
// David wires the key in. Answers are cached for 24 h per email; when the site
// cannot be reached the last cached answer is used, and with no cached answer
// the check fails CLOSED (the member is asked to try again shortly).

const axios = require("axios");

const SITE = String(process.env.ASSOC_SITE_URL || "https://www.e3-inspection-association.com").replace(/\/+$/, "");
const KEY = String(process.env.ASSOC_MP_API_KEY || "").trim();
const WANT = String(process.env.ASSOC_MEMBERSHIPS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // lower(email) -> { at, res }
let warnedNoKey = false;

const RENEW_URL = SITE + "/contractors/";
const LOGIN_URL = SITE + "/login/";

function titlesOf(member) {
  const list = Array.isArray(member && member.active_memberships) ? member.active_memberships
    : Array.isArray(member && member.memberships) ? member.memberships : [];
  return list.map((m) => String((m && (m.title || m.name)) || "").trim()).filter(Boolean);
}

function evaluate(member) {
  if (!member) return { active: false, titles: [], reason: "No Association account was found for this email." };
  const titles = titlesOf(member);
  const active = WANT.length ? titles.some((t) => WANT.includes(t.toLowerCase())) : titles.length > 0;
  return {
    active, titles,
    reason: active ? "" : "Your E3 Inspection Association membership is not active.",
  };
}

// -> { active, checked, titles, reason, renewUrl, loginUrl }
async function statusFor(email) {
  const key = String(email || "").trim().toLowerCase();
  const base = { renewUrl: RENEW_URL, loginUrl: LOGIN_URL };
  if (!KEY) {
    if (!warnedNoKey) { warnedNoKey = true; console.warn("associationMembership: ASSOC_MP_API_KEY not set - membership is not being verified."); }
    return Object.assign({ active: true, checked: false, titles: [], reason: "" }, base);
  }
  if (!key) return Object.assign({ active: false, checked: true, titles: [], reason: "Your login has no email address; add one so the Association membership can be verified." }, base);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Object.assign({}, hit.res, base);

  try {
    const r = await axios.get(SITE + "/wp-json/mp/v1/members", {
      params: { search: key, per_page: 10 },
      headers: { "MEMBERPRESS-API-KEY": KEY, Accept: "application/json" },
      timeout: 12000,
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    const member = rows.find((m) => String(m && m.email || "").toLowerCase() === key) || null;
    const res = Object.assign({ checked: true }, evaluate(member));
    cache.set(key, { at: Date.now(), res });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return Object.assign({}, res, base);
  } catch (e) {
    console.error("associationMembership: lookup failed for", key, "-", e && e.message);
    if (hit) return Object.assign({}, hit.res, base, { stale: true });
    return Object.assign({ active: false, checked: false, titles: [],
      reason: "The Association site could not be reached to verify your membership. Please try again in a few minutes." }, base);
  }
}

function forget(email) { cache.delete(String(email || "").trim().toLowerCase()); }

module.exports = { statusFor, forget, SITE, RENEW_URL, LOGIN_URL };
