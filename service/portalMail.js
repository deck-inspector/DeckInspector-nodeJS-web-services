"use strict";
// PORTAL EMAIL (David, Oct 31 2026): the client-portal invitation and, later,
// the billing reminders. Sent over SMTP with nodemailer when these App Service
// settings exist; otherwise send() answers { sent:false } and the web app shows
// the member the invitation link + a ready-made mailto so nothing is blocked.
//
//   PORTAL_SMTP_HOST   e.g. mail.smtp2go.com (the Association site already uses SMTP2GO)
//   PORTAL_SMTP_PORT   587 (STARTTLS) or 465 (TLS); default 587
//   PORTAL_SMTP_USER / PORTAL_SMTP_PASS
//   PORTAL_MAIL_FROM   default "E3 Inspection Association <admin@e3-inspection-association.com>"
//   PORTAL_MAIL_BCC    optional copy of every invitation (e.g. admin@e3-inspection-association.com)

const ASSOC = String(process.env.ASSOC_SITE_URL || "https://www.e3-inspection-association.com").replace(/\/+$/, "");
const APP = String(process.env.PORTAL_APP_URL || "https://www.e3-web.com").replace(/\/+$/, "");
const FROM = process.env.PORTAL_MAIL_FROM || "E3 Inspection Association <admin@e3-inspection-association.com>";
const SUPPORT = process.env.PORTAL_SUPPORT_EMAIL || "Admin@e3-inspection-association.com";

let transport = null;
function getTransport() {
  if (transport !== null) return transport;
  const host = process.env.PORTAL_SMTP_HOST, user = process.env.PORTAL_SMTP_USER, pass = process.env.PORTAL_SMTP_PASS;
  if (!host || !user || !pass) { transport = false; return transport; }
  try {
    const nodemailer = require("nodemailer");
    const port = parseInt(process.env.PORTAL_SMTP_PORT, 10) || 587;
    transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  } catch (e) {
    console.error("portalMail: nodemailer not available -", e && e.message);
    transport = false;
  }
  return transport;
}

function configured() { return !!getTransport(); }

async function send(msg) {
  const t = getTransport();
  if (!t) return { sent: false, reason: "SMTP not configured (PORTAL_SMTP_HOST / USER / PASS)." };
  try {
    const info = await t.sendMail({
      from: FROM, to: msg.to, bcc: process.env.PORTAL_MAIL_BCC || undefined,
      replyTo: msg.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html,
    });
    return { sent: true, id: info && info.messageId };
  } catch (e) {
    console.error("portalMail: send failed -", e && e.message);
    return { sent: false, reason: (e && e.message) || "send failed" };
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const PRICE_LINE = "Your first 15 days are free. After that the portal is $5 per property per month, billed yearly.";

// The invitation. Carries the code, the accept link and - David's requirement -
// a link to the E3 Inspection Association.
function invitationMessage(o) {
  const acceptUrl = `${APP}/invite/${o.code}`;
  const member = o.memberName || o.companyName || "Your E3 Certified Inspector";
  const company = o.companyName ? ` (${o.companyName})` : "";
  const props = Array.isArray(o.properties) ? o.properties : [];
  const propLines = props.slice(0, 25).map((p) => `  - ${p.name || p.address || p.id}${p.address && p.name ? " - " + p.address : ""}`);
  if (props.length > 25) propLines.push(`  ... and ${props.length - 25} more`);
  const subject = `${member} has invited you to the E3 Property Owner Portal`;
  const text = [
    `Hello${o.firstName ? " " + o.firstName : ""},`,
    "",
    `${member}${company}, your E3 Certified Inspector, has invited ${o.clientName || "you"} to the E3 Property Owner Portal:`,
    "your own secure view of the inspections of your properties - photos, notes and ratings - as they are entered.",
    "",
    `Accept the invitation: ${acceptUrl}`,
    `Your invitation code: ${o.code}  (valid for ${o.days || 14} days)`,
    "",
    props.length ? `Properties in your portfolio (${props.length}):` : "",
    ...propLines,
    props.length ? "" : "",
    PRICE_LINE,
    "",
    "The portal is a service of the E3 Inspection Association, the professional association of E3 Certified Inspectors:",
    `${ASSOC}/about-us/`,
    "",
    o.note ? `Note from ${member}: ${o.note}` : "",
    o.note ? "" : "",
    `Questions? ${SUPPORT}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1c2733;line-height:1.5;max-width:620px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#51616f;margin:0 0 6px">E3 Inspection Association</p>
<h2 style="margin:0 0 16px;color:#292c74">You are invited to the E3 Property Owner Portal</h2>
<p>Hello${o.firstName ? " " + esc(o.firstName) : ""},</p>
<p><b>${esc(member)}</b>${esc(company)}, your E3 Certified Inspector, has invited <b>${esc(o.clientName || "you")}</b> to the E3 Property Owner Portal: your own secure view of the inspections of your properties &mdash; photos, notes and ratings &mdash; as they are entered.</p>
<p style="margin:22px 0"><a href="${acceptUrl}" style="background:#292c74;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;display:inline-block">Accept the invitation</a></p>
<p>Your invitation code: <b style="font-size:18px;letter-spacing:.08em">${esc(o.code)}</b> <span style="color:#51616f">(valid for ${o.days || 14} days)</span><br>
<span style="color:#51616f;font-size:13px">If the button does not work, open ${esc(acceptUrl)}</span></p>
${props.length ? `<p><b>Properties in your portfolio (${props.length}):</b></p><ul style="margin:0 0 16px;padding-left:20px">${props.slice(0, 25).map((p) => `<li>${esc(p.name || p.address || p.id)}${p.address && p.name ? ` <span style="color:#51616f">&middot; ${esc(p.address)}</span>` : ""}</li>`).join("")}${props.length > 25 ? `<li>&hellip; and ${props.length - 25} more</li>` : ""}</ul>` : ""}
<p style="background:#f2f5f8;border-radius:10px;padding:12px 16px">${esc(PRICE_LINE)}</p>
${o.note ? `<p><b>Note from ${esc(member)}:</b> ${esc(o.note)}</p>` : ""}
<p>The portal is a service of the <a href="${ASSOC}/about-us/" style="color:#292c74">E3 Inspection Association</a>, the professional association of E3 Certified Inspectors.</p>
<p style="color:#51616f;font-size:13px">Questions? <a href="mailto:${esc(SUPPORT)}" style="color:#292c74">${esc(SUPPORT)}</a></p>
</body></html>`;

  return { subject, text, html, acceptUrl };
}

// A mailto: the member can send from their own mail program when SMTP is off.
function mailtoFor(to, msg) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.text)}`;
}

module.exports = { configured, send, invitationMessage, mailtoFor, PRICE_LINE, ASSOC, APP, SUPPORT };
