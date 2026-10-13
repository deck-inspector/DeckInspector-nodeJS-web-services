// REVIEW REPORT generator (David, Oct 6 2026).
// Deck_ReviewTemplate.docx = pages 1-2 of the Visual master (letter + property
// page, retitled) + the review sections + the master's terms/signature block +
// a written "Summary of Prior Inspection Report" (David, Oct 13 2026: the other
// company's full report is NOT attached - no Annex 1, no prior pages under our
// letterhead). Generation:
//   1. FinalReportGenerator.fillTemplate() - the SAME address/date fill, client
//      company name/phone, per-client signers, 0.25in header/footer and client
//      logo/footer branding the E3 Inspection (Final) Report gets.
//   2. Every review field is written INTO its content control. The controls are
//      kept (never flattened), so every dropdown / text box stays editable in Word.
//   3. Order: Sections A-D (findings) -> Section E (conclusion) -> OUR E3
//      INSPECTION REPORT (the Visual report body: every building / location /
//      section with ratings and photos; its cover page with the project photo /
//      logo is removed - the review's own letter, property page and signature
//      are used instead; David, Oct 13 2026) -> Summary of Prior Inspection
//      Report -> limitations / terms / signature. The master's
//      Annex 1 heading + placeholder are removed and its "attached as Annex 1"
//      wording is rewritten, so the live master blob needs no re-upload.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const FRG = require('../ReportGeneration/FinalReportGenerator');
const uploadBlob = require('../../database/uploadimage');
const schema = require('./reviewSchema');
const projects = require('../../model/project');
const location = require('../../model/location');
const subProject = require('../../model/subproject');
const sections = require('../../model/sections');
const RatingMapping = require('../../model/ratingMapping');
const GenerateReport = require('../ReportGeneration/GenerateReport');
const RGU = require('../ReportGeneration/ReportGenerationUtil');

const MASTER_FILE = 'Deck_ReviewTemplate.docx';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function getMaster() {
  try {
    const buf = await uploadBlob.getBlobBuffer(MASTER_FILE, 'projectreports');
    if (buf && buf.length) return buf;
  } catch (e) { /* not uploaded yet - repo copy */ }
  return fs.readFileSync(path.join(__dirname, '..', '..', MASTER_FILE));
}

// ---------- the Reviewer's own E3 inspection, as plain data for the AI ----------
async function collectE3(projectId) {
  const pr = await projects.getProjectById(projectId);
  const p = pr.project || (pr.data && pr.data.item) || {};
  const out = { project: { name: p.name || '', address: (p.address || '').replace(/\s+/g, ' ').trim(),
                           description: p.description || '', createdat: p.createdat || '' }, locations: [] };
  const life = v => (RatingMapping[v] || v || '');
  const addLoc = async (loc, building) => {
    const id = loc.id || loc._id;
    let items = [];
    try { const r = await sections.getSectionMetaDataForLocationId(id); items = (r.data && r.data.item) || []; } catch (e) { /* none */ }
    out.locations.push({ building: building || '', name: loc.name || '', description: loc.description || '',
      sections: items.map(s => ({ name: s.name || '', visualreview: s.visualreview || '', conditionalassessment: s.conditionalassessment || '',
        eee: life(s.eee), lbc: life(s.lbc), awe: life(s.awe), visualsignsofleak: String(s.visualsignsofleak ?? s.visualsignofleak ?? ''),
        furtherinvasivereviewrequired: String(s.furtherinvasivereviewrequired ?? ''), unsafecondition: String(s.unsafecondition ?? ''),
        exteriorelements: [].concat(s.exteriorelements || []).join(', '), waterproofingelements: [].concat(s.waterproofingelements || []).join(', '),
        additionalconsiderations: s.additionalconsiderations || '', photos: (s.images || []).length,
        inspectedBy: s.createdby || '', inspectedAt: String(s.createdat || '').slice(0, 10) })) });
  };
  try { const d = await location.getLocationByParentId(projectId); for (const l of ((d.data && d.data.item) || [])) await addLoc(l, ''); } catch (e) { /* none */ }
  try {
    const sp = await subProject.getSubProjectsByParentId(projectId);
    for (const b of ((sp.data && sp.data.item) || [])) {
      try { const d = await location.getLocationByParentId(b.id || b._id); for (const l of ((d.data && d.data.item) || [])) await addLoc(l, b.name || ''); } catch (e) { /* none */ }
    }
  } catch (e) { /* none */ }
  return out;
}

// ---------- content-control writers (string-level, structure preserving) ----------
function sdtBounds(doc, alias) {
  const tag = `<w:alias w:val="${esc(alias)}"/>`;
  const a = doc.indexOf(tag);
  if (a === -1) return null;
  const start = doc.lastIndexOf('<w:sdt>', a);
  const prEnd = doc.indexOf('</w:sdtPr>', a);
  const range = FRG.findSdtContentRange(doc.slice(start), alias);
  if (start === -1 || prEnd === -1 || !range) return null;
  return { start, prEnd, cStart: start + range.contentStart, cEnd: start + range.contentEnd };
}

function runXml(value, long) {
  const lines = String(value).replace(/\r/g, '').split('\n');
  const body = lines.map((l, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(l)}</w:t>`).join('');
  return '<w:r><w:rPr><w:rStyle w:val="FinalReport"/>' + (long ? '<w:b w:val="0"/><w:bCs w:val="0"/>' : '')
    + '<w:color w:val="FF0000"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' + body + '</w:r>';
}

function setText(doc, alias, value, long) {
  if (value == null || String(value).trim() === '') return doc;
  const b = sdtBounds(doc, alias);
  if (!b) { console.log('ReviewReport: control not found ->', alias); return doc; }
  let pr = doc.slice(b.start, b.prEnd).replace('<w:showingPlcHdr/>', '');
  const content = doc.slice(b.cStart, b.cEnd);
  const newContent = /<w:(p|tc)[ >]/.test(content) ? FRG.swapFirstTextRun(content, value) : runXml(value, long);
  return doc.slice(0, b.start) + pr + doc.slice(b.prEnd, b.cStart) + newContent + doc.slice(b.cEnd);
}

function setCheckAt(doc, sdtStart, on) {
  const end = doc.indexOf('</w:sdt>', sdtStart);
  let chunk = doc.slice(sdtStart, end);
  chunk = chunk.replace(/(<w14:checked w14:val=")[01](")/, `$1${on ? 1 : 0}$2`)
               .replace(/(<w:sdtContent>[\s\S]*?<w:t[^>]*>)[☐☒](<\/w:t>)/, `$1${on ? '☒' : '☐'}$2`);
  return doc.slice(0, sdtStart) + chunk + doc.slice(end);
}
function setCheck(doc, alias, on) {
  const b = sdtBounds(doc, alias);
  return b ? setCheckAt(doc, b.start, on) : doc;
}

function fillReview(doc, f) {
  // page 2 checkboxes - the unlabeled checkbox controls before "Applicable Law"
  const stop = doc.indexOf('<w:alias w:val="Applicable Law"/>');
  let pos = 0;
  for (const key of schema.PAGE2_CHECKS) {
    const c = doc.indexOf('<w14:checkbox>', pos);
    if (c === -1 || (stop !== -1 && c > stop)) break;
    const s = doc.lastIndexOf('<w:sdt>', c);
    doc = setCheckAt(doc, s, !!f.page2.checks[key]);
    pos = doc.indexOf('</w:sdt>', s) + 1;
  }
  // page 2 count cells (red 0s) and the immediate-threat box
  const pt = doc.indexOf('Property Total');
  if (pt !== -1) {
    const ts = doc.lastIndexOf('<w:tbl>', pt), te = doc.indexOf('</w:tbl>', pt);
    const vals = [f.page2.totalUnitCount, f.page2.unitsWithEEE, f.page2.totalEEE, f.page2.eeeInspected].map(schema.shortCount);
    let k = 0;
    // Fixed column widths, so one longer value cannot squeeze the other cells and make
    // the row tall enough to push the signature block to the next page (David, Oct 6 2026).
    let tbl = doc.slice(ts, te);
    if (!/<w:tblLayout /.test(tbl.slice(0, tbl.indexOf('</w:tblPr>')))) {
      const prEnd = tbl.indexOf('</w:tblPr>');
      const head = tbl.slice(0, prEnd);
      const at = ['<w:tblCellMar', '<w:tblLook', '<w:tblCaption', '<w:tblDescription'].map(t => head.indexOf(t)).filter(i => i !== -1);
      const ins = at.length ? Math.min(...at) : prEnd;
      if (prEnd !== -1) tbl = tbl.slice(0, ins) + '<w:tblLayout w:type="fixed"/>' + tbl.slice(ins);
    }
    tbl = tbl.replace(/<w:ind w:right="\d+"\/>/g, '<w:ind w:right="0"/>'); // value cells only (labels use negative indents)
    tbl = tbl.replace(/(<w:t(?: [^>]*)?>)0(<\/w:t>)/g, (m, o, c) => {
      const v = vals[k++]; return (v != null && String(v).trim() !== '') ? o + esc(v) + c : m;
    });
    doc = doc.slice(0, ts) + tbl + doc.slice(te);
  }
  if (f.page2.immediateThreatCount) {
    const it = doc.indexOf('immediate threat to the safety of the occupants');
    if (it !== -1) {
      // The red box is a text box stored twice - the copy Word shows (mc:Choice) and a
      // fallback (mc:Fallback) - so start at the paragraph that holds the whole box.
      const ac = doc.lastIndexOf('<mc:AlternateContent', it);
      const acEnd = ac === -1 ? -1 : doc.indexOf('</mc:AlternateContent>', ac);
      const sameParagraph = ac !== -1 && acEnd !== -1 && acEnd < it && doc.slice(acEnd, it).indexOf('</w:p>') === -1;
      const from = sameParagraph ? ac : it;
      const ps = Math.max(doc.lastIndexOf('<w:p>', from), doc.lastIndexOf('<w:p ', from)), pe = doc.indexOf('</w:p>', it);
      const para = doc.slice(ps, pe).replace(/(<w:t(?: [^>]*)?>)0(<\/w:t>)/g, `$1${esc(schema.shortCount(f.page2.immediateThreatCount))}$2`);
      doc = doc.slice(0, ps) + para + doc.slice(pe);
    }
  }
  const P = f.prior;
  [['Applicable Law', P.applicableLaw], ['Property Type', P.propertyType], ['Prior Company', P.company, 1], ['Prior Inspector', P.inspector, 1],
   ['Prior Inspector License', P.license, 1], ['Prior Inspection Date', P.inspectionDate, 1], ['Prior Report Date', P.reportDate, 1],
   ['Prior Report Reference', P.reference, 1], ['Basis of Review', P.basis], ['Review Date', P.reviewDate, 1]]
    .forEach(([a, v, l]) => { doc = setText(doc, a, v, !!l); });
  f.A.forEach((r, i) => { doc = setText(doc, `A${i + 1} Finding`, r.finding); doc = setText(doc, `A${i + 1} Comments`, r.comments, true); });
  f.B.forEach((r, i) => {
    doc = setCheck(doc, `B${i + 1} Present`, r.present);
    doc = setText(doc, `B${i + 1} Prior Report Ref`, r.ref, true); doc = setText(doc, `B${i + 1} Opinion`, r.opinion);
    doc = setText(doc, `B${i + 1} Comments`, r.comments, true);
  });
  f.C.forEach((r, i) => { doc = setText(doc, `C${i + 1} Status`, r.status); doc = setText(doc, `C${i + 1} Comments`, r.comments, true); });
  f.D.forEach((r, i) => {
    doc = setText(doc, `D${i + 1} Location`, r.location); doc = setText(doc, `D${i + 1} Prior Recommendation`, r.recommendation, true);
    doc = setText(doc, `D${i + 1} Opinion`, r.opinion); doc = setText(doc, `D${i + 1} Basis`, r.basis, true);
  });
  doc = setText(doc, 'Overall Opinion', f.E.overall); doc = setText(doc, 'Accuracy', f.E.accuracy);
  doc = setText(doc, 'Recommendation', f.E.recommendation);
  doc = setText(doc, 'Summary of Opinion', f.E.summary, true); doc = setText(doc, 'Additional Critique', f.E.critique, true);
  return keepCertTogether(doc);
}

// Reviewer Certification + its 3-row signer table never split across pages.
function keepCertTogether(doc) {
  const c = doc.indexOf('Reviewer Certification');
  if (c === -1) return doc;
  const ps = Math.max(doc.lastIndexOf('<w:p>', c), doc.lastIndexOf('<w:p ', c));
  const ts = doc.indexOf('<w:tbl>', c), te = doc.indexOf('</w:tbl>', ts);
  if (ps === -1 || ts === -1 || te === -1) return doc;
  const addKeepNext = para => para.includes('<w:keepNext/>') ? para
    : para.includes('<w:pPr>') ? para.replace(/<w:pPr>(<w:pStyle [^>]*\/>)?/, (m, st) => '<w:pPr>' + (st || '') + '<w:keepNext/>') // schema order: pStyle, keepNext
    : para.replace(/^(<w:p(?: [^>]*)?>)/, '$1<w:pPr><w:keepNext/></w:pPr>');
  // heading paragraph
  const pe = doc.indexOf('</w:p>', c);
  let head = addKeepNext(doc.slice(ps, pe));
  // table: rows can't split; every paragraph except the last row keeps with the next
  let tbl = doc.slice(ts, te);
  const rows = tbl.split('<w:tr ');
  tbl = rows.map((r, i) => {
    if (i === 0) return r;
    r = r.includes('<w:trPr>') ? r.replace('<w:trPr>', '<w:trPr><w:cantSplit/>') : r.replace(/^([^>]*>)/, '$1<w:trPr><w:cantSplit/></w:trPr>');
    if (i < rows.length - 1) r = r.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, addKeepNext);
    return r;
  }).join('<w:tr ');
  return doc.slice(0, ps) + head + doc.slice(pe, ts) + tbl + doc.slice(te);
}

// The client's header logo can be up to ~1.25 in tall, which pushes the signer block of
// the Review Report's first data page onto the next page. Cap it for this report only.
const HEADER_LOGO_MAX_EMU = Math.round(0.8 * 914400);
function capHeaderLogos(zip) {
  Object.keys(zip.files).filter(n => /^word\/header\d+\.xml$/.test(n)).forEach(n => {
    const x = zip.file(n).asText();
    const y = x.replace(/(<wp:extent |<a:ext )cx="(\d+)" cy="(\d+)"/g, (m, tag, cx, cy) => {
      cx = +cx; cy = +cy;
      return cy > HEADER_LOGO_MAX_EMU ? `${tag}cx="${Math.round(cx * HEADER_LOGO_MAX_EMU / cy)}" cy="${HEADER_LOGO_MAX_EMU}"` : m;
    });
    if (y !== x) zip.file(n, y);
  });
}

// The closing signature table (Signature / Inspector Name / Qualifying Title / License #)
// must never split across pages - the summary's length moves it (Oct 13 2026).
function keepSignatureTogether(doc) {
  const note = doc.lastIndexOf('This document, in its entirety, is protected');
  const sig = doc.lastIndexOf('>Signature<', note === -1 ? doc.length : note);
  if (sig === -1) return doc;
  const ts = Math.max(doc.lastIndexOf('<w:tbl>', sig), doc.lastIndexOf('<w:tbl ', sig)), te = doc.indexOf('</w:tbl>', sig);
  if (ts === -1 || te === -1) return doc;
  const addKeepNext = para => para.includes('<w:keepNext/>') ? para
    : para.includes('<w:pPr>') ? para.replace(/<w:pPr>(<w:pStyle [^>]*\/>)?/, (m, st) => '<w:pPr>' + (st || '') + '<w:keepNext/>')
    : para.replace(/^(<w:p(?: [^>]*)?>)/, '$1<w:pPr><w:keepNext/></w:pPr>');
  const rows = doc.slice(ts, te).split(/(?=<w:tr[ >])/);
  const tbl = rows.map((r, i) => {
    if (!/^<w:tr[ >]/.test(r)) return r;
    r = r.includes('<w:trPr>') ? (r.includes('<w:cantSplit/>') ? r : r.replace('<w:trPr>', '<w:trPr><w:cantSplit/>'))
                               : r.replace(/^(<w:tr(?: [^>]*)?>)/, '$1<w:trPr><w:cantSplit/></w:trPr>');
    r = r.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, addKeepNext);   // every row, incl. the last: keep with the NOTE
    return r;
  }).join('');
  // the (empty) paragraphs between the table and the copyright NOTE also keep with it
  const gapEnd = note === -1 ? te : paraStart(doc, note);
  const gap = doc.slice(te, gapEnd).replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, addKeepNext);
  return doc.slice(0, ts) + tbl + gap + doc.slice(gapEnd);
}

// ---------- Our E3 inspection report (Visual report body) ----------
// The Visual report = cover page (DeckProjectHeader: "Visual Inspection Report",
// project name/address/description/created by + project photo or company logo)
// followed by the building / location / section pieces, each joined by
// merge_docx.py's 1-pt page-break paragraph. The cover is cut off here.
const MERGE_BREAK_RE = /<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:pageBreakBefore\/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"\/>[\s\S]*?<\/w:p>/;
function stripVisualCover(buf) {
  const zip = new PizZip(buf);
  let doc = zip.file('word/document.xml').asText();
  const bodyOpen = doc.indexOf('<w:body>');
  const bodyStart = bodyOpen === -1 ? -1 : bodyOpen + '<w:body>'.length;
  const cover = doc.indexOf('Created By:');
  if (bodyStart === -1 || cover === -1) { console.log('ReviewReport: Visual cover page not found - kept as is'); return buf; }
  let cutTo = -1;
  const rest = doc.slice(cover);
  const m = rest.match(MERGE_BREAK_RE);
  if (m) cutTo = cover + m.index + m[0].length;       // through the break paragraph after the cover
  else {                                               // Node-merger fallback: through the cover photo paragraph
    const img = doc.indexOf('<w:drawing>', cover);
    if (img !== -1) cutTo = paraEnd(doc, img);
  }
  if (cutTo === -1) { console.log('ReviewReport: Visual cover end not found - kept as is'); return buf; }
  doc = doc.slice(0, bodyStart) + doc.slice(cutTo);
  doc = dropTrailingSpacerRows(doc);
  zip.file('word/document.xml', doc);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Each section table ends with an empty spacer row. When the photos fill the page
// exactly, that empty row spills onto a page of its own and the next location then
// starts a page later - a blank page (seen in the 633 N Taylor sample, Oct 13 2026).
// Remove that last row when it holds no text or picture and the table is followed
// (bookmarks aside) by a page-break paragraph or the end of the body.
function dropTrailingSpacerRows(doc) {
  let removed = 0;
  const out = doc.replace(/<w:tr[ >](?:(?!<w:tr[ >])[\s\S])*?<\/w:tr>((?:<w:bookmark(?:End|Start)[^>]*\/>)*)<\/w:tbl>((?:<w:bookmark(?:End|Start)[^>]*\/>)*)(?=<w:p><w:pPr><w:pageBreakBefore\/>|<w:sectPr)/g,
    (row, b1, b2) => {
      const tr = row.slice(0, row.lastIndexOf('</w:tr>') + '</w:tr>'.length);
      if (/<w:drawing|<w:pict|<w:sdt/.test(tr)) return row;
      const text = (tr.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
      if (text.trim() !== '') return row;
      if ((row.match(/<w:tr[ >]/g) || []).length !== 1) return row;
      removed++;
      return b1 + '</w:tbl>' + b2;
    });
  if (removed) console.log('ReviewReport: removed', removed, 'empty spacer rows from the E3 report');
  return out;
}

async function buildVisualBody(projectId) {
  const url = await GenerateReport.generateReport(projectId, 'Visual');
  if (!url) throw new Error('the E3 Visual Inspection Report could not be generated');
  const parts = String(url).split('/');
  const buf = await uploadBlob.getBlobBuffer(decodeURIComponent(parts[parts.length - 1]), parts[parts.length - 2]);
  if (!buf || !buf.length) throw new Error('the E3 Visual Inspection Report file was empty');
  return stripVisualCover(RGU.sanitizeDocxBuffer(buf));
}

// Split the filled review into [letter .. Section E] and [Summary of Prior Report .. end],
// so our inspection report can be placed between them. Both halves keep the review's
// own page setup, header (client logo) and footer.
function splitReview(buf) {
  const zip = new PizZip(buf);
  const doc = zip.file('word/document.xml').asText();
  const mark = doc.indexOf('>Summary of Prior Inspection Report<');
  const bodyOpen = doc.indexOf('<w:body>');
  const sect = doc.lastIndexOf('<w:sectPr');
  if (mark === -1 || bodyOpen === -1 || sect === -1) throw new Error('ReviewReport: split point not found');
  const bodyStart = bodyOpen + '<w:body>'.length;
  const at = paraStart(doc, mark);
  const dropOrphanBookmarks = x => {
    const starts = new Set([...x.matchAll(/<w:bookmarkStart [^>]*w:id="(\d+)"/g)].map(m => m[1]));
    const ends = new Set([...x.matchAll(/<w:bookmarkEnd [^>]*w:id="(\d+)"/g)].map(m => m[1]));
    return x.replace(/<w:bookmarkStart [^>]*w:id="(\d+)"[^>]*\/>/g, (m, id) => ends.has(id) ? m : '')
            .replace(/<w:bookmarkEnd [^>]*w:id="(\d+)"[^>]*\/>/g, (m, id) => starts.has(id) ? m : '');
  };
  const half = xml => { const z = new PizZip(buf); z.file('word/document.xml', dropOrphanBookmarks(xml)); return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }); };
  return [half(doc.slice(0, at) + doc.slice(sect)), half(doc.slice(0, bodyStart) + doc.slice(at))];
}

// ---------- Summary of Prior Inspection Report (replaces Annex 1, Oct 13 2026) ----------
const paraStart = (doc, at) => Math.max(doc.lastIndexOf('<w:p>', at), doc.lastIndexOf('<w:p ', at));
const paraEnd = (doc, at) => doc.indexOf('</w:p>', at) + '</w:p>'.length;

// Wording on pages 1-2 and in the Limitations that referred to the attached report.
const ANNEX_WORDING = [
  ['(excluding the Prior Report attached as Annex 1, which remains the work product of its author)',
   '(excluding the Prior Report, which remains the work product of its author)'],
  ['(the “Prior Report”, attached as Annex 1', '(the “Prior Report”, summarized at the end of this Review'],
  ['The Prior Report remains the work product of its author and is attached as Annex 1 solely for reference.',
   'The Prior Report remains the work product of its author; it is summarized in this Review for reference only and is not reproduced.'],
];

function removeAnnex(doc) {
  ANNEX_WORDING.forEach(([a, b]) => { doc = doc.split(a).join(b); });
  const ph = doc.indexOf('[The Prior Report is attached here.]');
  const hd = doc.search(/Annex 1 [–-] Prior Inspection Report Reviewed/);
  if (ph === -1 && hd === -1) return doc;
  const from = paraStart(doc, hd !== -1 ? hd : ph);
  const to = paraEnd(doc, ph !== -1 ? ph : hd);
  return doc.slice(0, from) + doc.slice(to);
}

// Heading styled like the master's "Section E - Reviewer Conclusion" heading, then the
// summary text (same red fill style as the other answers), placed right before the
// "LIMITATIONS OF REVIEW" paragraph, i.e. after Section E.
function placePriorSummary(doc, text) {
  const lim = doc.indexOf('LIMITATIONS OF REVIEW');
  if (lim === -1) { console.log('ReviewReport: Limitations paragraph not found - summary not placed'); return doc; }
  const at = paraStart(doc, lim);
  const se = doc.indexOf('Section E – Reviewer Conclusion');
  let heading;
  if (se !== -1) {
    heading = doc.slice(paraStart(doc, se), paraEnd(doc, se)).replace('Section E – Reviewer Conclusion', 'Summary of Prior Inspection Report');
  } else {
    heading = '<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:caps/><w:sz w:val="20"/></w:rPr><w:t>Summary of Prior Inspection Report</w:t></w:r></w:p>';
  }
  const lines = String(text || '').replace(/\r/g, '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const pPr = '<w:pPr><w:spacing w:before="0" w:after="120" w:line="259" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>';
  const body = lines.length
    ? lines.map(l => '<w:p>' + pPr + runXml(l, true) + '</w:p>').join('')
    : '<w:p>' + pPr + '<w:r><w:rPr><w:i/><w:color w:val="7F7F7F"/><w:sz w:val="20"/></w:rPr><w:t>[Summary of the Prior Inspection Report not provided.]</w:t></w:r></w:p>';
  return doc.slice(0, at) + heading + body + doc.slice(at);
}

// fields: normalized review fields. The prior report's pages are NOT used here.
async function generate({ projectId, companyName, fields, uploader }) {
  const f = schema.normalize(fields);
  const data = await FRG.collectProjectData(projectId);
  data.inspectionDate = f.page2.reviewInspectionDate || '';   // page 2 = the REVIEW inspection date
  const branded = await FRG.fillTemplate(await getMaster(), data, companyName);
  const zip = new PizZip(branded);
  let doc = zip.file('word/document.xml').asText();
  doc = fillReview(doc, f);
  doc = removeAnnex(doc);
  doc = placePriorSummary(doc, f.E.priorSummary);
  doc = keepSignatureTogether(doc);
  zip.file('word/document.xml', doc);
  capHeaderLogos(zip);
  const review = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Our E3 inspection report goes between Section E and the prior-report summary.
  const visual = await buildVisualBody(projectId);
  const [head, tail] = splitReview(review);
  const out = RGU.mergeViaPython([head, visual, tail], `${projectId}_review`);
  if (!out) throw new Error('combining the review with the E3 inspection report failed');

  const tmp = path.join(os.tmpdir(), `${projectId}_ReviewReport.docx`);
  fs.writeFileSync(tmp, out);
  const fileName = `${projectId}_ReviewReport_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.docx`;
  const result = await uploadBlob.uploadFile('projectreports', fileName, tmp, {
    metadata: { uploader: uploader || 'system' }, tags: { id: String(projectId), reportType: 'ReviewReport' } });
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  const parsed = JSON.parse(result);
  if (!parsed || !parsed.url) throw new Error('ReviewReport: upload failed -> ' + result);
  return { url: parsed.url, bytes: out.length };
}

module.exports = { generate, collectE3, fillReview, removeAnnex, placePriorSummary, keepSignatureTogether, stripVisualCover, splitReview, getMaster, capHeaderLogos, keepCertTogether, MASTER_FILE };
