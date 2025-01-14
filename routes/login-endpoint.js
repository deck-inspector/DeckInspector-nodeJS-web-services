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

router.route("/:username").get(async function (req, res) {
  try {
    const username = req.params.username;
    users.getUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {
        if (record) {
          const { password, ...user } = record;
          res.status(201).json(user);
        } else res.status(401).send("user not found.");
      }
    });
  } catch {
    res.status(500).send("Internal server error.");
  }
});

//#region Login
router.route("/login").post(async function (req, res) {
  // our login logic goes here
  try {
    // Get user input
    const { username, password,isMobile,deviceId } = req.body;

    // Validate user input
    if (!(username && password)) {
      res.status(400).send("All input is required");
      return;
    }
    // Validate if user exist in our database
    users.getUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {

        if (record && record.isActive === false) {
          res.status(409).send("User is not active.");
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
              res.status(401).send("Invalid Credentials,company is inactive.");
              return;
            }

          } else {
            res.status(401).send("Invalid Credentials");
            return;
          }
          //check user has a session is already on
          if (isMobile) {
            if (user.deviceId==null) {
              users.updateDevideId(username,deviceId,function(err,result){
                if (err) {
                  console.log(err);
                  res.status(500).send('internal server error');
                }
                });
            }else{
              if (user.deviceId!==deviceId) {
                res.status(401).send("User is registerd with a different device, please contact administrator to unregister your device.");
                return;
              }  
            }
            
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

router.route("/logout").post(async function (req, res) {
  // our login logic goes here
  try {
    // Get user input
    const { username, password } = req.body;

    // Validate user input
    if (!(username&& password)) {
      res.status(400).send("username and password is required");
    }
    // Validate if user exist in our database
    users.getUserbyUsername(username, async function (err, record) {
      if (err) {
        res.status(err.status).send(err.message);
      } else {
        if (record && (await bcrypt.compare(password, record.password))) {
          // Create token
          const { password, ...user } = record;

          //TODO check if that company is active and not marked for deletion.
          var loginAllowed = await Tenants.isTenantActive(
            user.companyIdentifier
          );
          if (loginAllowed.success) {
            if (!loginAllowed.allowLogin) {
              res.status(401).send("Invalid Credentials");
              return;
            }
          } else {
            res.status(401).send("Invalid Credentials");
            return;
          }
          
            users.clearSession(username,function (err, result){
              if (err) {
                res.status(500).send("Server error");
              }else{
                res.status(result.status).send(result.message);
              }
            });
        } else res.status(401).send("Invalid Credentials");
      }
    });
  } catch (err) {
    console.log(err);
  }
});

//#endregion

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
