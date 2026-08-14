"use strict";
// PUBLIC QuickBooks OAuth callback (Intuit redirects the browser here with no
// JWT). The signed `state` parameter carries - and authenticates - the tenant
// that started the connect flow. Everything else QBO lives under the
// authenticated /api/project router.
const express = require("express");
const router = express.Router();
const qbo = require("../service/quickbooksService");

router.get("/callback", async function (req, res) {
  try {
    if (!qbo.configured()) return res.status(500).send("QuickBooks is not configured on the server.");
    const { code, state, realmId, error } = req.query;
    if (error) return res.redirect("/?qbo=denied");
    const companyIdentifier = qbo.verifyState(state);
    if (!companyIdentifier || !code || !realmId) return res.status(400).send("Invalid QuickBooks callback.");
    await qbo.completeConnect(companyIdentifier, code, realmId);
    return res.redirect("/?qbo=connected");
  } catch (e) {
    console.error("QBO callback failed:", e && e.message);
    return res.redirect("/?qbo=error");
  }
});

module.exports = router;
