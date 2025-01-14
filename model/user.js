"use strict";
var ObjectId = require("mongodb").ObjectId;
var mongo = require("../database/mongo");
const Role = require("./role");
const bcrypt = require("bcrypt");
var jwt = require("jsonwebtoken");
const Tenants = require("../service/tenantService");

var addUser = function (user, callback) {
  // console.log("user: ", user);
  mongo.Users.insertOne(
    {
      username: user.username,
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      mobile: user.mobile,
      password: user.password,
      role: Role.User,
      access_type: user.access_type,
      companyIdentifier: user.companyIdentifier,
    },
    { w: 1 },
    function (err, result) {
      if (err) {
        var error = new Error("addUser()." + err.message);
        error.status = err.status;
        callback(error);
        return;
      }
      callback(null, result);
    }
  );
};

var addSuperUser = async function (user, callback) {
  var encryptedPassword = await bcrypt.hash(user.password, 10);
  mongo.SuperUsers.insertOne(
    {
      username: user.username,
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      password: encryptedPassword,
    },
    { w: 1 },
    function (err, result) {
      if (err) {
        var error = new Error("addSuperUser()." + err.message);
        error.status = err.status;
        callback(error);
        return;
      }
      callback(null, result);
    }
  );
};
var addAdmin = function (user, callback) {
  // console.log("user: ", user);
  mongo.Users.insertOne(
    {
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      mobile: user.mobile,
      password: user.password,
      username: user.username,
      role: Role.Admin,
      access_type: "both",
      companyIdentifier: user.companyIdentifier,
    },
    { w: 1 },
    function (err, result) {
      if (err) {
        var error = new Error("addAdmin()." + err.message);
        error.status = err.status;
        callback(error);
        return;
      }
      callback(null, result);
    }
  );
};
var getUser = async function (emailId, callback) {
  var result = await mongo.Users.findOne({ email: emailId });

  if (result === null) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. One Requested."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  callback(null, result);
};
var getSuperUser = async function (emailId, callback) {
  var result = await mongo.SuperUsers.findOne({ email: emailId });

  if (result === null) {
    var error1 = new Error(
      "getSuperUser(). \nMessage: No User Found. One Requested."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  callback(null, result);
};
var getUserbyUsername = async function (username, callback) {
  if (username === undefined) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. username undefined."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  var result = await mongo.Users.findOne({ username: username });

  if (!result) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. One Requested."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  callback(null, result);
};

var getUserbyMobile = async function (mobile, callback) {
  console.log("Mobile: ", mobile);
  if (mobile === undefined) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. mobile number undefined."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  var result = await mongo.Users.findOne({ mobile: mobile });

  if (!result) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. One Requested."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  callback(null, result);
};

var getSuperUserbyUsername = async function (username, callback) {
  if (username === undefined) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. username undefined."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  var result = await mongo.SuperUsers.findOne({ username: username });

  if (result === null) {
    var error1 = new Error(
      "getUser(). \nMessage: No User Found. One Requested."
    );
    error1.status = 404;
    callback(error1);
    return;
  }
  callback(null, result);
};
var updateDevideId = async function ( username,deviceId, callback){
  var result = await mongo.Users.updateOne({username:username}, {$set:{deviceId:deviceId}});
  if (result.modifiedCount) {
    callback(null, {
      status: 201,
      message: "User device added successfully.",
    });
  }else{
    
      callback(null, {
        status: 409,
        message: "Failed to update the user device details.",
      });
  }
}
var updateUserStatus = async function ( username,status, callback){
  var result = await mongo.Users.updateOne({username:username}, {$set:{isActive:status}});
  if (result.modifiedCount) {
    callback(null, {
      status: 201,
      message: "User status updated successfully.",
    });
  }else{
    
      callback(null, {
        status: 409,
        message: "Failed to update the user status.",
      });
  }
}
var updateSession = async function ( username,callback){
  var result = await mongo.Users.updateOne({username:username}, {$set:{hasActiveSession:true}});
  if (result.modifiedCount) {
    callback(null, {
      status: 201,
      message: "User login session updated successfully.",
    });
  }else{
    
      callback(null, {
        status: 409,
        message: "Failed to update the user session details.",
      });
  }
}

var clearSession = async function ( username,callback){
  var result = await mongo.Users.updateOne({username:username}, {$set:{hasActiveSession:false}});
  if (result.modifiedCount) {
    callback(null, {
      status: 201,
      message: "User login session cleared successfully.",
    });
  }else{
    
      callback(null, {
        status: 409,
        message: "Failed to update the user session details.",
      });
  }
}
var updateUser = async function (user, callback) {
  var result = await mongo.Users.updateOne(
    { username: user.username },
    { $set: user }
  );

  if (result.matchedCount < 1) {
    var error = new Error("No User found, please register user.");
    error.status = 401;
    callback(error);
  } else {
    if (result.modifiedCount == 1) {
      callback(null, {
        status: 201,
        message: "User details updated successfully.",
      });
    } else
      callback(null, {
        status: 409,
        message: "Failed to update the user details.",
      });
  }
};

var getAllUser = async function (callback) {
  var result = await mongo.Users.find({}).limit(500).toArray();
  if (result === null) {
    var error = new Error(
      "getAllUser(). \nMessage: No Users Found. All Requested."
    );
    error.status = 401;
    callback(error);
    return;
  }
  const users = result.map((item) => {
    delete item.password;
    delete item._id;
    return item;
  });

  callback(null, { status: 200, users });
};
var removeUser = async function (user, callback) {
  var result = await mongo.Users.deleteOne({ username: user.username });
  if (result.deletedCount == 1) {
    callback(null, { status: 201, message: "User deleted successfully." });
  } else {
        var error2 = new Error(
      "Error occurred. Didn't remove user. "
    );
    error2.status = 500;
    callback(error2);
    return;
  }
};

var registerAdmin = async function (
  first_name,
  last_name,
  username,
  email,
  mobile,
  password,
  appSecret,
  companyIdentifier,
  callback
) {
  // console.log("user.js-registerAdmin");
  if (
    !(email && password && first_name && mobile && last_name && username,
    companyIdentifier)
  ) {
    var error1 = new Error("All input is required");
    error1.status = 400;
    callback(error1);
    return;
  }

  // Check if the count is exceeding the limit
  const tenant = await Tenants.getTenantByCompanyIdentifier(companyIdentifier);
  const allUsers = await new Promise((resolve, reject) => {
    getAllUser(function (err, result) {
      resolve(result);
    });
  });
  const filteredUsers = allUsers.users.filter(
    (user) => user.companyIdentifier === companyIdentifier
  );

  if (
    tenant.Tenant.bothUserCount <=
    filteredUsers.filter((user) => user.access_type === "both").length
  ) {
    // return res.status(409).send("Cannot add a new user, limit reached. Please contact system admin");
    var error1 = new Error(
      "Cannot add a new user, limit reached. Please contact system admin"
    );
    error1.status = 409;
    callback(error1);
    return;
  }

  if (appSecret !== process.env.APP_SECRET) {
    var error1 = new Error(
      "Please contact administrator to register as an Admin"
    );
    error1.status = 403;
    callback(error1);
    return;
  }
  // Check if user already exists by email
  getUser(email, async function (err, recordByEmail) {
    if (recordByEmail) {
      var error1 = new Error(
        "User with this email already exists. Please Login"
      );
      error1.status = 409;
      callback(error1, null);
      return;
    } else {
      // Check if username already exists
      getUserbyUsername(username, async function (err, recordByUsername) {
        if (recordByUsername) {
          var error1 = new Error(
            "Username already exists. Please choose a different username"
          );
          error1.status = 409;
          callback(error1, null);
          return;
        } else {
            
        //   const existingUserByMobile = await new Promise((resolve, reject) => {
        //     getUserbyMobile(mobile, function (err, record) {
        //       resolve(record);
        //     });
        //   });

        //   console.log("Existing user:", existingUserByMobile);

        //   if (existingUserByMobile) {
        //     return res.status(409).send("Mobile number already in use.");
        //   }

          var encryptedPassword = await bcrypt.hash(password, 10);

          // Create user in our database
          addAdmin(
            {
              first_name,
              last_name,
              username,
              mobile,
              companyIdentifier,
              email: email.toLowerCase(), // sanitize: convert email to lowercase
              password: encryptedPassword,
            },
            function (err, result) {
              if (err) {
                callback(err, null);
              } else {
                const user = result;
                // Create token
                const token = jwt.sign(
                  { user_id: user._id, email },
                  process.env.TOKEN_KEY,
                  {
                    expiresIn: "30d",
                  }
                );
                // save user token
                user.token = token;

                // return new user
                callback(null, user);
              }
            }
          );
        }
      });
    }
  });
};

function verifyToken(req, res, next) {
  //console.log('inside verifyToken');
  const token =
    req.body.token || req.query.token || req.headers["x-access-token"];

  if (!token) {
    return res
      .status(403)
      .send("A token is required for accessing this resource");
  }
  try {
    const decoded = jwt.verify(token, process.env.TOKEN_KEY);
    req.user = decoded;
  } catch (err) {
    return res.status(401).send("Invalid Token");
  }
  return next();
}

module.exports = {
  addUser: addUser,
  getUser: getUser,
  addAdmin: addAdmin,
  getAllUser: getAllUser,
  removeUser: removeUser,
  getUserbyUsername,
  getUserbyMobile,
  updateUser,
  registerAdmin,
  getSuperUserbyUsername,
  getSuperUser,
  addSuperUser,
  updateSession,
  clearSession,
  updateDevideId,
  updateUserStatus
};
