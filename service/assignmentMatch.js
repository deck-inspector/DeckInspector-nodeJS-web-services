"use strict";

/**
 * Server-side port of the webapp's assignee matching (matchesUser / isMe),
 * added Aug 17 for inspector-scoped project visibility: non-admin users see
 * only projects assigned to them, INCLUDING legacy shorthand assignment tags
 * ("Gabe" for Gabriel, "dmazor" for Dmazor) that never exactly equalled a
 * username. Keep this logic IDENTICAL to webapp/index.html matchesUser/isMe -
 * the acceptance-click feature uses the same rules client-side, and the two
 * must agree about whose project is whose.
 */

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

// Does this assignment tag plausibly refer to this user record?
function matchesUser(tag, rec) {
  if (!tag || !rec) return false;
  const t = norm(tag);
  if (!t) return false;
  const fn = norm(rec.first_name);
  const ln = norm(rec.last_name);
  const un = norm(rec.username);
  const cands = [un, fn, fn + ln, fn.charAt(0) + ln, fn.charAt(0) + ln.charAt(0)]
    .filter((c) => c && c.length > 1);
  for (const c of cands) {
    if (t === c) return true;
    if (t.length >= 4 && (c.indexOf(t) === 0 || t.indexOf(c) === 0)) return true;
    // nickname tolerance: "Gabe" -> "Gabriel" (common prefix >=3 with at most
    // one divergent trailing char). The uniqueness guard blocks collisions.
    if (t.length >= 3 && c.length >= 3) {
      let cp = 0;
      while (cp < t.length && cp < c.length && t.charAt(cp) === c.charAt(cp)) cp++;
      if (cp >= 3 && cp >= t.length - 1) return true;
    }
  }
  return false;
}

// Is this assignment tag MINE? (me = my user record; others = every other
// user record in the tenant.) Same guards as the webapp's isMe():
// exact username always wins; someone else's exact username is never mine;
// an ambiguous tag that could be several people belongs to nobody.
function tagIsUsers(tag, me, others) {
  if (!me || !tag) return false;
  const t = norm(tag);
  if (t === norm(me.username)) return true;
  const rest = (others || []).filter((o) => o && o.username !== me.username);
  if (rest.some((o) => norm(o.username) === t)) return false;
  if (!matchesUser(tag, me)) return false;
  return !rest.some((o) => matchesUser(tag, o));
}

// The project's assignment tags, whatever shape assignedto is in.
function assignedTags(project) {
  const a = project && project.assignedto;
  if (Array.isArray(a)) return a.filter(Boolean);
  return a ? [a] : [];
}

// Is this project visible to this (non-admin) user?
function projectAssignedToUser(project, me, others) {
  return assignedTags(project).some((tag) => tagIsUsers(tag, me, others));
}

module.exports = { matchesUser, tagIsUsers, assignedTags, projectAssignedToUser, norm };
