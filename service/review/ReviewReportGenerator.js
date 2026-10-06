// REVIEW REPORT generator (David, Oct 6 2026).
// Deck_ReviewTemplate.docx = pages 1-2 of the Visual master (letter + property
// page, retitled) + the review sections + the master's terms/signature block +
// "Annex 1 - Prior Inspection Report Reviewed". Generation:
//   1. FinalReportGenerator.fillTemplate() - the SAME address/date fill, client
//      company name/phone, per-client signers, 0.25in header/footer and client
//      logo/footer branding the E3 Inspection (Final) Report gets.
//   2. Every review field is written INTO its content control. The controls are
//      kept (never flattened), so every dropdown / text box stays editable in Word.
//   3. The uploaded prior report's page images are placed after the Annex 1
//      heading, one page each.
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

// ---------- Annex 1: prior report pages as full-page images ----------
function placeAnnex(zip, doc, pageBuffers) {
  const marker = doc.indexOf('[The Prior Report is attached here.]');
  if (marker === -1) { console.log('ReviewReport: annex placeholder not found'); return doc; }
  const ps = Math.max(doc.lastIndexOf('<w:p>', marker), doc.lastIndexOf('<w:p ', marker));
  const pe = doc.indexOf('</w:p>', marker) + '</w:p>'.length;
  if (!pageBuffers.length) {
    return doc.slice(0, ps) + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>[No prior report has been uploaded.]</w:t></w:r></w:p>' + doc.slice(pe);
  }
  FRG.ensureContentType(zip, 'jpg');
  const EMU = 914400, maxW = 6.5 * EMU, maxH = 8.6 * EMU;
  let rels = zip.file('word/_rels/document.xml.rels').asText();
  let paras = '';
  pageBuffers.forEach((buf, i) => {
    const n = String(i + 1).padStart(3, '0');
    const rid = 'rIdPrior' + n;
    zip.file(`word/media/prior_${n}.jpg`, buf);
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/prior_${n}.jpg"/></Relationships>`);
    const d = FRG.getImageDims(buf, 'jpg');
    const s = Math.min(maxW / Math.max(1, d.w), maxH / Math.max(1, d.h));
    const cx = Math.round(d.w * s), cy = Math.round(d.h * s);
    paras += '<w:p><w:pPr>' + (i ? '<w:pageBreakBefore/>' : '') + '<w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>'
      + FRG.inlineImageXml(rid, cx, cy, 996001 + i, 'PriorPage' + n) + '</w:p>';
  });
  zip.file('word/_rels/document.xml.rels', rels);
  return doc.slice(0, ps) + paras + doc.slice(pe);
}

// fields: normalized review fields; pageBuffers: [Buffer jpeg] in page order
async function generate({ projectId, companyName, fields, pageBuffers, uploader }) {
  const f = schema.normalize(fields);
  const data = await FRG.collectProjectData(projectId);
  data.inspectionDate = f.page2.reviewInspectionDate || '';   // page 2 = the REVIEW inspection date
  const branded = await FRG.fillTemplate(await getMaster(), data, companyName);
  const zip = new PizZip(branded);
  let doc = zip.file('word/document.xml').asText();
  doc = fillReview(doc, f);
  doc = placeAnnex(zip, doc, pageBuffers || []);
  zip.file('word/document.xml', doc);
  capHeaderLogos(zip);
  const out = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

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

module.exports = { generate, collectE3, fillReview, placeAnnex, getMaster, capHeaderLogos, keepCertTogether, MASTER_FILE };
