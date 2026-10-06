// Fills the Final Report cover (page 1 counts + checkboxes, exclusion reason,
// Inspection Overview and the Additional Comments boxes) from the Claude summary
// the inspector applied (service/visualai). String-level edits only; every value
// stays an editable content control in Word. Anything not found is skipped.
'use strict';
const V = require('./visualSchema');

const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Replace a control's displayed text (keeps the run formatting of the first run,
// supports line breaks, removes the grey placeholder look).
function setControlText(xml, id, value) {
  if (!id || value == null || String(value).trim() === '') return xml;
  const blocks = V.sdtBlocks(xml);
  for (const b of blocks) {
    const outer = xml.slice(b.start, b.end);
    if (V.sdtInfo(outer).id !== String(id)) continue;
    let blk = outer.replace(/<w:showingPlcHdr\/>/g, '').replace(/<w:sdtContent\/>/g, '<w:sdtContent></w:sdtContent>')
                   .replace(/<w:t(\s[^>]*)?\/>/g, (m, a) => '<w:t' + (a || '') + '></w:t>');
    const ci = blk.indexOf('<w:sdtContent>'), ce = blk.lastIndexOf('</w:sdtContent>');
    if (ci === -1 || ce === -1) return xml;
    let content = blk.slice(ci + 14, ce).replace(/<w:rStyle w:val="PlaceholderText"\/>/g, '');
    const lines = String(value).replace(/\r/g, '').split('\n');
    const body = lines.map((l, i) => (i ? '</w:t><w:br/><w:t xml:space="preserve">' : '') + esc(l)).join('');
    let first = true;
    const nc = content.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, () => {
      if (first) { first = false; return '<w:t xml:space="preserve">' + body + '</w:t>'; }
      return '<w:t xml:space="preserve"></w:t>';
    });
    let out = nc;
    if (first) {   // the control had no text run at all
      const run = '<w:r><w:t xml:space="preserve">' + body + '</w:t></w:r>';
      out = /<w:p[ >]/.test(content) ? content.replace(/(<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)/, '$1' + run) : content + run;
    }
    blk = blk.slice(0, ci + 14) + out + blk.slice(ce);
    return xml.slice(0, b.start) + blk + xml.slice(b.end);
  }
  return xml;
}

function setCheckAt(xml, sdtStart, on) {
  const end = xml.indexOf('</w:sdt>', sdtStart);
  if (end === -1) return xml;
  let chunk = xml.slice(sdtStart, end);
  chunk = chunk.replace(/(<w14:checked w14:val=")[01](")/, `$1${on ? 1 : 0}$2`)
               .replace(/(<w:t(?: [^>]*)?>)[☐☒](<\/w:t>)/, `$1${on ? '☒' : '☐'}$2`);
  return xml.slice(0, sdtStart) + chunk + xml.slice(end);
}

function fillCover(doc, sum, master) {
  if (!sum) return doc;
  // 1. page-1 checkboxes: the checkbox controls between the count table and "Reason for exclusion"
  const from = doc.indexOf('# Units with EEE');
  const stop = doc.indexOf('Reason for exclusion');
  if (from !== -1) {
    let pos = from;
    for (const key of V.COVER_CHECKS) {
      const c = doc.indexOf('<w14:checkbox>', pos);
      if (c === -1 || (stop !== -1 && c > stop)) break;
      const st = doc.lastIndexOf('<w:sdt>', c);
      doc = setCheckAt(doc, st, !!(sum.checks && sum.checks[key]));
      pos = doc.indexOf('</w:sdt>', st) + 1;
    }
  }
  // 2. count cells (red 0s): Total Unit Count, Units with EEE, Total EEE, EEE Inspected
  const pt = doc.indexOf('# Units with EEE');
  if (pt !== -1) {
    const ts = doc.lastIndexOf('<w:tbl>', pt), te = doc.indexOf('</w:tbl>', pt);
    if (ts !== -1 && te !== -1) {
      const vals = [sum.totalUnitCount, sum.unitsWithEEE, sum.totalEEE, sum.eeeInspected].map(V.shortCount);
      let k = 0;
      // the value cells carry a right indent that wraps "N/A" onto two lines (same fix as the Review Report)
      let tbl = doc.slice(ts, te).replace(/<w:ind w:right="\d+"\/>/g, '<w:ind w:right="0"/>').replace(/(<w:t(?: [^>]*)?>)0(<\/w:t>)/g, (m, o, c) => {
        const v = vals[k++]; return v ? o + esc(v) + c : m;
      });
      doc = doc.slice(0, ts) + tbl + doc.slice(te);
    }
  }
  // 3. immediate-threat box (a text box stored twice: mc:Choice + mc:Fallback)
  if (V.shortCount(sum.immediateThreatCount)) {
    const it = doc.indexOf('immediate threat to the safety of the occupants');
    if (it !== -1) {
      const ac = doc.lastIndexOf('<mc:AlternateContent', it);
      const acEnd = ac === -1 ? -1 : doc.indexOf('</mc:AlternateContent>', ac);
      const same = ac !== -1 && acEnd !== -1 && acEnd < it && doc.slice(acEnd, it).indexOf('</w:p>') === -1;
      const f = same ? ac : it;
      const ps = Math.max(doc.lastIndexOf('<w:p>', f), doc.lastIndexOf('<w:p ', f)), pe = doc.indexOf('</w:p>', it);
      if (ps !== -1 && pe !== -1) {
        const para = doc.slice(ps, pe).replace(/(<w:t(?: [^>]*)?>)0(<\/w:t>)/g, `$1${esc(V.shortCount(sum.immediateThreatCount))}$2`);
        doc = doc.slice(0, ps) + para + doc.slice(pe);
      }
    }
  }
  // 4. aliased text controls + exclusion reason
  doc = setByAlias(doc, 'Additional Areas', sum.checks && sum.checks.otherEEE ? sum.additionalAreas : '');
  doc = setByAlias(doc, 'Additional Items', sum.checks && sum.checks.otherAWE ? sum.additionalItems : '');
  if (master.exclusionId) doc = setControlText(doc, master.exclusionId, sum.exclusionReason);
  // 5. Inspection Overview + Additional Comments
  for (const sl of master.slots || []) {
    const v = (sum.overview || {})[sl.key] || {};
    doc = setControlText(doc, sl.typeId, v.type);
    doc = setControlText(doc, sl.conditionId, v.condition);
    if (sl.labelId) doc = setControlText(doc, sl.labelId, sum.otherLabel);
  }
  doc = setControlText(doc, master.commentIds[0], sum.comments1);
  doc = setControlText(doc, master.commentIds[1], sum.comments2);
  return doc;
}
function setByAlias(doc, alias, value) {
  if (!value) return doc;
  const tag = `<w:alias w:val="${alias}"/>`;
  const a = doc.indexOf(tag);
  if (a === -1) return doc;
  const st = doc.lastIndexOf('<w:sdt>', a);
  const outer = doc.slice(st, doc.indexOf('</w:sdtPr>', st));
  const id = (outer.match(/<w:id w:val="(-?\d+)"/) || [])[1];
  return setControlText(doc, id, value);
}

module.exports = { fillCover, setControlText };
