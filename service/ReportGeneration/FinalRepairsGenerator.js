"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const docxTemplate = require("docx-templates");
const projectModel = require("../../model/project.js");
const subProjectModel = require("../../model/subproject.js");
const locationModel = require("../../model/location.js");
const sectionService = require("../sectionService.js");
const dynamicSectionDAO = require("../../model/dynamicSectionDAO.js");
const uploadBlob = require("../../database/uploadimage");
const { convertDocxToPdf } = require("../convertDocxToPdf.js");

// FINAL REPAIRS INSPECTION report (David, Aug 18, 2026).
// Re-inspection workflow: a completed project is put back on the schedule
// (finalinspection flag), inspectors record answers to the tenant's
// "Final Repairs Inspection" custom form on their phones (stored as
// DynamicVisualSection docs under each location), and this report ties it
// together: every location whose ORIGINAL inspection had a BAD section
// (visual review = Bad, or further invasive review required) is listed with
// its original findings, photos, and the repairs-inspection answers.
//
// Standalone generator on purpose - the Visual/Invasive pipeline threads
// reportType through five generator layers; this report has its own shape
// and its own template (Deck_FinalRepairsTemplate.docx, repo root, default
// +++ docx-templates syntax).
class FinalRepairsGenerator {

  isBadSection(s) {
    if (!s) return false;
    const v = String(s.visualreview || "").toLowerCase();
    const inv = s.furtherinvasivereviewrequired;
    const invYes = inv === true || /^(yes|true)$/i.test(String(inv || ""));
    return v.startsWith("bad") || invYes;
  }

  stripHtml(s) {
    return String(s || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  sectionComments(s) {
    const parts = [];
    const cond = this.stripHtml(s.conditionalassessment);
    const add = this.stripHtml(s.additionalconsiderations || s.additionalconsiderationshtml);
    if (cond) parts.push("Condition Assessment: " + cond);
    if (add) parts.push("Additional Considerations: " + add);
    return parts.join("\n");
  }

  sectionFlags(s) {
    const flags = [];
    const inv = s.furtherinvasivereviewrequired;
    if (inv === true || /^(yes|true)$/i.test(String(inv || ""))) flags.push("Invasive review required");
    if (/^yes$/i.test(String(s.visualsignsofleak || ""))) flags.push("Signs of leaks");
    return flags.length ? "(" + flags.join("; ") + ")" : "";
  }

  // Repairs answers recorded for a location = its DynamicVisualSection docs
  // (one per filled form). Flatten every answered question into {q, a} rows,
  // and collect the photos taken during the repairs inspection.
  async repairFindings(locationId) {
    let dyn = [];
    try { dyn = await dynamicSectionDAO.getSectionByParentId(locationId) || []; }
    catch (e) { /* no repairs record yet - the template says so */ }
    const answers = [];
    const repairPhotos = [];
    for (const d of dyn) {
      for (const q of (d.questions || [])) {
        const a = Array.isArray(q.multipleAnswers) && q.multipleAnswers.length
          ? q.multipleAnswers.join("; ")
          : (q.answer || "");
        if (String(a).trim()) answers.push({ q: q.name || "Question", a: String(a).trim() });
      }
      for (const url of (d.images || [])) if (url) repairPhotos.push({ url });
    }
    return { answers, repairPhotos };
  }

  // Every location in the project (building units + common locations), with
  // the building name folded into the display title.
  async allLocations(projectId) {
    const out = [];
    const subs = await subProjectModel.getSubProjectsByParentId(projectId).catch(() => null);
    const subItems = (subs && subs.data && subs.data.item) || [];
    for (const sp of subItems) {
      const kids = await locationModel.getLocationByParentId(sp.id || sp._id).catch(() => null);
      for (const loc of ((kids && kids.data && kids.data.item) || [])) {
        out.push({ id: loc.id || loc._id, title: `${sp.name} — ${loc.name}` });
      }
    }
    const locs = await locationModel.getLocationByParentId(projectId).catch(() => null);
    for (const loc of ((locs && locs.data && locs.data.item) || [])) {
      out.push({ id: loc.id || loc._id, title: String(loc.name || "") });
    }
    return out;
  }

  async buildData(projectId) {
    const pRes = await projectModel.getProjectById(projectId);
    const proj = (pRes && (pRes.project || (pRes.data && pRes.data.item))) || {};
    const locations = [];
    const all = await this.allLocations(projectId);
    for (const loc of all) {
      const secRes = await sectionService.getSectionsByParentId(loc.id).catch(() => null);
      const sections = (secRes && secRes.sections) || [];
      const bad = sections.filter((s) => this.isBadSection(s));
      if (!bad.length) continue;
      const { answers, repairPhotos } = await this.repairFindings(loc.id);
      locations.push({
        title: "Location: " + loc.title,
        badSections: bad.map((s) => ({
          name: s.name || "Inspection point",
          visualreview: s.visualreview || "—",
          flags: this.sectionFlags(s),
          comments: this.sectionComments(s),
          photo: (s.images && s.images[0]) || "",
        })),
        answers,
        repairPhotos,
      });
    }
    const assigned = Array.isArray(proj.assignedto) ? proj.assignedto.filter(Boolean).join(", ") : (proj.assignedto || "");
    const inspDate = proj.editedat ? new Date(proj.editedat).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "America/Los_Angeles" }) : "not set";
    return {
      project: {
        name: proj.name || "",
        address: proj.address || "",
        inspectionDate: inspDate,
        inspectors: assigned || "—",
        originalInspector: proj.createdby || "—",
        badLocationCount: String(locations.length),
        totalLocationCount: String(all.length),
      },
      locations,
    };
  }

  async fetchImage(url) {
    try {
      const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
      const ext = (url.split("?")[0].match(/\.(png|jpe?g|gif)$/i) || [])[1] || "jpg";
      return {
        width: 12, height: 9, // cm
        data: Buffer.from(resp.data),
        extension: "." + ext.toLowerCase().replace("jpeg", "jpg"),
      };
    } catch (e) {
      console.log("FinalRepairs: image fetch failed", url, e.message);
      return null; // template renders nothing for a missing photo
    }
  }

  // Returns the blob URL of the generated report. Throws on failure so the
  // /generatereport route records its normal FAILED entry.
  async generate(projectId, companyName, projectName, uploader, reportFormat) {
    const data = await this.buildData(projectId);
    const template = fs.readFileSync(path.join(__dirname, "..", "..", "Deck_FinalRepairsTemplate.docx"));
    const buffer = await docxTemplate.createReport({
      template,
      data,
      additionalJsContext: {
        img: async (url) => (url ? await this.fetchImage(url) : null),
      },
    });

    let outBuffer = Buffer.from(buffer);
    let ext = "docx";
    if (reportFormat === "pdf") {
      try {
        outBuffer = await convertDocxToPdf(outBuffer, "finalrepairs.docx");
        ext = "pdf";
      } catch (e) {
        console.log("FinalRepairs: pdf conversion failed, uploading Word instead:", e.message);
      }
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const fileName = `${projectId}_FinalRepairs_${stamp}.${ext}`;
    const tmpPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmpPath, outBuffer);
    try {
      const result = await uploadBlob.uploadFile("projectreports", fileName, tmpPath, {
        metadata: { uploader: String(uploader || "system") },
        tags: { id: String(projectId), reportType: "FinalRepairs" },
      });
      const parsed = JSON.parse(result);
      if (!parsed || !parsed.url) throw new Error("upload returned no url");
      return parsed.url;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* temp cleanup only */ }
    }
  }
}

module.exports = new FinalRepairsGenerator();
