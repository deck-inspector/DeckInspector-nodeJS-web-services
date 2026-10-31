"use strict";
// CLIENT PORTAL INVITATIONS (David, Oct 31 2026) - see model/portalAccess.js.
//
// Two routers:
//   memberRouter  mounted at /api/portalinvite behind authenticateToken. ADMINS of
//                 the tenant only, and only while the tenant's admin holds an active
//                 E3 Inspection Association membership (service/associationMembership.js).
//   publicRouter  mounted at /api/invite with NO token: the client opens the link
//                 from the invitation email, sees who invited them and creates their
//                 own login (role 'client', same record kind as Portal access logins).
//
// The invitation email carries the accept link, the code and a link to the
// E3 Inspection Association (service/portalMail.js). When SMTP is not configured
// the member gets the link + a mailto to send it from their own mail program.

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const clients = require("../model/clients");
const users = require("../model/user");
const Tenants = require("../service/tenantService");
const portal = require("../model/portalAccess");
const assoc = require("../service/associationMembership");
const mail = require("../service/portalMail");
const { forgetUser } = require("../service/clientAccess");
const links = require("../model/portalLinks"); // PR 2: one login, several inspectors

const memberRouter = express.Router();
const publicRouter = express.Router();

function company(req) { return req.user && req.user.company; }
function str(v, max = 200) { return String(v == null ? "" : v).trim().slice(0, max); }
function emailOk(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

async function requireAdmin(req, res) {
  try {
    const me = await users.getUserbyUsername(req.user && req.user.username);
    if (me && String(me.role || "").toLowerCase() === "admin" && me.companyIdentifier === company(req)) return me;
  } catch (e) { /* fall through */ }
  res.status(403).json({ message: "Only an admin can invite clients to the portal." });
  return null;
}

async function clientOf(req, res) {
  const cur = await clients.getClientById(req.params.id);
  if (!cur || cur.companyIdentifier !== company(req)) {
    res.status(404).json({ message: "Client not found." });
    return null;
  }
  return cur;
}

async function tenantName(companyIdentifier) {
  try {
    const t = await Tenants.getTenantByCompanyIdentifier(companyIdentifier);
    return (t && t.Tenant && t.Tenant.name) || "";
  } catch (e) { return ""; }
}

function memberNameOf(me, companyName) {
  const person = [me.first_name, me.last_name].filter(Boolean).join(" ");
  return person || companyName || me.username;
}

// Membership gate shared by invite + resend. Answers the member with a renewal
// link when the Association says the membership is not active.
async function membershipOk(me, res) {
  const s = await assoc.statusFor(me.email || "");
  if (s.active) return s;
  res.status(403).json({
    message: s.reason || "Your E3 Inspection Association membership is not active.",
    membership: { active: false, checked: s.checked, renewUrl: s.renewUrl, loginUrl: s.loginUrl },
  });
  return null;
}

async function buildAndSend(inv, code, me, companyName) {
  await require("../service/portalBilling").getConfig().catch(() => null); // price sentence comes from the billing settings
  let properties = [];
  try { properties = await clients.getPortfolio(inv.companyIdentifier, inv.clientId); } catch (e) { properties = []; }
  const msg = mail.invitationMessage({
    code, memberName: memberNameOf(me, companyName), companyName, clientName: inv.clientName,
    firstName: inv.first_name, properties, note: inv.note, days: portal.INVITE_DAYS,
  });
  const sent = await mail.send({ to: inv.email, replyTo: me.email || undefined, subject: msg.subject, text: msg.text, html: msg.html });
  return { acceptUrl: msg.acceptUrl, emailed: !!sent.sent, mailReason: sent.reason || "", mailto: mail.mailtoFor(inv.email, msg) };
}

function publicInvite(inv) {
  return {
    id: inv.id, email: inv.email, first_name: inv.first_name, last_name: inv.last_name, note: inv.note,
    status: portal.effectiveStatus(inv), emailed: !!inv.emailed, propertyCount: inv.propertyCount || 0,
    createdAt: inv.createdAt, expiresAt: inv.expiresAt, acceptedAt: inv.acceptedAt || null,
    member: inv.member && inv.member.name, reissuedAt: inv.reissuedAt || null,
  };
}

// ---------------------------------------------------------------- member side
// GET /api/portalinvite/clients/:id - invitations + the portal account of one client
memberRouter.get("/clients/:id", async (req, res) => {
  try {
    const me = await requireAdmin(req, res); if (!me) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const [list, account] = await Promise.all([
      portal.listInvitations(company(req), cur.id),
      portal.getAccount(company(req), cur.id),
    ]);
    res.status(200).json({
      invitations: list.map(publicInvite),
      account: account ? { id: account.id, state: account.state, email: account.owner && account.owner.email, createdAt: account.createdAt, trialEndsAt: account.trialEndsAt || null } : null,
      mailConfigured: mail.configured(),
      associationUrl: assoc.SITE,
    });
  } catch (e) {
    console.error("portal invites list:", e && e.message);
    res.status(500).json({ message: "Could not load the invitations." });
  }
});

// GET /api/portalinvite/membership - is this admin's Association membership active?
memberRouter.get("/membership", async (req, res) => {
  try {
    const me = await requireAdmin(req, res); if (!me) return;
    const s = await assoc.statusFor(me.email || "");
    res.status(200).json({ active: !!s.active, checked: !!s.checked, titles: s.titles || [], reason: s.reason || "", renewUrl: s.renewUrl, loginUrl: s.loginUrl, email: me.email || "" });
  } catch (e) {
    res.status(500).json({ message: "Could not check the membership." });
  }
});

// POST /api/portalinvite/clients/:id { email, first_name, last_name, note }
memberRouter.post("/clients/:id", async (req, res) => {
  try {
    const me = await requireAdmin(req, res); if (!me) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const b = req.body || {};
    const email = str(b.email, 254).toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ message: "Enter the client's email address." });
    if (!(await membershipOk(me, res))) return;

    const account = await portal.getAccount(company(req), cur.id);
    if (account && account.state === "locked") {
      return res.status(409).json({ message: "This client has an unpaid portal account. Access resumes when they pay." });
    }
    // An email that already has a PORTAL login (with you or another inspector) is
    // fine: accepting adds your properties to that login (PR 2). A staff login's
    // email cannot be invited.
    let existing = await links.activeClientByEmail(email).catch(() => null);
    if (existing && links.hasLink(existing, company(req), cur.id)) {
      return res.status(409).json({ message: `${existing.username} already has portal access to this client. Use "Turn on" / "Reset password" in the logins list instead.` });
    }
    if (!existing) {
      const probe = await users.claimIdentity("zz-probe-" + portal.newCode().slice(0, 6).toLowerCase(), email).catch(() => ({ ok: true }));
      if (!probe.ok && probe.field === "email") {
        return res.status(409).json({ message: "This email belongs to an E3 Web staff login, so it cannot be invited to the portal. Invite a different email address." });
      }
    }
    // one pending invitation per email: an older one is replaced
    const pending = (await portal.listInvitations(company(req), cur.id))
      .filter((i) => i.status === "sent" && i.email === email);
    for (const p of pending) await portal.setInvitation(p.id, { status: "revoked", revokedAt: new Date().toISOString(), revokedBy: me.username, revokedReason: "replaced" });

    const companyName = await tenantName(company(req));
    const count = await clients.portfolioCount(company(req), cur.id);
    const { doc, code } = await portal.createInvitation({
      companyIdentifier: company(req), clientId: cur.id, clientName: cur.name,
      email, first_name: str(b.first_name, 80), last_name: str(b.last_name, 80), note: str(b.note, 600),
      propertyCount: count, memberUsername: me.username, memberName: memberNameOf(me, companyName), memberEmail: me.email || "",
      companyName,
    });
    const out = await buildAndSend(doc, code, me, companyName);
    if (out.emailed !== doc.emailed) await portal.setInvitation(doc.id, { emailed: out.emailed });
    res.status(201).json(Object.assign({ ok: 1, willLink: !!existing, invitation: publicInvite(Object.assign({}, doc, { emailed: out.emailed })) }, out));
  } catch (e) {
    console.error("portal invite create:", e && e.message);
    res.status(500).json({ message: "Could not create the invitation." });
  }
});

// POST /api/portalinvite/clients/:id/:inviteId/resend - fresh code + expiry
memberRouter.post("/clients/:id/:inviteId/resend", async (req, res) => {
  try {
    const me = await requireAdmin(req, res); if (!me) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const inv = await portal.getInvitationById(req.params.inviteId);
    if (!inv || inv.companyIdentifier !== company(req) || inv.clientId !== cur.id) return res.status(404).json({ message: "Invitation not found." });
    if (inv.status === "accepted") return res.status(409).json({ message: "This invitation was already accepted." });
    if (!(await membershipOk(me, res))) return;
    const companyName = await tenantName(company(req));
    // a resend is a NEW invitation document (new code = new key); the old one is marked replaced
    const re = await portal.reissueInvitation(inv.id);
    if (!re) return res.status(404).json({ message: "Invitation not found." });
    const fresh = re.doc;
    const out = await buildAndSend(fresh, re.code, me, companyName);
    if (out.emailed) await portal.setInvitation(fresh.id, { emailed: true });
    res.status(200).json(Object.assign({ ok: 1, invitation: publicInvite(Object.assign({}, fresh, { emailed: out.emailed })) }, out));
  } catch (e) {
    console.error("portal invite resend:", e && e.message);
    res.status(500).json({ message: "Could not resend the invitation." });
  }
});

// POST /api/portalinvite/clients/:id/:inviteId/revoke
memberRouter.post("/clients/:id/:inviteId/revoke", async (req, res) => {
  try {
    const me = await requireAdmin(req, res); if (!me) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const inv = await portal.getInvitationById(req.params.inviteId);
    if (!inv || inv.companyIdentifier !== company(req) || inv.clientId !== cur.id) return res.status(404).json({ message: "Invitation not found." });
    if (inv.status === "accepted") return res.status(409).json({ message: "This invitation was already accepted - turn the login off instead." });
    await portal.setInvitation(inv.id, { status: "revoked", revokedAt: new Date().toISOString(), revokedBy: me.username });
    res.status(200).json({ ok: 1 });
  } catch (e) {
    console.error("portal invite revoke:", e && e.message);
    res.status(500).json({ message: "Could not revoke the invitation." });
  }
});

// ---------------------------------------------------------------- public side
function openInvitation(code) {
  return portal.getInvitationByCode(code);
}
function inviteProblem(inv) {
  const s = portal.effectiveStatus(inv);
  if (!inv) return "This invitation link is not valid. Ask your inspector to send a new one.";
  if (s === "accepted") return "This invitation has already been used. Sign in with your email and password.";
  if (s === "revoked") return "This invitation was withdrawn. Ask your inspector to send a new one.";
  if (s === "replaced") return "A newer invitation was sent to you - please use the link in the latest email.";
  if (s === "expired") return "This invitation has expired. Ask your inspector to send a new one.";
  return "";
}

// GET /api/invite/:code - what the accept page shows (no token)
publicRouter.get("/:code", async (req, res) => {
  try {
    const code = portal.normCode(req.params.code);
    if (code.length < 8) return res.status(404).json({ message: inviteProblem(null) });
    const inv = await openInvitation(code);
    const problem = inviteProblem(inv);
    if (problem) return res.status(inv ? 410 : 404).json({ message: problem, status: inv ? portal.effectiveStatus(inv) : "invalid" });
    await require("../service/portalBilling").getConfig().catch(() => null);
    let properties = [];
    try { properties = (await clients.getPortfolio(inv.companyIdentifier, inv.clientId)).map((p) => ({ name: p.name || "", address: p.address || "" })); } catch (e) { properties = []; }
    res.status(200).json({
      ok: 1,
      client: inv.clientName, email: inv.email, first_name: inv.first_name, last_name: inv.last_name,
      member: (inv.member && inv.member.name) || "", company: inv.companyName || "", note: inv.note || "",
      properties, expiresAt: inv.expiresAt,
      priceLine: mail.priceLine(), associationUrl: assoc.SITE + "/about-us/", supportEmail: mail.SUPPORT,
      // PR 2: this email already has a portal login -> the page asks for its password instead of a new one
      existingLogin: !!(await links.activeClientByEmail(inv.email).catch(() => null)),
    });
  } catch (e) {
    console.error("invite lookup:", e && e.message);
    res.status(500).json({ message: "Could not open the invitation. Please try again." });
  }
});

// POST /api/invite/:code/accept { password, first_name, last_name } -> the signed-in client
publicRouter.post("/:code/accept", async (req, res) => {
  try {
    const code = portal.normCode(req.params.code);
    const inv = code.length >= 8 ? await openInvitation(code) : null;
    const problem = inviteProblem(inv);
    if (problem) return res.status(inv ? 410 : 404).json({ message: problem });
    const b = req.body || {};
    const password = String(b.password || "");
    if (password.length < 8) return res.status(400).json({ message: "Enter a password of at least 8 characters." });
    const first_name = str(b.first_name || inv.first_name, 80), last_name = str(b.last_name || inv.last_name, 80);

    const tenant = await Tenants.isTenantActive(inv.companyIdentifier).catch(() => ({ success: false }));
    if (!tenant || !tenant.success || !tenant.allowLogin) return res.status(409).json({ message: "Your inspector's E3 account is not active. Please contact them." });

    // ONE LOGIN, SEVERAL INSPECTORS (PR 2): the email already has a portal login
    // -> the password typed is that login's password, and this inspector's client
    // is LINKED to it. No second login, no second password.
    const existing = await links.activeClientByEmail(inv.email).catch(() => null);
    if (existing) {
      if (!(await bcrypt.compare(password, existing.password || ""))) {
        return res.status(401).json({ message: "That is not the password of your existing portal login. Try again, or ask your inspector to reset it." });
      }
      if (!links.hasLink(existing, inv.companyIdentifier, inv.clientId)) {
        await links.addLink(existing.id, { companyIdentifier: inv.companyIdentifier, clientId: inv.clientId, memberUsername: inv.member && inv.member.username, invitationId: inv.id });
      }
      const name = [existing.first_name, existing.last_name].filter(Boolean).join(" ") || existing.username;
      const owner = { userId: existing.id, username: existing.username, email: existing.email, name };
      let account = await portal.getAccount(inv.companyIdentifier, inv.clientId);
      if (!account) {
        account = await portal.upsertAccount({
          companyIdentifier: inv.companyIdentifier, clientId: inv.clientId, clientName: inv.clientName,
          state: "trial", trialEndsAt: null, billing: { enabled: false },
          owner, originMember: inv.member || {}, invitationId: inv.id,
          log: [{ at: new Date().toISOString(), event: "accepted-linked", by: existing.username, note: "invitation " + inv.id + " (existing login, primary inspector " + existing.companyIdentifier + ")" }],
        });
      } else {
        account = await portal.logAccount(Object.assign({}, account, { owner: account.owner || owner }), "login-linked", existing.username, "invitation " + inv.id);
      }
      await portal.setInvitation(inv.id, { status: "accepted", acceptedAt: new Date().toISOString(), acceptedUserId: existing.id, accountId: account.id, linkedExisting: true });
      forgetUser(existing.username);
      const { password: pwd0, ...user0 } = existing;
      user0.companyIdentifier = inv.companyIdentifier; user0.clientId = inv.clientId; // the inspector being shown
      user0.token = jwt.sign(
        { user_id: existing.id, username: existing.username, company: inv.companyIdentifier, role: "client", clientId: inv.clientId },
        process.env.TOKEN_KEY, { expiresIn: "1d" }
      );
      user0.linked = true;
      return res.status(200).json(user0);
    }

    // username = the email when it fits the login rules and is free; otherwise a
    // safe form of it with a short suffix (the email itself must still be unused -
    // one login per email; a second inspector links to it, see above).
    const altUsername = () => (inv.email.split("@")[0].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "client")
      + "-" + portal.newCode().slice(0, 5).toLowerCase();
    let username = /^[A-Za-z0-9._@-]{3,60}$/.test(inv.email) ? inv.email : altUsername();
    let free = await users.claimIdentity(username, inv.email);
    if (!free.ok && free.field !== "email") { username = altUsername(); free = await users.claimIdentity(username, inv.email); }
    if (!free.ok) {
      return res.status(409).json({ message: free.field === "email"
        ? "A login with this email already exists in E3 Web. Sign in with it (or use Forgot password), or ask your inspector to invite a different email address."
        : free.message });
    }
    const created = await users.addClientUser({
      username, email: inv.email, first_name, last_name, mobile: "",
      password: await bcrypt.hash(password, 10),
      clientId: inv.clientId, companyIdentifier: inv.companyIdentifier,
      createdBy: "invite:" + ((inv.member && inv.member.username) || ""),
    });

    // the portal account (trial, no end date until billing ships - PR 3)
    let account = await portal.getAccount(inv.companyIdentifier, inv.clientId);
    const owner = { userId: created.insertedId, username, email: inv.email, name: [first_name, last_name].filter(Boolean).join(" ") };
    if (!account) {
      account = await portal.upsertAccount({
        companyIdentifier: inv.companyIdentifier, clientId: inv.clientId, clientName: inv.clientName,
        state: "trial", trialEndsAt: null, billing: { enabled: false },
        owner, originMember: inv.member || {}, invitationId: inv.id,
        log: [{ at: new Date().toISOString(), event: "accepted", by: username, note: "invitation " + inv.id }],
      });
    } else {
      account = await portal.logAccount(Object.assign({}, account, { owner: account.owner || owner }), "login-added", username, "invitation " + inv.id);
    }
    await portal.setInvitation(inv.id, { status: "accepted", acceptedAt: new Date().toISOString(), acceptedUserId: created.insertedId, accountId: account.id });
    forgetUser(username);

    // sign them in exactly as /api/login/login does for a client login
    const rec = await users.getUserbyUsername(username);
    const { password: pwd, ...user } = rec || {};
    const token = jwt.sign(
      { user_id: rec.id, username, company: rec.companyIdentifier, role: "client", clientId: rec.clientId || null },
      process.env.TOKEN_KEY, { expiresIn: "1d" }
    );
    user.token = token;
    res.status(201).json(user);
  } catch (e) {
    console.error("invite accept:", e && e.message);
    res.status(500).json({ message: "Could not create your login. Please try again." });
  }
});

module.exports = { memberRouter, publicRouter };
