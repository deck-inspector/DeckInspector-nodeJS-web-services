"use strict";
var express = require("express");
var router = express.Router();
var path = require("path");
const users = require("../model/user");
const bcrypt = require("bcrypt");
var jwt = require("jsonwebtoken");
const Role = require("../model/role");
const Tenants = require("../service/tenantService");
const couchbaseDb = require("../database/couchbase");

require("dotenv").config();

// Helper function to query users from Couchbase
async function getCouchbaseUser(usernameOrEmail) {
  try {
    const cluster = couchbaseDb.cluster;
    if (!cluster) throw new Error("Couchbase not initialized");

    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_PROD_SCOPE_NAME || "inventory"}.Users u WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1) LIMIT 1`;
    const result = await cluster.query(query, {
      parameters: [usernameOrEmail],
    });

    return result.rows && result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error("Couchbase query error:", error);
    throw error;
  }
}

// Helper function to query super users from Couchbase
async function getCouchbaseSuperUser(usernameOrEmail) {
  try {
    const cluster = couchbaseDb.cluster;
    if (!cluster) throw new Error("Couchbase not initialized");

    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_PROD_SCOPE_NAME || "inventory"}.SuperUsers u WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1) LIMIT 1`;
    const result = await cluster.query(query, {
      parameters: [usernameOrEmail],
    });

    return result.rows && result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error("Couchbase query error:", error);
    throw error;
  }
}

router.route("/:username").get(async function (req, res) {
  try {
    const username = req.params.username;
    const record = await getCouchbaseUser(username);

    if (record) {
      // PUBLIC route (no token): status fields only - no email, phone, device
      // id or other personal details (Oct 23 2026, before client logins exist).
      res.status(201).json({
        username: record.username,
        role: record.role,
        companyIdentifier: record.companyIdentifier,
        isActive: record.isActive !== false,
        access_type: record.access_type,
        hasDeviceId: !!record.deviceId,
      });
    } else {
      res.status(401).send("user not found.");
    }
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Internal server error.");
  }
});

//#region Login
router.route("/login").post(async function (req, res) {
  try {
    const { username, password, isMobile, deviceId } = req.body;

    if (!(username && password)) {
      return res.status(400).send("All input is required");
    }

    const record = await getCouchbaseUser(username);
    if (!record) {
      return res.status(401).send("Invalid Credentials");
    }

    if (record.isActive === false) {
      return res.status(409).send("User is not active.");
    }

    if (!(await bcrypt.compare(password, record.password))) {
      return res.status(401).send("Invalid Credentials");
    }

    // CLIENT PORTAL (Oct 23 2026): owner / property-manager logins are
    // view-only and web-only for now. The phone app syncs every property of the
    // tenant and is an editing tool, so a client login is refused there until
    // the per-user read-only phone sync is built.
    // contractors (repairs portal, Oct 23 2026) are portal logins too
    const portalRole = String(record.role || "").toLowerCase();
    const isClientLogin = portalRole === "client" || portalRole === "contractor";

    // A client login linked to several inspectors (PR 2, Nov 1 2026) signs in
    // through its first inspector; when that inspector's E3 account is inactive
    // the session starts on the first active linked inspector instead.
    let loginCompany = record.companyIdentifier, loginClientId = record.clientId || null;
    let loginAllowed = await Tenants.isTenantActive(record.companyIdentifier);
    // The owner's login outlives any one inspector (Nov 1 2026): when the first
    // inspector ended its access, start on the next active one.
    const primaryEnded = portalRole === "client" && record.primaryActive === false;
    if ((primaryEnded || !loginAllowed.success || !loginAllowed.allowLogin) && portalRole === "client") {
      const links = require("../model/portalLinks");
      loginAllowed = { success: false };
      for (const l of links.linksOf(record).filter((x) => !x.primary && x.active)) {
        const t = await Tenants.isTenantActive(l.companyIdentifier).catch(() => ({ success: false }));
        if (t && t.success && t.allowLogin) { loginAllowed = t; loginCompany = l.companyIdentifier; loginClientId = l.clientId; break; }
      }
      if (!loginAllowed.success && primaryEnded) { // password already checked above
        return res.status(409).send("No inspector is sharing properties with your login right now. Your login is kept: when an inspector invites this email again, sign in with this same password.");
      }
    }
    if (!loginAllowed.success || !loginAllowed.allowLogin) {
      return res.status(401).send("Invalid Credentials,company is inactive.");
    }
    if (isClientLogin && isMobile) {
      return res
        .status(403)
        .send("Client and contractor accounts use the website: open www.e3-web.com in your phone's browser.");
    }

    // Usernames listed in MULTI_DEVICE_USERS (comma-separated, case-insensitive)
    // may sign in from any phone: used for the App Store review demo account,
    // which Apple tests on its own iPad + iPhone (Sep 4 2026 rejection 2.1).
    const multiDeviceUsers = String(process.env.MULTI_DEVICE_USERS || "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean);
    const isMultiDeviceUser = multiDeviceUsers.includes(String(record.username || username).toLowerCase());

    if (isMobile && !isMultiDeviceUser) {
      const userId = record.id || record._id;
      const incomingDeviceId = typeof deviceId === "string" ? deviceId.trim() : "";

      if (record.deviceId && incomingDeviceId && record.deviceId !== incomingDeviceId) {
        return res
          .status(401)
          .send(
            "User is registered with a different device, please contact administrator to unregister your device.",
          );
      }

      // Record the phone's device id the first time we see a real one. This
      // must NEVER hold the login hostage: the phone gives up after 20 s and
      // silently drops into offline mode (Shahn/Vital, Sep 3 2026 - his record
      // had an empty deviceId so this UPDATE ran on every login and stalled).
      // Hard 4 s cap; on timeout/error log it and let the login through.
      if (!record.deviceId && incomingDeviceId) {
        const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.deviceId = $2`;
        const update = couchbaseDb.cluster.query(updateQuery, { parameters: [userId, incomingDeviceId] });
        const cap = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("deviceId update timed out (4s)")), 4000),
        );
        try {
          await Promise.race([update, cap]);
        } catch (err) {
          console.error("Device ID update skipped for", username, "-", err && err.message);
          update.catch(() => {}); // keep a late failure from surfacing as unhandled
        }
      }
    }

    const { password: pwd, ...user } = record;
    const claims = {
      user_id: record.id || record._id,
      username,
      company: loginCompany,
    };
    // Client logins carry their role + client in the token (the server lock in
    // service/clientAccess.js also re-reads the user record on every request).
    if (isClientLogin) {
      claims.role = portalRole;
      claims.clientId = loginClientId;
      // the web app reads these two to know which inspector it is showing
      user.companyIdentifier = loginCompany;
      user.clientId = loginClientId;
    }
    const token = jwt.sign(
      claims,
      process.env.TOKEN_KEY,
      { expiresIn: "1d" },
    );

    user.token = token;
    res.status(201).json(user);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Internal server error");
  }
});

router.route("/logout").post(async function (req, res) {
  try {
    const { username, password } = req.body;

    if (!(username && password)) {
      return res.status(400).send("username and password is required");
    }

    const record = await getCouchbaseUser(username);
    if (!record) {
      return res.status(401).send("Invalid Credentials");
    }

    if (!(await bcrypt.compare(password, record.password))) {
      return res.status(401).send("Invalid Credentials");
    }

    const loginAllowed = await Tenants.isTenantActive(record.companyIdentifier);
    if (!loginAllowed.success || !loginAllowed.allowLogin) {
      return res.status(401).send("Invalid Credentials");
    }

    try {
      const userId = record.id || record._id;
      // KV was timing out against the degraded data service; write through the healthy query service instead.
      const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.hasActiveSession = $2`;
      await couchbaseDb.cluster.query(updateQuery, { parameters: [userId, false] });
      return res.status(201).send("User session cleared successfully.");
    } catch (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Server error");
    }
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).send("Server error");
  }
});

//#endregion

router.route("/superlogin").post(async function (req, res) {
  try {
    const { username, password } = req.body;

    if (!(username && password)) {
      return res.status(400).send("All input is required");
    }

    const record = await getCouchbaseSuperUser(username);
    if (!record) {
      return res.status(401).send("Invalid Credentials");
    }

    if (!(await bcrypt.compare(password, record.password))) {
      return res.status(401).send("Invalid Credentials");
    }

    const { password: pwd, ...user } = record;
    const token = jwt.sign(
      { user_id: record.id || record._id, username },
      process.env.TOKEN_KEY,
      { expiresIn: "1d" },
    );

    user.token = token;
    user._id = record.id || record._id;
    res.status(201).json(user);
  } catch (err) {
    console.error("Super login error:", err);
    res.status(500).send("Internal server error");
  }
});
// DISABLED (Oct 23 2026): this was a PUBLIC route - anyone on the internet could
// try to create a super user. Nothing calls it (the admin site only signs in).
router.route("/registersuperuser").all(function (req, res) {
  return res.status(410).send("Super-user registration is disabled.");
});

router.route("/loginSuperUser").post(async function (req, res) {
  try {
    const { username, password } = req.body;

    if (!(username && password)) {
      return res.status(400).send("All input is required");
    }

    const record = await getCouchbaseSuperUser(username);
    if (!record) {
      return res.status(401).send("Invalid Credentials");
    }

    if (!(await bcrypt.compare(password, record.password))) {
      return res.status(401).send("Invalid Credentials");
    }

    const { password: pwd, ...user } = record;
    const token = jwt.sign(
      { user_id: record.id || record._id, username },
      process.env.TOKEN_KEY,
      { expiresIn: "1d" },
    );

    user.token = token;
    user._id = record.id || record._id;
    res.status(201).json(user);
  } catch (err) {
    console.error("Login super user error:", err);
    res.status(500).send("Internal server error");
  }
});

// E3 Admin: change MY password (David, Nov 1 2026 - the admin site faces the internet).
// POST /api/login/superUserPassword { currentPassword, newPassword }
// Needs the E3 Admin's own token (Authorization header, no `company` claim) AND the
// current password. 5 wrong current passwords lock this for 15 minutes.
const pwFails = new Map(); // lower(username) -> { n, until }
router.route("/superUserPassword").post(async function (req, res) {
  try {
    let p;
    try { p = jwt.verify(req.headers.authorization || "", process.env.TOKEN_KEY); } catch (e) { return res.status(401).json({ message: "Please sign in again." }); }
    if (!p || p.company || !p.username) return res.status(403).json({ message: "E3 Admin only." });
    const key = String(p.username).toLowerCase();
    const f = pwFails.get(key);
    if (f && f.until > Date.now()) return res.status(429).json({ message: "Too many wrong passwords. Try again in 15 minutes." });
    const { currentPassword, newPassword } = req.body || {};
    const next = String(newPassword || "");
    if (!currentPassword || !next) return res.status(400).json({ message: "Enter your current password and a new password." });
    if (next.length < 12) return res.status(400).json({ message: "The new password must be at least 12 characters." });
    if (next === String(currentPassword)) return res.status(400).json({ message: "The new password must be different from the current one." });
    const record = await getCouchbaseSuperUser(p.username);
    if (!record) return res.status(403).json({ message: "E3 Admin only." });
    if (!(await bcrypt.compare(String(currentPassword), record.password || ""))) {
      const n = ((f && f.until <= Date.now()) ? 0 : (f ? f.n : 0)) + 1;
      pwFails.set(key, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      return res.status(401).json({ message: "Your current password is not correct." });
    }
    pwFails.delete(key);
    const hash = await bcrypt.hash(next, 10);
    // Direct document update (no query text): the N1QL UPDATE failed to parse live.
    // Same scope + collection the login lookup reads (getCouchbaseSuperUser).
    const { MutateInSpec } = require("couchbase");
    const keys = await couchbaseDb.cluster.query(
      `SELECT RAW META(u).id FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_PROD_SCOPE_NAME || "inventory"}.SuperUsers u WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1) LIMIT 1`,
      { parameters: [p.username] }
    );
    const docKey = keys.rows && keys.rows[0];
    if (!docKey) throw new Error("super user key not found");
    await couchbaseDb.prod_scope.collection("SuperUsers").mutateIn(String(docKey), [
      MutateInSpec.replace("password", hash),
      MutateInSpec.upsert("passwordChangedAt", new Date().toISOString()),
    ]);
    console.log("E3 Admin password changed:", record.username);
    res.status(200).json({ ok: 1, message: "Password changed." });
  } catch (err) {
    console.error("Super user password change:", err && err.message);
    res.status(500).json({ message: "Could not change the password. Nothing was changed." });
  }
});

module.exports = router;
