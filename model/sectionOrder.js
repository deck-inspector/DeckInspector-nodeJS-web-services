"use strict";

/**
 * Shared ordering helpers for section lists.
 *
 * Two places hold section order and they must agree:
 *   1. the parent document's `sections` array  - the report generator walks it
 *      in array order, so array order IS report order;
 *   2. the `sequenceNo` field on each section document - what the
 *      /section/getSectionsByParentId list is sorted by, i.e. screen order.
 *
 * Both are written by sectionService.reorderSections using the helpers here.
 */

// Match a stored child entry against an id, tolerating the several id shapes
// this data has accumulated (_id from the Mongo era, id from Couchbase).
function childId(child) {
  if (!child) return "";
  return String(child.id || child._id || "");
}

/**
 * Reorder `children` so they follow `orderedIds`.
 * Anything not named in orderedIds keeps its existing relative order and is
 * appended after the ordered items - a stale or partial client list can never
 * drop a section. Each returned entry gets sequenceNo set to its new index.
 */
function orderSectionsByIds(children, orderedIds) {
  const list = Array.isArray(children) ? children.slice() : [];
  const wanted = (Array.isArray(orderedIds) ? orderedIds : []).map(String);

  const byId = new Map();
  for (const child of list) {
    const key = childId(child);
    if (key && !byId.has(key)) byId.set(key, child);
  }

  const ordered = [];
  const taken = new Set();
  for (const id of wanted) {
    const child = byId.get(String(id));
    if (child && !taken.has(childId(child))) {
      ordered.push(child);
      taken.add(childId(child));
    }
  }
  for (const child of list) {
    if (!taken.has(childId(child))) {
      ordered.push(child);
      taken.add(childId(child));
    }
  }

  return ordered.map((child, index) =>
    Object.assign({}, child, { sequenceNo: index })
  );
}

/**
 * Sort a fetched section list for display. Sections that carry a numeric
 * sequenceNo come first in that order; sections that have never been reordered
 * (no sequenceNo yet) keep their original relative order at the end. Node's
 * sort is stable, so untouched lists come back exactly as the query returned
 * them - this is a no-op until someone actually reorders something.
 */
function sortSectionsBySequence(sections) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  const rank = (section) => {
    const raw = section && section.sequenceNo;
    if (raw === undefined || raw === null || raw === "") return Number.MAX_SAFE_INTEGER;
    const num = Number(raw);
    return Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER;
  };
  return list.sort((a, b) => rank(a) - rank(b));
}

module.exports = { childId, orderSectionsByIds, sortSectionsBySequence };
