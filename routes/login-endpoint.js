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

    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_SCOPE_NAME || "inventory"}.Users u WHERE u.username = $1 OR u.email = $1 LIMIT 1`;
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

    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_SCOPE_NAME || "inventory"}.SuperUsers u WHERE u.username = $1 OR u.email = $1 LIMIT 1`;
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
      const { password, ...user } = record;
      res.status(201).json(user);
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

    const loginAllowed = await Tenants.isTenantActive(record.companyIdentifier);
    if (!loginAllowed.success || !loginAllowed.allowLogin) {
      return res.status(401).send("Invalid Credentials,company is inactive.");
    }

    if (isMobile) {
      try {
        const collection = couchbaseDb.Users;
        const userId = record.id || record._id;

        if (!record.deviceId) {
          const doc = await collection.get(userId);
          doc.content.deviceId = deviceId;
          await collection.upsert(userId, doc.content);
        } else if (record.deviceId !== deviceId) {
          return res
            .status(401)
            .send(
              "User is registered with a different device, please contact administrator to unregister your device.",
            );
        }
      } catch (err) {
        console.error("Device ID update error:", err);
        return res.status(500).send("Internal server error");
      }
    }

    const { password: pwd, ...user } = record;
    const token = jwt.sign(
      {
        user_id: record.id || record._id,
        username,
        company: record.companyIdentifier,
      },
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
      const collection = couchbaseDb.Users;
      const userId = record.id || record._id;
      const doc = await collection.get(userId);
      doc.content.hasActiveSession = false;
      await collection.upsert(userId, doc.content);
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
router.route("/registersuperuser").post(function (req, res) {
  try {
    // Get user input
    const { first_name, last_name, email, password, username } = req.body;

    // Validate user input
    if (!(email && password && first_name && last_name && username)) {
      res.status(400).send("All input is required");
      return;
    }

    // check if user already exist
    // Validate if user exist in our database

    users.getSuperUser(email, async function (err, record) {
      if (record) {
        res.status(409).send("User with this email already exist.");
        return;
      } else {
        users.getSuperUserbyUsername(username, async function (err, record) {
          if (record) {
            res.status(409).send("Username already exist.");
            return;
          } else {
            //Encrypt user password
            var encryptedPassword = await bcrypt.hash(password, 10);

            // Create user in our database
            users.addSuperUser(
              {
                first_name,
                last_name,
                username,
                email: email.toLowerCase(), // sanitize: convert email to lowercase
                password: encryptedPassword,
              },
              function (err, result) {
                if (err) {
                  res.status(err.status).send(err.message);
                } else {
                  const user = result;
                  // Create token
                  const token = jwt.sign(
                    {
                      user_id: user._id,
                      email,
                    },
                    process.env.TOKEN_KEY,
                    {
                      expiresIn: "2d",
                    },
                  );
                  // save user token
                  user.token = token;
                  // return new user
                  res.status(201).json(user);
                }
              },
            );
          }
        });
      }
    });
  } catch (err) {
    console.log(err);
  }
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

module.exports = router;
