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
// SPEED (David, Aug 23: Northridge, 110 units, "takes a few minutes to
// load"): every per-location lookup below used to run ONE AT A TIME - the
// report waited through a full database round-trip per unit, in sequence.
// pmap runs them in parallel batches of 8: fast, without swamping Couchbase.
async function pmap(items, fn, limit = 8) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

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
    const repairs = [];
    // One location can carry several repairs forms - ONE PER REPAIRED AREA
    // (front deck, rear deck, ...). Keep each as its OWN block so the report
    // identifies every area with its own answers and its own photos (David,
    // Aug 23: "If there are two locations needing repair, each must be
    // identified and each have photos"). Drop only TRUE re-submissions: a
    // form is a duplicate only when every question AND answer AND photo
    // matches one already recorded - two areas with identical answers but
    // different photos are different areas and must BOTH print (this was the
    // Aug 22 dedupe's blind spot: it compared answers alone and silently
    // dropped Location 3's second deck).
    const seenForms = new Set();
    for (const d of dyn) {
      const block = [];
      for (const q of (d.questions || [])) {
        const a = Array.isArray(q.multipleAnswers) && q.multipleAnswers.length
          ? q.multipleAnswers.join("; ")
          : (q.answer || "");
        if (String(a).trim()) block.push({ q: q.name || "Question", a: String(a).trim() });
      }
      const photos = [];
      const seenPhotos = new Set();
      for (const url of (d.images || [])) {
        if (!url || seenPhotos.has(url)) continue;
        seenPhotos.add(url);
        photos.push({ url });
      }
      if (!block.length && !photos.length) continue;   // untouched pre-created form
      const fingerprint = block.map((x) => x.q + "=" + x.a).join("|")
        + "||" + photos.map((p) => p.url).join(",");
      if (seenForms.has(fingerprint)) {
        console.log("FinalRepairs: skipped a true duplicate repairs form (same answers AND photos)");
        continue;
      }
      seenForms.add(fingerprint);
      // The area's identity: what the inspector answered for "location in
      // need of repair", else the form's own name (minus the REPAIRS prefix).
      const areaAns = block.find((x) => /location in need of repair/i.test(x.q));
      const name = (areaAns && areaAns.a)
        || String(d.name || "").replace(/^REPAIRS\s*-\s*/i, "").trim()
        || ("Area " + (repairs.length + 1));
      repairs.push({ name, answers: block, photos });
      for (const x of block) answers.push(x);
      for (const p of photos) repairPhotos.push(p);
    }
    return { answers, repairPhotos, repairs };
  }

  // Every location in the project (building units + common locations), with
  // the building name folded into the display title. The red-dot Final
  // Inspection marker (finalInspectionService.MARK) is stripped so the report
  // reads clean; frOrigName is the authoritative pre-marking name.
  cleanName(loc) {
    if (loc.frOrigName !== undefined && loc.frOrigName !== null && loc.frOrigName !== "") return String(loc.frOrigName);
    return String(loc.name || "").replace(/\u{1F534}\s*/gu, "");
  }

  async allLocations(projectId) {
    const out = [];
    const subs = await subProjectModel.getSubProjectsByParentId(projectId).catch(() => null);
    const subItems = (subs && subs.data && subs.data.item) || [];
    const kidsList = await pmap(subItems, (sp) => locationModel.getLocationByParentId(sp.id || sp._id).catch(() => null));
    subItems.forEach((sp, si) => {
      const kids = kidsList[si];
      for (const loc of ((kids && kids.data && kids.data.item) || [])) {
        out.push({ id: loc.id || loc._id, title: `${sp.name} — ${this.cleanName(loc)}`, meta: loc.sections || [], cover: loc.url || "" });
      }
    });
    const locs = await locationModel.getLocationByParentId(projectId).catch(() => null);
    for (const loc of ((locs && locs.data && locs.data.item) || [])) {
      out.push({ id: loc.id || loc._id, title: this.cleanName(loc), meta: loc.sections || [], cover: loc.url || "" });
    }
    return out;
  }

  // A unit is BAD if the section DOC says so OR the location's embedded
  // section-summary metadata says so (legacy data disagrees sometimes - the
  // web tree follows the metadata, so the report must too).
  mergedBadSections(sectionDocs, metaEntries) {
    const bad = (sectionDocs || []).filter((s) => this.isBadSection(s));
    const names = new Set(bad.map((s) => String(s.name || "").toLowerCase()));
    for (const m of (metaEntries || [])) {
      if (!m || !this.isBadSection(m)) continue;
      if (names.has(String(m.name || "").toLowerCase())) continue;
      bad.push({
        name: m.name,
        visualreview: m.visualreview,
        furtherinvasivereviewrequired: m.furtherinvasivereviewrequired,
        visualsignsofleak: m.visualsignsofleak,
        conditionalassessment: m.conditionalassessment,
        images: m.coverUrl ? [m.coverUrl] : [],
      });
    }
    return bad;
  }

  async buildData(projectId) {
    const pRes = await projectModel.getProjectById(projectId);
    const proj = (pRes && (pRes.project || (pRes.data && pRes.data.item))) || {};
    const locations = [];
    const all = await this.allLocations(projectId);
    const perLoc = await pmap(all, async (loc) => {
      const secRes = await sectionService.getSectionsByParentId(loc.id).catch(() => null);
      const sections = (secRes && secRes.sections) || [];
      const bad = this.mergedBadSections(sections, loc.meta);
      if (!bad.length) return null;
      const rf = await this.repairFindings(loc.id);
      return { loc, bad, rf };
    });
    for (const hit of perLoc) {
      if (!hit) continue;
      const { loc, bad } = hit;
      const { answers, repairPhotos } = hit.rf;
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
      const buf = Buffer.from(resp.data);
      // Word rejects the WHOLE document ("unreadable content") when an image
      // part's bytes do not match its declared type - phone uploads routinely
      // carry .jpg names over HEIC/PNG bytes. Trust the BYTES, never the URL.
      let ext = null;
      if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) ext = ".jpg";
      else if (buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = ".png";
      else if (buf.length > 2 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ext = ".gif";
      if (!ext) {
        console.log("FinalRepairs: skipping photo with unsupported bytes (not jpeg/png/gif):", url.slice(-60));
        return null; // template renders nothing for this photo
      }
      return {
        width: 12, height: 9, // cm
        data: buf,
        extension: ext,
      };
    } catch (e) {
      console.log("FinalRepairs: image fetch failed", url, e.message);
      return null; // template renders nothing for a missing photo
    }
  }

  // ------------------------------------------------------------------
  // INTEGRATED FINAL REPORT (David, Aug 19-21 2026): Final-Inspection
  // projects generate from the admin-managed MASTER
  // Deck_FinalRepairsMaster.docx ("Master Final Inspection Upon Completion
  // of Repairs" - uploaded per-version in the E3 Multi-Tennant Dashboard,
  // one master for ALL clients). The route fills the master's form controls
  // from the web form, then hands the filled buffer here:
  //   * the annex loop renders one navy-barred page-set per BAD location -
  //     original findings (red) with all original photos boxed 4-per-row,
  //     the phone-recorded repair answers, a big PASS/FAIL verdict - with
  //     the LOCATION NUMBER carried in both section headers;
  //   * unrepaired locations print RED ("REPAIRS NOT COMPLETED") and the
  //     completed-Yes answer prints green - the master's own fonts, sizes
  //     and colors are otherwise preserved verbatim;
  //   * the confirmation checklist is REAL editable checkbox controls
  //     (tags conf_<item>_yes/no) whose states are set from the recorded
  //     answers, and the confirmation signs with the report's own filled
  //     signature block (cloned over SIG_BLOCK_MARKER).
  // Branding is NOT done here - the route's brandClientFormVerbatim stamps
  // each tenant's own Multi-Tennant Report Header/Footer afterwards, so
  // every client keeps their own brand automatically.
  // ------------------------------------------------------------------

  chunk4(arr) {
    // Cap at 8 photos per section - more than that overflows the page
    // (David, Aug 22: "We will cap a maximum of 8 images per section").
    const capped = arr.slice(0, 8);
    if (arr.length > capped.length) {
      console.log("FinalRepairs: photo cap - rendering 8 of " + arr.length + " photos");
    }
    const out = [];
    for (let i = 0; i < capped.length; i += 4) out.push({ ph: capped.slice(i, i + 4) });
    return out;
  }

  // PASS when the "Have the repairs been completed" answer starts with Yes,
  // FAIL when it starts with No, PENDING when nothing is recorded yet.
  verdictFor(answers) {
    for (const a of (answers || [])) {
      if (/repairs? been completed/i.test(a.q) || /^(yes|no)\b/i.test(a.a)) {
        if (/^yes/i.test(a.a)) return "PASS";
        if (/^no/i.test(a.a)) return "FAIL";
      }
    }
    return "PENDING";
  }

  // Underwriter checklist: a category is checked "Repairs Completed - YES"
  // when any unit's repair answers mention it; otherwise "No Repairs
  // Required" is checked. Returns booleans keyed by checklist item.
  confBoxes(allAnswerText) {
    const cats = {
      waterproofing: /waterproof|coating|membrane|flashing/i,
      leaks: /leak|water intrusion/i,
      rot: /rot|deteriorat/i,
      substrate: /substrate|soft\b|plywood|sheathing/i,
      railings: /railing|guard/i,
      loadbearing: /joist|load.?bearing|stair|assembl|beam|post|structural/i,
    };
    const out = {};
    for (const key of Object.keys(cats)) out[key] = cats[key].test(allAnswerText);
    return out;
  }

  // Auto-built "Additional Comments" narrative, matching the corrected
  // sample's wording (David, Aug 22): one sentence per location - what was
  // repaired, the issues, and whether repairs passed - so the comments box
  // is never a mostly-empty gap.
  narrativeFor(locations, inspDate) {
    const parts = ["Final Repairs Inspection performed " + inspDate + " (on-site visual review)."];
    for (const l of (locations || [])) {
      const find = (re) => {
        const hit = (l.answers || []).find((a) => re.test(a.q));
        return hit ? String(hit.a).trim() : "";
      };
      let area = find(/location in need of repair/i)
        || (l.badSections || []).map((s) => s.name).filter(Boolean).join(", ")
        || "identified areas";
      area = (area.charAt(0).toLowerCase() + area.slice(1)).replace(/\s*;\s*/g, ", ");
      const issues = find(/issues? in need of repair/i).replace(/\s*;\s*/g, ", ");
      const scope = area + " repairs" + (issues ? " (" + issues + ")" : "");
      if (l.passText === "PASS") {
        parts.push(l.num + ": " + scope + " completed and visually appear safe and operational.");
      } else if (l.passText === "FAIL") {
        parts.push(l.num + ": " + scope + " NOT completed - damage is visually observed; repairs remain necessary.");
      } else {
        parts.push(l.num + ": " + scope + " - repair inspection pending.");
      }
    }
    parts.push("Original inspection performed by Deck Inspectors.");
    return parts.join(" ");
  }

  async annexData(projectId) {
    const pRes = await projectModel.getProjectById(projectId);
    const proj = (pRes && (pRes.project || (pRes.data && pRes.data.item))) || {};
    const locations = [];
    let anyRepairsRecord = false;
    const all = await this.allLocations(projectId);
    const perLoc = await pmap(all, async (loc) => {
      const secRes = await sectionService.getSectionsByParentId(loc.id).catch(() => null);
      const sections = (secRes && secRes.sections) || [];
      const bad = this.mergedBadSections(sections, loc.meta);
      if (!bad.length) return null;
      const rf = await this.repairFindings(loc.id);
      return { loc, bad, rf };
    });
    for (const hit of perLoc) {
      if (!hit) continue;
      const { loc, bad } = hit;
      const { answers, repairPhotos, repairs } = hit.rf;
      if (answers.length || repairPhotos.length) anyRepairsRecord = true;
      const passText = this.verdictFor(answers);
      locations.push({
        num: loc.title,
        // APARTMENT PHOTO (David, Aug 23): the unit's own cover photo prints
        // under the Location bar. Blank when none is synced - the template
        // renders nothing rather than an empty box.
        photo: /^https?:\/\//i.test(String(loc.cover || "")) ? loc.cover : "",
        badSections: bad.map((s) => ({
          name: s.name || "Inspection point",
          visualreview: s.visualreview || "—",
          flags: this.sectionFlags(s),
          cond: this.stripHtml(s.conditionalassessment) || "—",
          add: this.stripHtml(s.additionalconsiderations || s.additionalconsiderationshtml),
          photoRows: this.chunk4((s.images || []).filter(Boolean).map((u) => ({ f: u }))),
        })),
        answers,
        repairPhotoRows: this.chunk4(repairPhotos.map((p) => ({ f: p.url }))),
        // One block PER REPAIRED AREA - the new master iterates these so each
        // area prints with its own identity, answers, and photos. `showName`
        // avoids a redundant header when there is only one area.
        repairs: (repairs || []).map((r, i) => ({
          idx: i + 1,
          name: r.name,
          showName: (repairs.length > 1) ? ("REPAIR " + (i + 1) + " OF " + repairs.length + " — " + r.name) : "",
          answers: r.answers,
          photoRows: this.chunk4(r.photos.map((p) => ({ f: p.url }))),
        })),
        passText,
        repairsHeader: passText === "PASS" ? "REPAIRS COMPLETED"
          : (passText === "FAIL" ? "REPAIRS NOT COMPLETED" : "REPAIRS INSPECTION PENDING"),
      });
    }
    const allText = locations.map((l) => l.answers.map((a) => a.a).join("; ")).join("; ");
    const allPass = locations.length > 0 && locations.every((l) => l.passText === "PASS");
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
    const inspDate = proj.editedat
      ? new Date(proj.editedat).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })
      : today;
    return {
      hadFinalInspection: !!(proj.finalinspection || proj.prevFormId !== undefined || anyRepairsRecord),
      confBoxes: this.confBoxes(allText),
      data: {
        project: { name: proj.name || "", inspectionDate: inspDate },
        locations,
        conf: {
          statement: allPass
            ? "An Onsite Post-Repair Inspection has been completed by a qualified inspector. All locations previously identified in the Visual Report have been inspected, and all areas requiring repair have been repaired."
            : "An Onsite Post-Repair Inspection has been completed by a qualified inspector. All locations previously identified in the Visual Report have been inspected. Repairs remain outstanding at the location(s) marked FAIL in this annex.",
          date: today,
          narrative: this.narrativeFor(locations, inspDate),
        },
      },
    };
  }

  // ---- defensive hardening (David, Aug 21: Word "unreadable content") ----
  // An admin-uploaded master can arrive with defects Word refuses: duplicate
  // content-control ids (Word hard-fails), or a zip written by ordinary tools
  // (directory entries / [Content_Types].xml not first - Word's OPC reader
  // rejects both). These run on every generation so a bad upload can never
  // corrupt client reports again.
  dedupeControlIds(buf) {
    const PizZip = require("pizzip");
    const zip = new PizZip(buf);
    let xml = zip.file("word/document.xml").asText();
    const seen = new Set();
    let removed = 0;
    xml = xml.replace(/<w:id w:val="(-?\d+)"\/>/g, (m, id) => {
      if (seen.has(id)) { removed++; return ""; }
      seen.add(id);
      return m;
    });
    if (!removed) return buf;
    console.log("FinalRepairs: removed", removed, "duplicate control ids from the master");
    zip.file("word/document.xml", xml);
    return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  }

  normalizePackage(buf) {
    const PizZip = require("pizzip");
    const zin = new PizZip(buf);
    const names = Object.keys(zin.files).filter((n) => !zin.files[n].dir);
    const order = ["[Content_Types].xml", "_rels/.rels"];
    const sorted = order.filter((n) => names.indexOf(n) !== -1)
      .concat(names.filter((n) => order.indexOf(n) === -1));
    const zout = new PizZip();
    for (const n of sorted) zout.file(n, zin.file(n).asUint8Array());
    return zout.generate({ type: "nodebuffer", compression: "DEFLATE" });
  }

  // Set an editable checkbox content control (by its w:tag) checked/unchecked.
  setCheckbox(xml, tag, checked) {
    const ti = xml.indexOf('<w:tag w:val="' + tag + '"/>');
    if (ti === -1) return xml;
    const sS = xml.lastIndexOf("<w:sdt>", ti);
    const sE = xml.indexOf("</w:sdt>", ti) + "</w:sdt>".length;
    let seg = xml.slice(sS, sE);
    seg = seg.replace(/<w14:checked w14:val="[01]"\/>/, '<w14:checked w14:val="' + (checked ? "1" : "0") + '"/>');
    seg = seg.replace(/<w:t>[☒☐]<\/w:t>/, "<w:t>" + (checked ? "☒" : "☐") + "</w:t>");
    return xml.slice(0, sS) + seg + xml.slice(sE);
  }

  // Photo boxes + David's color rules. The master prints the repairs header
  // and verdict GREEN; here FAIL/NOT-COMPLETED turn red, PENDING amber, and
  // the completed-Yes answer line turns green.
  applyAnnexColors(xml) {
    xml = xml.replace(/<a:ln>\s*<a:noFill\/>\s*<\/a:ln>/g,
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="404040"/></a:solidFill></a:ln>');
    return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (seg) => {
      if (seg.indexOf("REPAIRS NOT COMPLETED") !== -1 && seg.indexOf("LOCATION") !== -1)
        return seg.split('<w:color w:val="00B050"/>').join('<w:color w:val="EE0000"/>');
      if (seg.indexOf("REPAIRS INSPECTION PENDING") !== -1 && seg.indexOf("LOCATION") !== -1)
        return seg.split('<w:color w:val="00B050"/>').join('<w:color w:val="E68A00"/>');
      if (seg.indexOf("REPAIR INSPECTION RESULT") !== -1) {
        if (seg.indexOf("FAIL") !== -1) return seg.split('<w:color w:val="00B050"/>').join('<w:color w:val="EE0000"/>');
        if (seg.indexOf("PENDING") !== -1) return seg.split('<w:color w:val="00B050"/>').join('<w:color w:val="E68A00"/>');
        return seg;
      }
      if (seg.indexOf("Have the repairs been completed") !== -1 && /:\s+Yes/.test(seg.replace(/<[^>]+>/g, "")))
        return seg.split('<w:color w:val="EE0000"/>').join('<w:color w:val="00B050"/>');
      return seg;
    });
  }

  // The route fills the master's form controls, then calls this with the
  // filled buffer: renders the annex loops (fetching every photo from blob at
  // print size 4x7cm, 4 per row), sets the confirmation checkboxes, applies
  // the color rules, and clones the report's own signature block over the
  // confirmation's SIG_BLOCK_MARKER. Returns the finished (un-branded) buffer.
  async renderRepairsMaster(filledBuffer, annex) {
    const FinalReportGenerator = require("./FinalReportGenerator.js");
    // Pixel dimensions of every photo, in the order docx-templates inserts
    // them - consumed by cropSquares() after the render.
    const srcDims = [];
    const buffer = await docxTemplate.createReport({
      template: filledBuffer,
      data: annex.data,
      processLineBreaks: true,
      additionalJsContext: {
        img: async (url) => {
          if (!url) return null;
          const fetched = await this.fetchImage(url);
          if (!fetched) return null;
          // SQUARE boxes (David, Aug 22): a fixed 4x7cm rectangle stretched
          // every photo out of shape. The box is now square and the image is
          // CENTRE-CROPPED to fit it (see cropSquares below), so nothing is
          // distorted - 4 per row still fits inside the margins.
          fetched.width = 4.0;   // cm
          fetched.height = 4.0;  // cm
          // Remember each photo's true pixel shape, in the order Word will
          // place them, so the crop pass knows how much to trim.
          try {
            const d = FinalReportGenerator.getImageDims(fetched.data, String(fetched.extension || '').replace('.', ''));
            srcDims.push(d && d.w && d.h ? d : null);
          } catch (e) { srcDims.push(null); }
          return fetched;
        },
      },
    });
    const PizZip = require("pizzip");
    const zip = new PizZip(Buffer.from(buffer));
    let xml = zip.file("word/document.xml").asText();
    for (const key of Object.keys(annex.confBoxes)) {
      xml = this.setCheckbox(xml, "conf_" + key + "_yes", annex.confBoxes[key]);
      xml = this.setCheckbox(xml, "conf_" + key + "_no", !annex.confBoxes[key]);
    }
    xml = this.applyAnnexColors(xml);
    const qi = xml.indexOf("Qualifying Title");
    const mi = xml.indexOf("SIG_BLOCK_MARKER");
    if (qi !== -1 && mi > qi) {
      const tS = xml.lastIndexOf("<w:tbl>", qi);
      const tE = xml.indexOf("</w:tbl>", qi) + "</w:tbl>".length;
      const pS = Math.max(xml.lastIndexOf("<w:p>", mi), xml.lastIndexOf("<w:p ", mi));
      const pE = xml.indexOf("</w:p>", mi) + "</w:p>".length;
      if (tS !== -1 && pS > tE) {
        // The copy must NOT reuse the originals' content-control ids -
        // duplicate sdt ids make Word report "unreadable content" (David,
        // Aug 21). Dropping w:id from the copy keeps the dropdown values
        // and lets Word assign fresh ids on open.
        const sigCopy = xml.slice(tS, tE).replace(/<w:id w:val="-?\d+"\/>/g, "");
        xml = xml.slice(0, pS) + sigCopy + "<w:p/>" + xml.slice(pE);
      }
    }
    xml = this.cropSquares(xml, srcDims);
    // The finished report is DAVID'S document to edit - strip every content
    // control lock so the confirmation checkboxes and all other fields can be
    // changed in Word (David, Aug 22: "these check boxes need an override").
    xml = xml.replace(/<w:lock w:val="[^"]*"\/>/g, "");
    zip.file("word/document.xml", xml);
    // Same reason: the master carries a forms-restriction setting; a finished
    // report must never open restricted.
    try {
      const setPath = "word/settings.xml";
      const setFile = zip.file(setPath);
      if (setFile) {
        const st = setFile.asText().replace(/<w:documentProtection[^>]*\/>/g, "");
        zip.file(setPath, st);
      }
    } catch (e) { /* settings missing - nothing to unlock */ }
    return this.normalizePackage(zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  }

  // Centre-crop every inserted photo to the square box it sits in. Word does
  // the cropping itself via a:srcRect (percent-of-edge, 1000ths of a percent),
  // so no pixels are re-encoded and nothing is stretched. srcDims carries the
  // photos' true pixel sizes in insertion order; the master body contains no
  // other images, so position N in the document is photo N.
  cropSquares(xml, srcDims) {
    if (!srcDims || !srcDims.length) return xml;
    let i = -1;
    return xml.replace(/<pic:blipFill>([\s\S]*?)<\/pic:blipFill>/g, (whole, inner) => {
      i += 1;
      const d = srcDims[i];
      if (!d || !d.w || !d.h) return whole;
      if (/<a:srcRect\s+[^>]*[lrtb]=/.test(inner)) return whole; // already cropped
      let l = 0, t = 0;
      if (d.w > d.h) {
        // too wide: trim the sides
        const keep = d.h / d.w;
        l = Math.round(((1 - keep) / 2) * 100000);
      } else if (d.h > d.w) {
        // too tall: trim top and bottom
        const keep = d.w / d.h;
        t = Math.round(((1 - keep) / 2) * 100000);
      } else {
        return whole; // already square
      }
      const srcRect = '<a:srcRect l="' + l + '" t="' + t + '" r="' + l + '" b="' + t + '"/>';
      // docx-templates already emits an EMPTY <a:srcRect/> - fill that in;
      // only fall back to inserting one when the element is absent.
      const filled = inner.indexOf("<a:srcRect/>") !== -1
        ? inner.replace("<a:srcRect/>", srcRect)
        : inner.replace("<a:stretch>", srcRect + "<a:stretch>");
      return "<pic:blipFill>" + filled + "</pic:blipFill>";
    });
  }

  // Returns the blob URL of the generated report. Throws on failure so the
  // /generatereport route records its normal FAILED entry.
  async generate(projectId, companyName, projectName, uploader, reportFormat) {
    const data = await this.buildData(projectId);
    const template = fs.readFileSync(path.join(__dirname, "..", "..", "Deck_FinalRepairsTemplate.docx"));
    const buffer = await docxTemplate.createReport({
      template,
      data,
      processLineBreaks: true,   // renders \n in comments as real line breaks
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
