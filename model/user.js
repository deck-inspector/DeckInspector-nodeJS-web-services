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

// CLIENT PORTAL (Oct 23 2026): a read-only login for an owner / property
// manager. role 'client' + clientId; access_type 'client' so it never counts
// against the tenant's inspector seats (the seat checks only count
// mobile / web / both). Password must already be hashed by the caller.
var addClientUser = async function (user) {
  try {
    const userId = `user_${uuidv4()}`;
    const userDoc = {
      username: user.username,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      email: user.email || "",
      mobile: user.mobile || "",
      password: user.password,
      role: Role.Client,
      clientId: user.clientId,
      access_type: "client",
      companyIdentifier: user.companyIdentifier,
      isActive: true,
      type: "User",
      createdBy: user.createdBy || "",
      createdAt: new Date().toISOString(),
    };
    // REPAIRS PORTAL (Oct 23 2026): a contractor login works for one client and
    // sees only the repair items of the properties assigned to it.
    if (user.role === Role.Contractor) {
      userDoc.role = Role.Contractor;
      userDoc.access_type = "contractor";
      userDoc.company = String(user.company || "").slice(0, 120);
      userDoc.contractorProjects = Array.isArray(user.contractorProjects) ? user.contractorProjects.map(String) : [];
    }
    // N1QL insert (query service) - same reason as the other Users writes.
    const q = `INSERT INTO \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users (KEY, VALUE) VALUES ($1, $2)`;
    await executeQuery(q, [userId, userDoc]);
    return { insertedId: userId, ok: 1 };
  } catch (error) {
    console.error("addClientUser error:", error);
    throw error;
  }
};

var getClientUsers = async function (companyIdentifier, clientId) {
  const query = `SELECT META(u).id as id, u.username, u.formerUsername, u.first_name, u.last_name, u.email, u.mobile,
      u.isActive, u.createdAt
    FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u
    WHERE u.\`role\` = 'client' AND u.companyIdentifier = $1 AND u.clientId = $2`;
  // ROLE is a reserved word in N1QL - it must be back-quoted (the unquoted form
  // failed live, Oct 23 2026). Sorted here rather than in the query.
  const rows = await executeQuery(query, [companyIdentifier, clientId]);
  return rows.sort((a, b) => String(a.username || "").toLowerCase().localeCompare(String(b.username || "").toLowerCase()));
};

// Contractor logins of one client (repairs portal).
var getContractors = async function (companyIdentifier, clientId) {
  const query = `SELECT META(u).id as id, u.username, u.formerUsername, u.first_name, u.last_name, u.email, u.mobile,
      u.company, u.contractorProjects, u.isActive, u.createdAt
    FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u
    WHERE u.\`role\` = 'contractor' AND u.companyIdentifier = $1 AND u.clientId = $2`;
  const rows = await executeQuery(query, [companyIdentifier, clientId]);
  return rows.sort((a, b) => String(a.username || "").toLowerCase().localeCompare(String(b.username || "").toLowerCase()));
};

var setContractorProjects = async function (userId, projectIds) {
  const query = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.contractorProjects = $2`;
  await executeQuery(query, [userId, (projectIds || []).map(String)]);
  return { ok: 1 };
};

// ---------------------------------------------------------------------------
// INACTIVE LOGINS FREE THEIR USERNAME + EMAIL (David, Oct 24 2026)
// Usernames and emails are unique across all of E3. When a login is turned off
// (anyone EXCEPT a company admin) its email is cleared and its username is
// renamed to a placeholder, so both can be used again by a new login. The record
// itself stays (history: who inspected / uploaded what) with `formerUsername`.
// Turning it back on restores the old username when it is still free; otherwise a
// new username must be given.
// ---------------------------------------------------------------------------
const USERS_KS = () => `\`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users`;
function isAdminRec(rec) { return !!(rec && String(rec.role || "").toLowerCase() === "admin"); }
// A turned-off, non-admin login whose username / email can be given away.
function isReleasable(rec) { return !!(rec && rec.isActive === false && !isAdminRec(rec)); }
function placeholderFor(username) {
  const base = String(username || "user").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "user";
  return `off-${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// Free the username + email of a login that is (being) turned off. No-op for admins.
var releaseIdentity = async function (rec) {
  if (!rec || isAdminRec(rec)) return { ok: 1, released: false };
  const id = rec.id || rec._id;
  if (String(rec.username || "").startsWith("off-") && !rec.email) return { ok: 1, released: false }; // already released
  const placeholder = placeholderFor(rec.username);
  const q = `UPDATE ${USERS_KS()} AS u USE KEYS $1
    SET u.formerUsername = IFMISSINGORNULL(u.formerUsername, u.username), u.username = $2,
        u.email = "", u.deviceId = "", u.isActive = false, u.releasedAt = $3`;
  await executeQuery(q, [id, placeholder, new Date().toISOString()]);
  return { ok: 1, released: true, username: placeholder };
};

// All logins (active or not) holding a username / email - case-insensitive.
async function holdersOfUsername(username) {
  return await executeQuery(`SELECT META(u).id as id, u.username, u.\`role\` AS role, u.isActive, u.email
    FROM ${USERS_KS()} u WHERE LOWER(u.username) = LOWER($1)`, [String(username || "")]);
}
async function holdersOfEmail(email) {
  if (!email) return [];
  return await executeQuery(`SELECT META(u).id as id, u.username, u.\`role\` AS role, u.isActive, u.email
    FROM ${USERS_KS()} u WHERE LOWER(u.email) = LOWER($1)`, [String(email)]);
}

// Is this username / email free for a NEW login? Turned-off non-admin logins that
// still hold it (older records) are released on the spot. Returns
// { ok: true } or { ok: false, field: 'username'|'email', message }.
var claimIdentity = async function (username, email, exceptId) {
  for (const r of await holdersOfUsername(username)) {
    if (exceptId && r.id === exceptId) continue;
    if (isReleasable(r)) { await releaseIdentity(r); continue; }
    return { ok: false, field: "username", message: `The username "${username}" is already used by an active login. Choose another username.` };
  }
  if (email) {
    for (const r of await holdersOfEmail(email)) {
      if (exceptId && r.id === exceptId) continue;
      if (isReleasable(r)) { await releaseIdentity(r); continue; }
      return { ok: false, field: "email", message: `The email "${email}" is already used by an active login. Use a different email, or leave the email blank.` };
    }
  }
  return { ok: true };
};

// Turn a login on or off. Off (non-admin) frees its username + email. On restores
// its former username when free, else needs `newUsername`.
// Returns { status, message, username? }.
var setActive = async function (rec, active, newUsername) {
  const id = rec.id || rec._id;
  if (!active) {
    await executeQuery(`UPDATE ${USERS_KS()} AS u USE KEYS $1 SET u.isActive = false`, [id]);
    if (!isAdminRec(rec)) await releaseIdentity(Object.assign({}, rec, { isActive: false }));
    return { status: 201, message: "User turned off." };
  }
  if (rec.isActive !== false) return { status: 201, message: "User is already active.", username: rec.username };
  let want = String(newUsername || "").trim();
  const wasPlaceholder = String(rec.username || "").startsWith("off-");
  if (!want) want = wasPlaceholder ? String(rec.formerUsername || "") : String(rec.username || "");
  if (!want) return { status: 409, needUsername: true, message: "Give this login a new username to turn it back on." };
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(want)) return { status: 400, needUsername: true, message: "Username: 3-60 letters, numbers, . _ - or @." };
  const free = await claimIdentity(want, "", id);
  if (!free.ok) {
    return { status: 409, needUsername: true, message: `The username "${want}" is now used by another login. Give this login a new username to turn it back on.` };
  }
  await executeQuery(`UPDATE ${USERS_KS()} AS u USE KEYS $1 SET u.isActive = true, u.username = $2, u.reactivatedAt = $3`, [id, want, new Date().toISOString()]);
  return { status: 201, message: "User turned on.", username: want };
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

// Reset a tenant user's password from the Multi-Tennant admin. Scoped to the
// tenant's companyIdentifier so one tenant can never touch another's users.
// Writes through the query service (KV has timed out against the data service).
var resetUserPassword = async function (username, companyIdentifier, newPassword) {
  try {
    if (!username || !newPassword) {
      throw new Error("username and password are required");
    }
    const query = `SELECT META(u).id as id, u.companyIdentifier FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u WHERE LOWER(u.username) = LOWER($1)`;
    const results = await executeQuery(query, [username]);
    if (results.length === 0) {
      const e = new Error("No user found with that username."); e.status = 404; throw e;
    }
    const match = results.find((r) => r.companyIdentifier === companyIdentifier) || null;
    if (!match) {
      const e = new Error("That user does not belong to this client."); e.status = 403; throw e;
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    const updateQuery = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.password = $2, u.passwordResetAt = $3`;
    await executeQuery(updateQuery, [match.id, hash, new Date().toISOString()]);
    return { ok: 1, id: match.id };
  } catch (error) {
    console.error("resetUserPassword error:", error);
    throw error;
  }
};

var getAllUser = async function () {
  try {
    // LIMIT raised 500 -> 5000 (Oct 23 2026): client portal logins live in the
    // same collection and must never push inspectors off the end of this list.
    const query = `SELECT META(u).id as id, u.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u LIMIT 5000`;
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
  addClientUser,
  getClientUsers,
  getContractors,
  setContractorProjects,
  releaseIdentity,
  claimIdentity,
  setActive,
  isReleasable,
  getUser: getUser,
  addAdmin: addAdmin,
  getAllUser: getAllUser,
  removeUser: removeUser,
  getUserbyUsername,
  getUserbyMobile,
  updateUser,
  registerAdmin,
  resetUserPassword,
  getSuperUserbyUsername,
  getSuperUser,
  addSuperUser,
  updateSession,
  clearSession,
  updateDevideId,
  updateUserStatus
};