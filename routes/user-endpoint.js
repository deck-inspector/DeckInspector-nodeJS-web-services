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
    const result = await users.removeUser(user);
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
    const filteredUsers = result.users.filter(
      (user) => user.companyIdentifier === companyIdentifier
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
    result.users = result.users.filter(
      (user) =>
        user.companyIdentifier &&
        user.companyIdentifier === companyIdentifier
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
      const result = await users.updateDevideId(username, deviceId);
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
      const result = await users.updateUserStatus(username, isActive);
      res.status(result.status).json({ message: result.message });
    } catch {
      res.status(500).send("Internal server error.");
    }
  })
  .delete(async function (req, res) {
    try {
      const username = req.params.username;
      const result = await users.removeUser({ username });
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
