"use strict";
const subProjectModel = require("../model/subproject.js");
const locationModel = require("../model/location.js");
const LocationDAO = require("../model/locationDAO.js");
const locationService = require("./locationService.js");
const sectionService = require("./sectionService.js");
const dynamicSectionService = require("./dynamicSectionService.js");
const dynamicSectionDAO = require("../model/dynamicSectionDAO.js");
const locationFormService = require("./locationFormService.js");
const projectModel = require("../model/project.js");

// FINAL INSPECTION AFTER REPAIRS - phone preparation (David, Aug 18, 2026).
// The mobile app shows whatever documents sync to it. Scheduling a Final
// Inspection therefore prepares the data so inspectors see the right things
// on their phones with NO app changes:
//   * every BAD unit (any section with Visual Review "Bad" or invasive
//     review required) gets a red-dot marker on its NAME and its description
//     is replaced by the list of original findings;
//   * a ready-to-fill "REPAIRS - <unit>" record (DynamicVisualSection built
//     from the project's repairs form) is pre-created inside each BAD unit,
//     so tapping it on the phone opens the repair questions directly.
// cleanup() restores names/descriptions when the project is completed or the
// Final Inspection is cancelled. The filled repair records are kept - they
// are the evidence the Final Repairs report prints.
const MARK = "\u{1F534} "; // red circle emoji + space

function isBadSection(s) {
  if (!s) return false;
  const v = String(s.visualreview || "").toLowerCase();
  const inv = s.furtherinvasivereviewrequired;
  const invYes = inv === true || /^(yes|true)$/i.test(String(inv || ""));
  return v.startsWith("bad") || invYes;
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function findingsSummary(badSections) {
  const lines = badSections.map((s) => {
    const flags = [];
    if (String(s.visualreview || "").toLowerCase().startsWith("bad")) flags.push("Visual: Bad");
    const inv = s.furtherinvasivereviewrequired;
    if (inv === true || /^(yes|true)$/i.test(String(inv || ""))) flags.push("invasive review required");
    if (/^yes$/i.test(String(s.visualsignsofleak || ""))) flags.push("leaks");
    const cond = stripHtml(s.conditionalassessment).slice(0, 120);
    return "- " + (s.name || "Inspection point") + ": " + flags.join(", ") + (cond ? " | " + cond : "");
  });
  return "FINAL REPAIRS NEEDED - original findings:\n" + lines.join("\n");
}

async function allLocations(projectId) {
  const out = [];
  const subs = await subProjectModel.getSubProjectsByParentId(projectId).catch(() => null);
  for (const sp of ((subs && subs.data && subs.data.item) || [])) {
    const kids = await locationModel.getLocationByParentId(sp.id || sp._id).catch(() => null);
    for (const loc of ((kids && kids.data && kids.data.item) || [])) out.push(loc.id || loc._id);
  }
  const locs = await locationModel.getLocationByParentId(projectId).catch(() => null);
  for (const loc of ((locs && locs.data && locs.data.item) || [])) out.push(loc.id || loc._id);
  return out;
}

async function prepare(projectId, username) {
  const debug = { locCount: 0, secCounts: [], formErr: '', projFormId: '' };
  const pRes = await projectModel.getProjectById(projectId).catch((e) => ({ err: String(e && e.message || e) }));
  const proj = (pRes && (pRes.project || (pRes.data && pRes.data.item))) || {};
  debug.projFormId = proj.formId || ('MISSING:' + JSON.stringify(Object.keys(pRes || {})));
  let form = null;
  if (proj.formId) {
    const fRes = await locationFormService.getLocationFormById(proj.formId).catch((e) => ({ ferr: String(e && e.message || e) }));
    form = (fRes && (fRes.location || fRes.form)) || null;
    if (!form) debug.formErr = JSON.stringify(fRes).slice(0, 160);
  }
  const now = new Date().toISOString();
  const marked = [];
  const locIds = await allLocations(projectId);
  debug.locCount = locIds.length;
  for (const locId of locIds) {
    const secRes = await sectionService.getSectionsByParentId(locId).catch(() => null);
    const secs = (secRes && secRes.sections) || [];
    const bad = secs.filter(isBadSection);
    if (debug.secCounts.length < 14) debug.secCounts.push(String(locId).slice(0, 6) + ':' + secs.length + '/' + bad.length);
    if (!bad.length) continue;

    const doc = await LocationDAO.getLocationById(locId).catch(() => null);
    if (!doc) continue;
    const origName = doc.frOrigName !== undefined && doc.frOrigName !== null
      ? doc.frOrigName
      : String(doc.name || "").replace(MARK, "");

    const updates = { description: findingsSummary(bad) };
    if (!String(doc.name || "").startsWith(MARK)) {
      updates.frOrigName = doc.name || "";
      updates.name = MARK + (doc.name || "");
    }
    if (doc.frOrigDesc === undefined || doc.frOrigDesc === null) {
      updates.frOrigDesc = doc.description || "";
    }
    await locationService.editLocation(locId, updates);

    // Pre-create the ready-to-fill repairs record (idempotent by name).
    const existing = await dynamicSectionDAO.getSectionByParentId(locId).catch(() => []);
    const already = (existing || []).some((d) => /^repairs\b/i.test(String(d.name || "")));
    if (!already && form && Array.isArray(form.questions) && form.questions.length) {
      const questions = form.questions.map((q) => ({
        ...q,
        answer: q.answer || "",
        multipleAnswers: Array.isArray(q.multipleAnswers) ? q.multipleAnswers : [],
      }));
      await dynamicSectionService.addSection({
        additionalconsiderations: "",
        additionalconsiderationshtml: "",
        createdat: now,
        createdby: username || "system",
        editedat: now,
        lasteditedby: username || "system",
        furtherinvasivereviewrequired: false,
        name: "REPAIRS - " + origName,
        parentid: locId,
        parenttype: "projectlocation",
        images: [],
        questions,
        unitUnavailable: false,
        companyIdentifier: proj.companyIdentifier || doc.companyIdentifier || "",
      });
    }
    marked.push(origName);
  }
  return { success: true, marked, repairsForm: !!form, debug };
}

async function cleanup(projectId) {
  const restored = [];
  for (const locId of await allLocations(projectId)) {
    const doc = await LocationDAO.getLocationById(locId).catch(() => null);
    if (!doc) continue;
    const hasName = doc.frOrigName !== undefined && doc.frOrigName !== null;
    const hasDesc = doc.frOrigDesc !== undefined && doc.frOrigDesc !== null;
    if (!hasName && !hasDesc) continue;
    await locationService.editLocation(locId, {
      name: hasName ? doc.frOrigName : doc.name,
      description: hasDesc ? doc.frOrigDesc : doc.description,
      frOrigName: null,
      frOrigDesc: null,
    });
    restored.push(hasName ? doc.frOrigName : doc.name);
  }
  return { success: true, restored };
}

module.exports = { prepare, cleanup, isBadSection, findingsSummary, MARK };
