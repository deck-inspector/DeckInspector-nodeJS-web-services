"use strict";
var express = require("express");
var router = express.Router();

var path = require("path");
const users = require("../model/user");
const bcrypt = require("bcrypt");
var jwt = require("jsonwebtoken");
const Role = require("../model/role");
const Tenants = require("../service/tenantService");

require("dotenv").config();

// ---------------------------------------------------------------------------
// GUARD RAILS (Oct 23 2026, before outside client logins exist). Every route
// here already needs a token, but ANY token could edit / delete ANY user in
// ANY tenant and set role 'admin' on itself. Now:
//   * super-user tokens (admin site - no company in the token) work as before;
//   * a tenant user may only touch users of its own tenant;
//   * changing someone's role needs an admin of that tenant;
//   * client portal logins are managed only from the Client page
//     (/api/clients/:id/logins), never from here.
// ---------------------------------------------------------------------------
function isSuperToken(req) {
  return !!(req.user && !req.user.company);
}
async function requesterRecord(req) {
  try { return await users.getUserbyUsername(req.user && req.user.username); } catch (e) { return null; }
}
// Portal logins (client supervisors AND their contractors, Oct 23 2026) are not
// staff: hidden from staff lists, never editable from here.
function isClientRec(rec) {
  const r = String((rec && rec.role) || "").toLowerCase();
  return r === "client" || r === "contractor";
}
// Resolves the target user and checks the requester may touch it. Sends the
// error response itself and returns null when not allowed.
async function targetUserOrDeny(req, res, username) {
  if (!username) { res.status(400).send("username is required."); return null; }
  const target = await users.getUserbyUsername(String(username));
  if (!target) { res.status(404).send("User not found."); return null; }
  if (isSuperToken(req)) return target;
  if (target.companyIdentifier !== req.user.company) { res.status(403).send("That user belongs to another company."); return null; }
  if (isClientRec(target)) { res.status(403).send("Client and contractor logins are managed on the client's page."); return null; }
  return target;
}

//#region Register user

router.route("/register").post(async function (req, res) {
  try {
    // Get user input
    const {
      first_name,
      last_name,
      email,
      mobile,
      password,
      username,
      access_type,
    } = req.body;

    // Validate user input
    if (!(email && password && first_name && last_name && username && mobile)) {
      return res.status(400).send("All input is required");
    }

    // Get company identifier from the authenticated user
    const companyIdentifier = req.user.company;

    // Check if the count is exceeding the limit
    const tenant = await Tenants.getTenantByCompanyIdentifier(
      companyIdentifier
    );
    const allUsers = await users.getAllUser();
    const filteredUsers = allUsers.users.filter(
      (user) => user.companyIdentifier === companyIdentifier
    );

    switch (access_type) {
      case "both":
        if (
          tenant.Tenant.bothUserCount <=
          filteredUsers.filter((user) => user.access_type === "both").length
        ) {
          return res
            .status(409)
            .send(
              "Cannot add a new user, limit reached. Please contact system admin"
            );
        }
        break;
      case "mobile":
        if (
          tenant.Tenant.mobileUserCount <=
          filteredUsers.filter((user) => user.access_type === "mobile").length
        ) {
          return res
            .status(409)
            .send(
              "Cannot add a new user, limit reached. Please contact system admin"
            );
        }
        break;
      case "web":
        if (
          tenant.Tenant.webUserCount <=
          filteredUsers.filter((user) => user.access_type === "web").length
        ) {
          return res
            .status(409)
            .send(
              "Cannot add a new user, limit reached. Please contact system admin"
            );
        }
        break;
    }

    // Check if the user already exists
    const existingUserByEmail = await users.getUser(email);
    if (existingUserByEmail) {
      return res.status(409).send("User with this email already exists.");
    }

    const existingUserByUsername = await
      users.getUserbyUsername(username);
    
    if (existingUserByUsername) {
      return res.status(409).send("Username already exists.");
    }

    // const existingUserByMobile = await new Promise((resolve, reject) => {
    //   users.getUserbyMobile(mobile, function (err, record) {
    //     resolve(record);
    //   });
    // });

    // console.log("Existing user: ", existingUserByMobile);
    // if (existingUserByMobile) {
    //   return res.status(409).send("Mobile number already in use.");
    // }

    // Encrypt user password
    const encryptedPassword = await bcrypt.hash(password, 10);

    // Create user in the database
    const newUser = await 
      users.addUser(
        {
          first_name,
          last_name,
          username,
          access_type,
          companyIdentifier,
          mobile,
          email: email.toLowerCase(), // Convert email to lowercase
          password: encryptedPassword,
          },
      );
    

    // Create token
    const token = jwt.sign(
      {
        user_id: newUser._id,
        email,
        company: companyIdentifier,
      },
      process.env.TOKEN_KEY,
      {
        expiresIn: "30d",
      }
    );

    // Save user token
    newUser.token = token;

    // Return new user
    return res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Internal Server Error");
  }
});
//#endregion

//#region Login
router.route("/login").post(async function (req, res) {
  // our login logic goes here
  try {
    // Get user input
    const { username, password } = req.body;

    // Validate user input
    if (!(username && password)) {
      res.status(400).send("All input is required");
    }
    // Validate if user exist in our database
    users.getUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {
        if (record && record.isActive === false) {
          res.status(401).send("User is not active.");
          return;         
        }
        if (record && (await bcrypt.compare(password, record.password))) {
          // Create token
          const { password, ...user } = record;

          //TODO check if that company is active and not marked for deletion.
          var loginAllowed = await Tenants.isTenantActive(
            user.companyIdentifier
          );
          if (loginAllowed.success) {
            if (!loginAllowed.allowLogin) {
              res.status(401).send("Client has been deleted/deactivated, please contact system admin.");
              return;
            }
          } else {
            res.status(401).send("Invalid Credentials");
            return;
          }

          const token = jwt.sign(
            {
              user_id: record._id,
              username,
              company: record.companyIdentifier,
            },
            process.env.TOKEN_KEY,
            {
              expiresIn: "1d",
            }
          );

          // save user token
          user.token = token;

          // user
          res.status(201).json(user);
        } else res.status(401).send("Invalid Credentials");
      }
    });
  } catch (err) {
    console.log(err);
  }
});
//#endregion

//#region registerAdmin
router.route("/registeradmin").post(function (req, res) {
  try {
    // Get user input
    const {
      first_name,
      username,
      last_name,
      email,
      mobile,
      password,
      appSecret,
      companyIdentifier,
    } = req.body;
    users.registerAdmin(
      first_name,
      last_name,
      username,
      email,
      mobile,
      password,
      appSecret,
      companyIdentifier,
      function (err, result) {
        if (err) {
          res.status(err.status).send(err.message);
        } else {
          const user = result;
          // Create token
          const token = jwt.sign(
            { user_id: user._id, email, company: companyIdentifier },
            process.env.TOKEN_KEY,
            {
              expiresIn: "30d",
            }
          );
          // save user token
          user.token = token;

          // return new user
          res.status(201).json(user);
        }
      }
    );
  } catch (err) {
    console.log(err);
    res.status(400).json(err);
  }
});

//#endregion

//#region Update user
router.route("/update").post(async function (req, res) {
  try {
    // Get user input
    const user = req.body;
    const companyIdentifier = req.user.company;

    // Guard rails (Oct 23 2026) - see the top of this file.
    const target = await targetUserOrDeny(req, res, user && user.username);
    if (!target) return;
    if (!isSuperToken(req)) {
      delete user.companyIdentifier; // a user can never be moved to another tenant from here
      delete user.clientId;
      const wantRole = user.role === undefined ? undefined : String(user.role || "").toLowerCase();
      const hadRole = String(target.role || "").toLowerCase();
      if (wantRole !== undefined && wantRole !== hadRole) {
        const me = await requesterRecord(req);
        const meAdmin = !!(me && String(me.role || "").toLowerCase() === "admin" && me.companyIdentifier === companyIdentifier);
        if (!meAdmin) return res.status(403).send("Only an admin can change a user's role.");
        if (wantRole !== "admin" && wantRole !== "user") return res.status(400).send("Role must be admin or user.");
      }
    }
    //check if the count is exceeding the limit
    var tenant = await Tenants.getTenantByCompanyIdentifier(companyIdentifier);
    const result = await users.getAllUser();
    var tenantUsers = result.users.filter(
      (existingUser) => existingUser.companyIdentifier === companyIdentifier
    );

    switch (user.access_type) {
      case "both":
        if (
          tenant.Tenant.bothUserCount <=
          tenantUsers.filter((existingUser) => existingUser.access_type === "both")
            .length
        ) {
          return res
            .status(409)
            .send("Cannot update, limit reached. Please contact system admin");
        }
        break;
      case "mobile":
        if (
          tenant.Tenant.mobileUserCount <=
          tenantUsers.filter((existingUser) => existingUser.access_type === "mobile")
            .length
        ) {
          return res
            .status(409)
            .send("Cannot update, limit reached. Please contact system admin");
        }
        break;
      case "web":
        if (
          tenant.Tenant.webUserCount <=
          tenantUsers.filter((existingUser) => existingUser.access_type === "web")
            .length
        ) {
          return res
            .status(409)
            .send("Cannot update, limit reached. Please contact system admin");
        }
        break;
    }

    
    
    if ("password" in user)
      user.password = await bcrypt.hash(user.password, 10);
    const updateResult = await users.updateUser(user);
    res.status(updateResult.status).send(updateResult.message);
  } catch (err) {
    console.log(err);
    res.status(500).send(`Internal server error ${err}`);
  }
});
//#endregion

//#region delete user
router.route("/delete").post(async function (req, res) {
  try {
    // Get user input
    const user = req.body;
    const target = await targetUserOrDeny(req, res, user && user.username);
    if (!target) return;
    const result = await users.removeUser({ username: target.username });
    res.status(result.status).send(result.message);
  } catch (err) {
    console.log(err);
    res.status(500).send(`Internal server error ${err}`);
  }
});
//#endregion

//#region getAllUsers
router.route("/allusers").get(async function (req, res) {
  try {
    var companyIdentifier = req.user.company;
    const result = await users.getAllUser();
    // Staff list only: client portal logins are not inspectors (Oct 23 2026).
    const filteredUsers = result.users.filter(
      (user) => user.companyIdentifier === companyIdentifier && !isClientRec(user)
    );
    res.status(result.status).json(filteredUsers);
  } catch (err) {
    res.status(err.status || 500).send(err.message || "Internal server error.");
  }
});

router.route("/allusersbytenant").get(async function (req, res) {
  try {
    var companyIdentifier = req.query.company;
    const result = await users.getAllUser();
    // Tenant users only (a tenant token may not list another tenant), and staff
    // only - client portal logins live on the Client page (Oct 23 2026).
    if (!isSuperToken(req) && companyIdentifier !== req.user.company) {
      return res.status(403).send("That company is not yours.");
    }
    result.users = result.users.filter(
      (user) =>
        user.companyIdentifier &&
        user.companyIdentifier === companyIdentifier &&
        !isClientRec(user)
    );
    res.status(result.status).json(result.users);
  } catch (exception) {
    res.status(500).send(`Intenal server error.${exception}"`);
  }
});

//#endregion
router.route("/deviceId")
  .put(async function (req, res) {
    try {
      const { username, deviceId } = req.body;
      const target = await targetUserOrDeny(req, res, username);
      if (!target) return;
      const result = await users.updateDevideId(target.username, deviceId);
      res.status(result.status).json(result);
    } catch {
      res.status(500).send("Internal server error.");
    }
  });
  
router
  .route("/:username")
  .get(async function (req, res) {
    try {
      const username = req.params.username;
      const result = await users.getUserbyUsername(username )
      if (result && !isSuperToken(req) && result.companyIdentifier !== req.user.company) {
        return res.status(401).send("user not found.");
      }
      if (result) {
        const { password, ...user } = result;
        res.status(201).json(user);
      } else {
        res.status(401).send("user not found.");
      }
    } catch (err) {
      console.error("Error:", err);
      res.status(500).send("Internal server error.");
    }
        
  })
  .put(async function (req, res) {
    try {
      const username = req.params.username;
      const isActive = req.body.isActive;
      const target = await targetUserOrDeny(req, res, username);
      if (!target) return;
      const result = await users.updateUserStatus(target.username, isActive);
      res.status(result.status).json({ message: result.message });
    } catch {
      res.status(500).send("Internal server error.");
    }
  })
  .delete(async function (req, res) {
    try {
      const username = req.params.username;
      const target = await targetUserOrDeny(req, res, username);
      if (!target) return;
      const result = await users.removeUser({ username: target.username });
      res.status(result.status).json({ message: result.message });
    } catch {
      res.status(500).send("Internal server error.Failed to delete user.");
    }
  });

router.route("/superlogin").post(async function (req, res) {
  // our login logic goes here
  try {
    // Get user input
    const { username, password } = req.body;

    // Validate user input
    if (!(username && password)) {
      res.status(400).send("All input is required");
    }
    // Validate if user exist in our database
    users.getSuperUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {
        if (record && (await bcrypt.compare(password, record.password))) {
          // Create token
          const { password, ...user } = record;
          const token = jwt.sign(
            { user_id: record._id, username },
            process.env.TOKEN_KEY,
            {
              expiresIn: "1d",
            }
          );

          // save user token
          user.token = token;

          // user
          res.status(201).json(user);
        } else res.status(401).send("Invalid Credentials");
      }
    });
  } catch (err) {
    console.log(err);
  }
});
// DISABLED (Oct 23 2026): any signed-in inspector could create a super user
// here. Nothing calls it. (Registered first, so the old handler below never runs.)
router.route("/registersuperuser").all(function (req, res) {
  return res.status(410).send("Super-user registration is disabled.");
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
                    }
                  );
                  // save user token
                  user.token = token;
                  // return new user
                  res.status(201).json(user);
                }
              }
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
  // our login logic goes here
  try {
    // Get user input
    const { username, password } = req.body;

    // Validate user input
    if (!(username && password)) {
      res.status(400).send("All input is required");
    }
    // Validate if user exist in our database
    users.getSuperUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {
        if (record && (await bcrypt.compare(password, record.password))) {
          // Create token
          const { password, ...user } = record;
          const token = jwt.sign(
            { user_id: record._id, username },
            process.env.TOKEN_KEY,
            {
              expiresIn: "1d",
            }
          );

          // save user token
          user.token = token;

          // user
          res.status(201).json(user);
        } else res.status(401).send("Invalid Credentials");
      }
    });
  } catch (err) {
    console.log(err);
  }
});



module.exports = router;
