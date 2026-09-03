"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const Role = require("./role");
const bcrypt = require("bcrypt");
var jwt = require("jsonwebtoken");
const Tenants = require("../service/tenantService");

// Helper function to get Users collection
async function getUsersCollection() {
  return couchbase.Users;
}

// Helper function to get SuperUsers collection
async function getSuperUsersCollection() {
  return couchbase.SuperUsers;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    if (!cluster) {
      throw new Error("Cluster connection not initialized.");
    }
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

var addUser = async function (user) {
  try {
    const userId = `user_${uuidv4()}`;
    const collection = await getUsersCollection();
    const userDoc = {
      username: user.username,
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      mobile: user.mobile,
      password: user.password,
      role: Role.User,
      access_type: user.access_type,
      companyIdentifier: user.companyIdentifier,
      type: "User",
      createdAt: new Date().toISOString(),
    };
    await collection.insert(userId, userDoc);
    return { insertedId: userId, ok: 1 };
  } catch (error) {
    console.error("addUser error:", error);
    throw error;
  }
};

var addSuperUser = async function (user) {
  try {
    const userId = `superuser_${uuidv4()}`;
    const encryptedPassword = await bcrypt.hash(user.password, 10);
    const collection = await getSuperUsersCollection();
    const userDoc = {
      username: user.username,
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      password: encryptedPassword,
      type: "SuperUser",
      createdAt: new Date().toISOString(),
    };
    await collection.insert(userId, userDoc);
    return { insertedId: userId, ok: 1 };
  } catch (error) {
    console.error("addSuperUser error:", error);
    throw error;
  }
};
var addAdmin = async function (user) {
  try {
    const userId = `admin_${uuidv4()}`;
    const collection = await getUsersCollection();
    const userDoc = {
      last_name: user.last_name,
      first_name: user.first_name,
      email: user.email,
      mobile: user.mobile,
      password: user.password,
      username: user.username,
      role: Role.Admin,
      access_type: "both",
      companyIdentifier: user.companyIdentifier,
      type: "User",
      createdAt: new Date().toISOString(),
    };
    await collection.insert(userId, userDoc);
    return { insertedId: userId, ok: 1 };
  } catch (error) {
    console.error("addAdmin error:", error);
    throw error;
  }
};
var getUser = async function (emailId) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE LOWER(u.email) = LOWER($1)`;
    const results = await executeQuery(query, [emailId]);
    
    if (results.length === 0) {
      return null; 
    }
    return results[0];
  } catch (error) {
    console.error("getUser error:", error);
    throw error;
  }
};
var getSuperUser = async function (emailId) {
  try {
    const collection = await getSuperUsersCollection();
    const query = `SELECT META(s).id as id, s.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.SuperUsers s WHERE s.email = $1`;
    const results = await executeQuery(query, [emailId]);
    
    if (results.length === 0) {
      throw new Error("No SuperUser Found.");
    }
    return results[0];
  } catch (error) {
    console.error("getSuperUser error:", error);
    throw error;
  }
};
var getUserbyUsername = async function (username) {
  try {
    if (username === undefined) {
      throw new Error("username undefined.");
    }
    const collection = await getUsersCollection();
    
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE LOWER(u.username) = LOWER($1)`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      return null;
    }
    return results[0];
  } catch (error) {
    console.error("getUserbyUsername error:", error);
    throw error;
  }
};

var getUserbyMobile = async function (mobile) {
  try {
    console.log("Mobile: ", mobile);
    if (mobile === undefined) {
      throw new Error("mobile number undefined.");
    }
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.mobile = $1`;
    const results = await executeQuery(query, [mobile]);
    
    if (results.length === 0) {
      throw new Error("No User Found.");
    }
    return results[0];
  } catch (error) {
    console.error("getUserbyMobile error:", error);
    throw error;
  }
};

var getSuperUserbyUsername = async function (username) {
  try {
    if (username === undefined) {
      throw new Error("username undefined.");
    }
    const collection = await getSuperUsersCollection();
    const query = `SELECT META(s).id as id, s.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.SuperUsers s WHERE s.username = $1`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      throw new Error("No SuperUser Found.");
    }
    return results[0];
  } catch (error) {
    console.error("getSuperUserbyUsername error:", error);
    throw error;
  }
};
var updateDevideId = async function (username, deviceId) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      throw new Error("User not found");
    }
    
    const userId = results[0].id;
    // KV was timing out against the degraded data service; write through the healthy query service instead.
    const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.deviceId = $2`;
    await executeQuery(updateQuery, [userId, deviceId]);
    
    return {
      status: 201,
      message: "User device added successfully.",
    };
  } catch (error) {
    console.error("updateDevideId error:", error);
    return {
      status: 409,
      message: "Failed to update the user device details.",
    };
  }
};
var updateUserStatus = async function (username, status) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      throw new Error("User not found");
    }
    
    const userId = results[0].id;
    // KV was timing out against the degraded data service; write through the healthy query service instead.
    const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.isActive = $2`;
    await executeQuery(updateQuery, [userId, status]);
    
    return {
      status: 201,
      message: "User status updated successfully.",
    };
  } catch (error) {
    console.error("updateUserStatus error:", error);
    return {
      status: 409,
      message: "Failed to update the user status.",
    };
  }
};
var updateSession = async function (username) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      throw new Error("User not found");
    }
    
    const userId = results[0].id;
    // KV was timing out against the degraded data service; write through the healthy query service instead.
    const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.hasActiveSession = $2`;
    await executeQuery(updateQuery, [userId, true]);
    
    return {
      status: 201,
      message: "User login session updated successfully.",
    };
  } catch (error) {
    console.error("updateSession error:", error);
    return {
      status: 409,
      message: "Failed to update the user session details.",
    };
  }
};

var clearSession = async function (username) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [username]);
    
    if (results.length === 0) {
      throw new Error("User not found");
    }
    
    const userId = results[0].id;
    // KV was timing out against the degraded data service; write through the healthy query service instead.
    const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.hasActiveSession = $2`;
    await executeQuery(updateQuery, [userId, false]);
    
    return {
      status: 201,
      message: "User login session cleared successfully.",
    };
  } catch (error) {
    console.error("clearSession error:", error);
    return {
      status: 409,
      message: "Failed to update the user session details.",
    };
  }
};
var updateUser = async function (user) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [user.username]);
    
    if (results.length === 0) {
      throw new Error("No User found, please register user.");
    }
    
    const userId = results[0].id;
    const userDoc = await collection.get(userId);
    const updatedDoc = { ...userDoc.content, ...user };
    await collection.upsert(userId, updatedDoc);
    
    return {
      status: 201,
      message: "User details updated successfully.",
    };
  } catch (error) {
    console.error("updateUser error:", error);
    throw error;
  }
};

var getAllUser = async function () {
  try {
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u LIMIT 500`;
    const results = await executeQuery(query);
    
    if (results.length === 0) {
      throw new Error("No Users Found.");
    }
    
    const users = results.map((item) => {
      delete item.password;
      delete item._id;
      return item;
    });
    
    return { status: 200, users };
  } catch (error) {
    console.error("getAllUser error:", error);
    throw error;
  }
};
var removeUser = async function (user) {
  try {
    const collection = await getUsersCollection();
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE u.username = $1`;
    const results = await executeQuery(query, [user.username]);
    
    if (results.length === 0) {
      throw new Error("User not found");
    }
    
    const userId = results[0].id;
    await collection.remove(userId);
    
    return { status: 201, message: "User deleted successfully." };
  } catch (error) {
    console.error("removeUser error:", error);
    throw error;
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
  companyIdentifier
) {
  try {
    if (
      !(email && password && first_name && mobile && last_name && username && companyIdentifier)
    ) {
      throw new Error("All input is required");
    }

    // Check if the count is exceeding the limit
    const tenant = await Tenants.getTenantByCompanyIdentifier(companyIdentifier);
    const allUsersResult = await getAllUser();
    const filteredUsers = allUsersResult.users.filter(
      (user) => user.companyIdentifier === companyIdentifier
    );

    if (
      tenant.Tenant.bothUserCount <=
      filteredUsers.filter((user) => user.access_type === "both").length
    ) {
      throw new Error(
        "Cannot add a new user, limit reached. Please contact system admin"
      );
    }

    if (appSecret !== process.env.APP_SECRET) {
      throw new Error(
        "Please contact administrator to register as an Admin"
      );
    }
    
    // Check if user already exists by email / username.
    // getUser / getUserbyUsername return null when nothing matches (they do
    // not throw), so test the result — the old try/throw pattern rejected
    // EVERY registration with "already exists".
    const existingByEmail = await getUser(email.toLowerCase());
    if (existingByEmail) {
      throw new Error("User with this email already exists. Please Login");
    }

    const existingByUsername = await getUserbyUsername(username);
    if (existingByUsername) {
      throw new Error("Username already exists. Please choose a different username");
    }

    const encryptedPassword = await bcrypt.hash(password, 10);

    // Create user in our database
    const result = await addAdmin({
      first_name,
      last_name,
      username,
      mobile,
      companyIdentifier,
      email: email.toLowerCase(),
      password: encryptedPassword,
    });

    const token = jwt.sign(
      { user_id: result.insertedId, email },
      process.env.TOKEN_KEY,
      {
        expiresIn: "30d",
      }
    );

    return {
      ...result,
      token: token,
    };
  } catch (error) {
    console.error("registerAdmin error:", error);
    throw error;
  }
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