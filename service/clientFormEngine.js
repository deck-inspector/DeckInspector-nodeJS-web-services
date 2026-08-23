// Generic content-control (Structured Document Tag) form engine for the
// client blank forms. Parses a Word template's <w:sdt> controls into a schema,
// and fills them back from user values - WITHOUT touching any surrounding
// formatting, so the output is pixel-identical to the template (same fonts,
// cell shading, colors). Works on both the .docm (Final Upon Completion) and
// the .docx (Notice of Unsafe Conditions).
'use strict';

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Split the document into top-level <w:sdt>...</w:sdt> blocks (handles nesting
// by depth counting) and return [{start,end,outer}] plus the gaps between.
function findSdtBlocks(xml) {
  const blocks = [];
  const re = /<w:sdt>|<\/w:sdt>/g;
  let m, depth = 0, startIdx = -1;
  while ((m = re.exec(xml))) {
    if (m[0] === '<w:sdt>') {
      if (depth === 0) startIdx = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        blocks.push({ start: startIdx, end: re.lastIndex });
        startIdx = -1;
      }
    }
  }
  return blocks;
}

function parseSdtPr(outer) {
  const prM = outer.match(/<w:sdtPr>([\s\S]*?)<\/w:sdtPr>/);
  const pr = prM ? prM[1] : '';
  const id = (pr.match(/<w:id[^>]*w:val="(-?\d+)"/) || [])[1] || null;
  const alias = (pr.match(/<w:alias[^>]*w:val="([^"]*)"/) || [])[1] || '';
  const tag = (pr.match(/<w:tag[^>]*w:val="([^"]*)"/) || [])[1] || '';
  let type = 'text';
  if (/<w14:checkbox|<w:checkbox/.test(pr)) type = 'checkbox';
  else if (/<w:dropDownList/.test(pr)) type = 'dropdown';
  else if (/<w:comboBox/.test(pr)) type = 'combo';
  else if (/<w:picture\/?>/.test(pr)) type = 'picture';
  else if (/<w:text\b/.test(pr) || /<w:text\/>/.test(pr)) type = 'text';
  const options = [];
  const listSrc = (pr.match(/<w:(?:dropDownList|comboBox)[^>]*>([\s\S]*?)<\/w:(?:dropDownList|comboBox)>/) || [])[1] || '';
  const li = /<w:listItem[^>]*w:displayText="([^"]*)"[^>]*w:value="([^"]*)"|<w:listItem[^>]*w:value="([^"]*)"[^>]*w:displayText="([^"]*)"/g;
  let lm;
  while ((lm = li.exec(listSrc))) {
    const disp = lm[1] != null ? lm[1] : lm[4];
    const val = lm[2] != null ? lm[2] : lm[3];
    options.push({ text: disp, value: val });
  }
  return { id, alias, tag, type, options };
}

// Current text shown inside the control (first run text in sdtContent).
function currentText(outer) {
  const cM = outer.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
  const c = cM ? cM[1] : '';
  const parts = [...c.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1]);
  return parts.join('').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

// Nearest preceding plain text (section/label context) before a position.
function precedingText(xml, pos) {
  const before = xml.slice(Math.max(0, pos - 4000), pos);
  const texts = [...before.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1].trim()).filter(Boolean);
  return texts.slice(-1)[0] || '';
}

function parse(xml) {
  const blocks = findSdtBlocks(xml);
  const controls = [];
  for (const b of blocks) {
    const outer = xml.slice(b.start, b.end);
    const pr = parseSdtPr(outer);
    if (!pr.id) continue;                 // skip block-level structural sdts with no id
    if (pr.type === 'text' && !pr.alias && !/<w:text/.test(outer.slice(0,400))) {
      // block-level rich-text wrapper (the "other" ones) - skip, not a field
    }
    controls.push({
      ref: pr.id, type: pr.type, alias: pr.alias, tag: pr.tag,
      options: pr.options, value: currentText(outer),
      context: pr.alias || precedingText(xml, b.start),
      _start: b.start, _end: b.end,
    });
  }
  return controls;
}

module.exports = { parse, findSdtBlocks, parseSdtPr, currentText, xmlEscape };

// ---- FILL ----
// Rewrite the displayed text of a control's sdtContent to `value`, preserving
// all run/cell formatting. Sets the first <w:t> run, blanks any others, and
// drops the placeholder marker so Word treats it as real content.
function setSdtText(block, value) {
  // HARDENING (David, Aug 23): depending on which program last saved the
  // template, an empty control can arrive as <w:t/> (self-closed) or as
  // <w:sdtContent/> (no content at all). Neither matched the patterns below,
  // so the user's value was dropped WITHOUT ANY ERROR - the Subject Property
  // Address printed blank while the form showed it filled. Normalise both
  // shorthands to the explicit forms first so every template fills the same.
  block = block.replace(/<w:sdtContent\/>/g, '<w:sdtContent></w:sdtContent>');
  block = block.replace(/<w:t(\s[^>]*)?\/>/g, function (m, attrs) { return '<w:t' + (attrs || '') + '></w:t>'; });
  let pr = block.match(/<w:sdtPr>[\s\S]*?<\/w:sdtPr>/);
  let head = block, contentStart, contentEnd;
  const cM = block.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
  if (!cM) return block;
  let content = cM[1];
  // drop placeholder marker(s)
  block = block.replace(/<w:showingPlcHdr\/>/g, '');
  // re-read content after that replacement
  const cM2 = block.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
  content = cM2[1];
  const esc = xmlEscape(value);
  let first = true;
  const newContent = content.replace(/(<w:t)((?:\s[^>]*)?)>([\s\S]*?)(<\/w:t>)/g, (m, a, attrs, txt, close) => {
    if (first) {
      first = false;
      if (!/xml:space=/.test(attrs)) attrs = attrs + ' xml:space="preserve"';
      return a + attrs + '>' + esc + close;
    }
    return a + attrs + '>' + close; // blank the rest
  });
  if (first) {
    // no <w:t> existed - inject a run at the end of the first paragraph, or,
    // when the content has no paragraph either (inline control saved with
    // empty content), append the run directly so the value is never dropped.
    let injected = content.replace(/(<w:p\b[\s\S]*?<\/w:pPr>)/, '$1<w:r><w:t xml:space="preserve">' + esc + '</w:t></w:r>');
    if (injected === content) injected = content + '<w:r><w:t xml:space="preserve">' + esc + '</w:t></w:r>';
    return block.replace('<w:sdtContent>' + content + '</w:sdtContent>',
      '<w:sdtContent>' + injected + '</w:sdtContent>');
  }
  return block.replace('<w:sdtContent>' + content + '</w:sdtContent>', '<w:sdtContent>' + newContent + '</w:sdtContent>');
}

// Fill text/dropdown/combo controls by id. valuesByRef: { id: "value" }.
// Rebuilds the document by splitting on top-level sdt blocks (no position drift).
function fillTextControls(xml, valuesByRef) {
  const blocks = findSdtBlocks(xml);
  if (!blocks.length) return xml;
  let out = '';
  let cursor = 0;
  for (const b of blocks) {
    out += xml.slice(cursor, b.start);
    let block = xml.slice(b.start, b.end);
    const pr = parseSdtPr(block);
    if (pr.id && Object.prototype.hasOwnProperty.call(valuesByRef, pr.id) && pr.type !== 'picture') {
      // Set the control to the user's value, OR clear it when the user left it
      // blank. Clearing (rather than skipping) wipes any sample/placeholder text
      // baked into the template so blank fields print truly empty.
      const v = valuesByRef[pr.id];
      const isBlank = (v == null || String(v).trim() === '');
      // EXCEPTION: the inspection-type SECTION HEADING (a combo offering
      // VISUAL/FINAL/INVASIVE INSPECTION). The web form initialises every field
      // to blank, so if the user doesn't pick a type the heading would be cleared
      // to nothing and the whole "VISUAL INSPECTION" heading vanishes from the
      // report (David, Aug 13). A section heading must never be blank — when no
      // value is chosen, keep the template's baked default so the heading always
      // prints (still reddened + page-broken downstream). The user's own pick
      // (non-blank) always overrides.
      const isInspectionHeading = (pr.type === 'combo' || pr.type === 'dropdown')
        && pr.options.some(o => /(VISUAL|FINAL|INVASIVE)\s+INSPECTION/i.test(o.text || '')
                             || /FINAL\s+REPORT/i.test(o.text || ''));
      if (!(isBlank && isInspectionHeading)) {
        block = setSdtText(block, v == null ? '' : String(v));
      }
    }
    out += block;
    cursor = b.end;
  }
  out += xml.slice(cursor);
  return out;
}

module.exports.fillTextControls = fillTextControls;
module.exports.setSdtText = setSdtText;

// ---- PICTURE FILL ----
// Replace a picture content control's image with a supplied buffer. Adds the
// image to word/media, registers a relationship, and points the control's
// <a:blip r:embed> at it. picsByRef: { id: {buf, ext} }.
function fillPictureControls(zip, docXml, picsByRef, PizZipModule) {
  let rels = zip.file('word/_rels/document.xml.rels') ? zip.file('word/_rels/document.xml.rels').asText()
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let ct = zip.file('[Content_Types].xml').asText();
  const blocks = findSdtBlocks(docXml);
  let out = '', cursor = 0, n = 0;
  for (const b of blocks) {
    out += docXml.slice(cursor, b.start);
    let block = docXml.slice(b.start, b.end);
    const pr = parseSdtPr(block);
    const pic = pr.id && picsByRef[pr.id];
    if (pr.type === 'picture' && pic && pic.buf && pic.buf.length) {
      n++;
      const ext = (pic.ext || 'png').toLowerCase().replace('jpeg', 'jpg');
      const mediaName = 'clientformpic' + n + '.' + ext;
      zip.file('word/media/' + mediaName, pic.buf);
      if (ct.indexOf('Extension="' + ext + '"') === -1) {
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
        ct = ct.replace('</Types>', '<Default Extension="' + ext + '" ContentType="' + mime + '"/></Types>');
      }
      const relId = 'rIdClientPic' + n;
      rels = rels.replace('</Relationships>',
        '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + mediaName + '"/></Relationships>');
      // point the FIRST blip embed in this control at the new image
      block = block.replace(/(<a:blip[^>]*r:embed=")[^"]*(")/, '$1' + relId + '$2');
    }
    out += block;
    cursor = b.end;
  }
  out += docXml.slice(cursor);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', ct);
  return out;
}
module.exports.fillPictureControls = fillPictureControls;

// ---- SCHEMA (for the web editor) ----
// Strip tags to text.
function stripText(frag) {
  return [...frag.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1]).join('')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").trim();
}
// Nearest preceding meaningful label (len>1, not just punctuation).
function nearestLabel(xml, pos) {
  const before = xml.slice(Math.max(0, pos - 3000), pos);
  const toks = [...before.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1].trim());
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].replace(/[:☐☒\s]+$/,'').trim();
    if (t.length > 1 && /[A-Za-z]/.test(t)) return t;
  }
  return '';
}
// Running section heading: last ALL-CAPS-ish or bold-ish line before pos.
function currentSection(xml, pos) {
  const before = xml.slice(Math.max(0, pos - 20000), pos);
  const paras = [...before.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(m => m[0]);
  for (let i = paras.length - 1; i >= 0; i--) {
    const txt = stripText(paras[i]);
    if (!txt) continue;
    const caps = txt === txt.toUpperCase() && /[A-Z]{4,}/.test(txt) && txt.length >= 8 && txt.length <= 90;
    if (caps) return txt;
  }
  return '';
}
function buildSchema(xml) {
  const blocks = findSdtBlocks(xml);
  const fields = [];
  for (const b of blocks) {
    const outer = xml.slice(b.start, b.end);
    const pr = parseSdtPr(outer);
    if (!pr.id) continue;
    const label = pr.alias || nearestLabel(xml, b.start) || (pr.type === 'picture' ? 'Photo' : 'Field');
    fields.push({
      ref: pr.id, type: pr.type, label,
      section: currentSection(xml, b.start) || 'General',
      options: pr.options.map(o => o.value),
      value: currentText(outer),
    });
  }
  // group by section, preserving order
  const groups = [];
  const idx = {};
  for (const f of fields) {
    if (!(f.section in idx)) { idx[f.section] = groups.length; groups.push({ title: f.section, fields: [] }); }
    groups[idx[f.section]].fields.push(f);
  }
  return groups;
}
module.exports.buildSchema = buildSchema;
module.exports.stripText = stripText;

// ---- ORIGINAL-INSPECTION DATE ----
// The master has the "date of original inspection" as a hard-coded sample
// literal (e.g. "03/21/2024") sitting right after the
// "Original Inspection Report Performed by:" line - it is NOT a content
// control, so it can't be filled the normal way. Replace just that one
// literal with the supplied date (blank it when no date is available), so a
// stale sample date never prints. Anchored to the label so it can never touch
// the "Date of Final Inspection" value that appears earlier in the document.
function replaceOriginalInspectionDate(xml, dateStr) {
  const anchor = xml.indexOf('Original Inspection Report Performed by');
  if (anchor === -1) return xml;                 // no anchor -> do nothing (safe)
  const head = xml.slice(0, anchor);
  let tail = xml.slice(anchor);
  const dateRe = /(<w:t(?:\s[^>]*)?>)([^<]*?)(\d{1,2}\/\d{1,2}\/\d{2,4})([^<]*?)(<\/w:t>)/;
  const m = tail.match(dateRe);
  if (m) {
    const repl = m[1] + m[2] + xmlEscape(dateStr || '') + m[4] + m[5];
    tail = tail.slice(0, m.index) + repl + tail.slice(m.index + m[0].length);
  }
  return head + tail;
}
module.exports.replaceOriginalInspectionDate = replaceOriginalInspectionDate;

// ---- FORM LAYOUT (HTML that mirrors the document, with control tokens) ----
// Renders the body to HTML preserving tables, cell shading, headers and the
// element rows, replacing each content control with @@CTRL:<id>@@. The client
// swaps those tokens for real <select>/<input>/photo controls, so the on-site
// editor looks and reads like the actual form.
function _fhEsc(s){return String(s==null?'':s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function _fhScan(inner, wanted){
  const re=/<(w:p|w:tbl|w:tr|w:tc|w:sdt)(\s[^>]*?)?(\/?)>|<\/(w:p|w:tbl|w:tr|w:tc|w:sdt)>/g;
  const out=[]; let depth=0, startIdx=-1, startTag=null, m;
  while((m=re.exec(inner))){
    const open=m[1], selfClose=m[3]==='/', close=m[4];
    if(open){
      if(selfClose){ if(depth===0 && wanted.includes(open)) out.push({tag:open, xml:m[0]}); continue; }
      if(depth===0){ if(wanted.includes(open)){ startIdx=m.index; startTag=open; } depth=1; }
      else depth++;
    } else if(close){ depth--; if(depth===0 && startIdx!==-1 && close===startTag){ out.push({tag:close, xml:inner.slice(startIdx, re.lastIndex)}); startIdx=-1; startTag=null; } }
  }
  return out;
}
function _fhMeta(sdt){
  const pr=(sdt.match(/<w:sdtPr>([\s\S]*?)<\/w:sdtPr>/)||[])[1]||'';
  const id=(pr.match(/<w:id[^>]*w:val="(-?\d+)"/)||[])[1]||null;
  let type='text';
  if(/<w:dropDownList/.test(pr))type='dropdown'; else if(/<w:comboBox/.test(pr))type='combo'; else if(/<w:picture\/?>/.test(pr))type='picture';
  return {id,type};
}
function _fhPara(p){
  let html=''; const re=/<w:sdt>[\s\S]*?<\/w:sdt>|<w:r\b[\s\S]*?<\/w:r>/g; let m;
  while((m=re.exec(p))){
    const chunk=m[0];
    if(chunk.startsWith('<w:sdt>')){ const meta=_fhMeta(chunk); if(meta.id) html+='@@CTRL:'+meta.id+'@@'; }
    else { const t=(chunk.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)||[]).map(s=>s.replace(/<[^>]+>/g,'')).join('');
      if(!t){ if(/<w:tab\b/.test(chunk)) html+=' '; continue; }
      const bold=/<w:b\/>|<w:b\s/.test(chunk); const red=/w:color="FF0000"/i.test(chunk);
      let s=_fhEsc(t); if(bold)s='<b>'+s+'</b>'; if(red)s='<span style="color:#c00000">'+s+'</span>'; html+=s; }
  }
  return html;
}
function _fhCellStyle(tc){
  const pr=(tc.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/)||[])[1]||'';
  const fill=(pr.match(/<w:shd[^>]*w:fill="([0-9A-Fa-f]{6})"/)||[])[1];
  const span=(pr.match(/<w:gridSpan[^>]*w:val="(\d+)"/)||[])[1];
  let st='border:1px solid #b9c4d0;padding:3px 6px;vertical-align:middle;font-size:12px;';
  if(fill && fill.toUpperCase()!=='FFFFFF') st+='background:#'+fill+';';
  return {style:st, colspan: span?(' colspan="'+span+'"'):''};
}
function _fhTc(tc){
  const {style,colspan}=_fhCellStyle(tc);
  const inner=(tc.match(/<w:tc>([\s\S]*)<\/w:tc>/)||[,''])[1];
  let content=''; const kids=_fhScan(inner,['w:p','w:tbl','w:sdt']);
  for(const k of kids){
    if(k.tag==='w:sdt'){ const meta=_fhMeta(k.xml); content+= meta.id?('@@CTRL:'+meta.id+'@@'):''; }
    else if(k.tag==='w:tbl'){ content+=_fhTable(k.xml); }
    else { const t=_fhPara(k.xml); content+='<div>'+t+'</div>'; }
  }
  content=content.replace(/(<div>\s*<\/div>)+/g,'')||'&nbsp;';
  return '<td'+colspan+' style="'+style+'">'+content+'</td>';
}
function _fhRow(tr){
  const inner=(tr.match(/<w:tr\b[^>]*>([\s\S]*)<\/w:tr>/)||[,''])[1];
  const kids=_fhScan(inner,['w:tc','w:sdt']); let html='<tr>';
  for(const k of kids){
    if(k.tag==='w:tc'){ html+=_fhTc(k.xml); }
    else { const meta=_fhMeta(k.xml); const innerTc=(k.xml.match(/<w:tc>[\s\S]*<\/w:tc>/)||[])[0];
      const {style,colspan}= innerTc?_fhCellStyle(innerTc):{style:'border:1px solid #b9c4d0;padding:3px 6px;font-size:12px;',colspan:''};
      html+='<td'+colspan+' style="'+style+'">'+(meta.id?('@@CTRL:'+meta.id+'@@'):'')+'</td>'; }
  }
  return html+'</tr>';
}
function _fhTable(tbl){
  const rows=_fhScan((tbl.match(/<w:tbl>([\s\S]*)<\/w:tbl>/)||[,''])[1],['w:tr']);
  return '<table style="border-collapse:collapse;width:100%;margin:8px 0">'+rows.map(r=>_fhRow(r.xml)).join('')+'</table>';
}
function renderFormHtml(xml){
  let inner=(xml.match(/<w:body>([\s\S]*)<\/w:body>/)||[,''])[1];
  inner=inner.replace(/<w:sectPr[\s\S]*$/,'');
  const kids=_fhScan(inner,['w:p','w:tbl','w:sdt']); let html='';
  for(const k of kids){
    if(k.tag==='w:tbl') html+=_fhTable(k.xml);
    else if(k.tag==='w:sdt'){ const meta=_fhMeta(k.xml); if(meta.id) html+='<div>@@CTRL:'+meta.id+'@@</div>'; }
    else { const t=_fhPara(k.xml); if(t.trim()) html+='<p style="margin:6px 0;font-size:12px">'+t+'</p>'; }
  }
  return html;
}
// Colour class of a control from the run colour in its block.
// green = 'good condition' fields (00B050/008000); red = editable fields
// (FF0000/EE0000); everything else = other.
function controlColor(block){
  const cols=(block.match(/<w:color w:val="([0-9A-Fa-f]{6})"/g)||[]).map(s=>s.replace(/.*val="([0-9A-Fa-f]{6})".*/,'$1').toUpperCase());
  if(cols.includes('00B050')||cols.includes('008000')) return 'green';
  if(cols.includes('FF0000')||cols.includes('EE0000')) return 'red';
  return 'other';
}
// Group controls by their enclosing table row so the "Repairs Completed =
// NO/IN PROGRESS turns the row's green fields red" rule can be applied.
// Returns { rowByRef:{id:rowKey}, rows:[{key, rcRef, greenRefs:[...], refs:[...]}] }.
function rowGroups(xml){
  const rowByRef={}; const rows=[]; let key=0;
  const body=(xml.match(/<w:body>([\s\S]*)<\/w:body>/)||[,''])[1];
  const tbls=_fhScan(body,['w:tbl']);
  for(const t of tbls){
    const trs=_fhScan((t.xml.match(/<w:tbl>([\s\S]*)<\/w:tbl>/)||[,''])[1],['w:tr']);
    for(const tr of trs){
      const blocks=findSdtBlocks(tr.xml);
      if(!blocks.length) continue;
      const row={key:'r'+(key++), rcRef:null, greenRefs:[], refs:[]};
      for(const b of blocks){
        const outer=tr.xml.slice(b.start,b.end);
        const pr=parseSdtPr(outer); if(!pr.id) continue;
        rowByRef[pr.id]=row.key; row.refs.push(pr.id);
        if((pr.alias||'').trim().toLowerCase()==='repairs completed') row.rcRef=pr.id;
        if(controlColor(outer)==='green') row.greenRefs.push(pr.id);
      }
      rows.push(row);
    }
  }
  return { rowByRef, rows };
}
function buildLayout(xml){
  const controls={};
  const rg=rowGroups(xml);
  const rcByRow={};
  for(const c of parse(xml)){
    const outer=xml.slice(c._start, c._end);
    const row = rg.rowByRef[c.ref]||null;
    const isRC = (c.alias||'').trim().toLowerCase()==='repairs completed';
    controls[c.ref]={
      type:c.type, options:(c.options||[]).map(o=>o.value), value:c.value||'',
      alias:c.alias||'', context:c.context||'',
      color:controlColor(outer),
      row: row,
      isRepairsCompleted: isRC,
    };
    if(isRC && row) rcByRow[row]=c.ref; // derive directly from controls (robust)
  }
  return { html: renderFormHtml(xml), controls, rcByRow };
}

// Replace the branding company name in body text. Longest first so
// "Deck Inspectors, Inc." is handled before "Deck Inspectors".
function substituteCompany(str, name){
  if(!name) return str;
  const clean=String(name).trim();
  if(!clean || /^deck inspectors/i.test(clean)) return str; // no change for Deck itself
  return str
    .replace(/Deck Inspectors,?\s*Inc\.?/g, clean)
    .replace(/Deck Inspectors/g, clean);
}
// Same, but only inside <w:t> text runs of the document XML. Also handles the
// case where "Deck Inspectors" is split across two runs (Word does this).
function substituteCompanyInDoc(xml, name){
  if(!name || /^deck inspectors/i.test(String(name).trim())) return xml;
  const clean=String(name).trim();
  // Cross-run: "Deck</w:t> ... <w:t>Inspectors[, Inc.]" -> company name in the
  // first run, second run's phrase text emptied (its tags/formatting kept).
  xml = xml.replace(/Deck(\s*<\/w:t>[\s\S]{0,300}?<w:t(?:\s[^>]*)?>)\s*Inspectors,?\s*(?:Inc\.?)?/g, (m, gap) => clean + gap);
  // Dropdown OPTION text/values (e.g. "Report Performed by" -> Deck Inspectors)
  // so the client's name shows as the option and selected value.
  const attrEsc = clean.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  xml = xml.replace(/(w:(?:displayText|value)=")Deck Inspectors,?\s*(?:Inc\.?)?\s*(")/g, '$1' + attrEsc + '$2');
  // Same-run visible text occurrences.
  return xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (m,a,txt,z)=> a+substituteCompany(txt,name)+z);
}

// Force every run inside a control's sdtContent to a given colour (6-hex) and
// bold on/off, preserving everything else. rPr must stay the first child of run.
function _styleRunRpr(rpr, hex, bold){
  // OOXML requires a specific child order in <w:rPr> (rStyle, rFonts, b, ...,
  // color, ...). Word tolerates a wrong order but strict browser renderers drop
  // the run, so insert b/color AFTER any leading rStyle/rFonts.
  const headRe=/^(\s*(?:<w:rStyle\b[^>]*\/>)?\s*(?:<w:rFonts\b[^>]*\/>)?)/;
  // colour: replace existing, else insert just after rStyle/rFonts
  if(/<w:color\b[^>]*\/>/.test(rpr)) rpr=rpr.replace(/<w:color\b[^>]*\/>/, '<w:color w:val="'+hex+'"/>');
  else { const m=rpr.match(headRe); const head=m?m[1]:''; rpr=head+'<w:color w:val="'+hex+'"/>'+rpr.slice(head.length); }
  // bold: drop existing toggles, then (if bold) insert after rStyle/rFonts so
  // it precedes colour per schema.
  rpr=rpr.replace(/<w:b\/>|<w:b\s[^>]*\/>|<w:b><\/w:b>/g,'').replace(/<w:bCs\/>/g,'');
  if(bold){ const m=rpr.match(headRe); const head=m?m[1]:''; rpr=head+'<w:b/><w:bCs/>'+rpr.slice(head.length); }
  return rpr;
}
function setBlockColor(block, hex, bold){
  const cM=block.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
  if(!cM) return block;
  const content=cM[1].replace(/(<w:r(?:\s[^>]*)?>)([\s\S]*?)(<\/w:r>)/g, (m, open, inner, close)=>{
    const rM=inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    if(rM) inner=inner.replace(rM[0], '<w:rPr>'+_styleRunRpr(rM[1], hex, bold)+'</w:rPr>');
    else inner='<w:rPr>'+_styleRunRpr('', hex, bold)+'</w:rPr>'+inner;
    return open+inner+close;
  });
  return block.replace(cM[0], '<w:sdtContent>'+content+'</w:sdtContent>');
}

// Inspection-overview colour rule (David, Aug 9):
//  - No repairs required (Repairs Required = NO/NA/blank)   -> line BLACK.
//  - Repairs required (Repairs Required = YES)              -> line RED.
//      - and repairs made (Repairs Completed = YES)         -> line GREEN BOLD.
//  - Any Life Expectancy cell showing "0-1"                 -> RED BOLD (override).
// Applies per element row (Building, Stairs, Walkways, Balconies, Entry Decks,
// Railings, custom row) to the Repairs/Condition/EEE/LBC/AWE cells.
function applyConditionalColors(xml, values){
  const rg=rowGroups(xml);
  const blocks=findSdtBlocks(xml);
  const info={};
  for(const b of blocks){
    const outer=xml.slice(b.start,b.end);
    const pr=parseSdtPr(outer); if(pr.id==null) continue;
    info[pr.id]={ alias:(pr.alias||'').trim().toLowerCase(), row: rg.rowByRef[pr.id]||null, cur: currentText(outer) };
  }
  const val=(ref)=>{ const v=(values && values[ref]!=null && values[ref]!=='') ? values[ref] : (info[ref]?info[ref].cur:''); return String(v||'').trim(); };
  const byRow={};
  for(const ref of Object.keys(info)){ const r=info[ref].row; if(!r) continue; (byRow[r]=byRow[r]||[]).push(ref); }
  const COLS=['repairs required','repairs completed','condition','eee','lbc','awe'];
  const LIFE=['eee','lbc','awe'];
  const RED='FF0000', GREEN='00B050', BLACK='000000';
  const colorOf={}, boldOf={};
  for(const r of Object.keys(byRow)){
    const refs=byRow[r];
    let rrRef=null, rcRef=null;
    for(const ref of refs){ const a=info[ref].alias; if(a==='repairs required') rrRef=ref; if(a==='repairs completed') rcRef=ref; }
    if(!rrRef && !rcRef) continue; // not an inspection-overview row
    const rr=(rrRef?val(rrRef):'').toUpperCase();
    const rc=(rcRef?val(rcRef):'').toUpperCase();
    let lineColor=BLACK, lineBold=false;
    // Repairs required: red. If made -> green bold; if NOT made -> red BOLD.
    if(rr==='YES'){ if(rc==='YES'){ lineColor=GREEN; lineBold=true; } else { lineColor=RED; lineBold=true; } }
    for(const ref of refs){
      const a=info[ref].alias;
      if(COLS.indexOf(a)===-1) continue;
      let col=lineColor, bold=lineBold;
      if(LIFE.indexOf(a)!==-1 && val(ref)==='0-1'){ col=RED; bold=true; }
      colorOf[ref]=col; boldOf[ref]=bold;
    }
  }
  // Value-based colour for any OTHER control: PASS / GOOD -> green,
  // FAIL / BAD -> red (e.g. the Decks & Railings PASS/FAIL result and the
  // "in Good/BAD Condition" statements). Matrix cells already coloured above.
  for(const ref of Object.keys(info)){
    if(colorOf[ref]!=null) continue;
    const v=val(ref).toUpperCase();
    if(!v || v==='NA') continue;
    if(/^PASS$/.test(v) || /\bGOOD\b/.test(v)){ colorOf[ref]=GREEN; boldOf[ref]=true; }
    else if(/^FAIL$/.test(v) || /\bBAD\b/.test(v)){ colorOf[ref]=RED; boldOf[ref]=true; }
  }
  if(!Object.keys(colorOf).length) return xml;
  let out='', cursor=0;
  for(const b of blocks){
    out+=xml.slice(cursor,b.start);
    let block=xml.slice(b.start,b.end);
    const id=parseSdtPr(block).id;
    if(id!=null && colorOf[id]!=null) block=setBlockColor(block, colorOf[id], boldOf[id]);
    out+=block; cursor=b.end;
  }
  out+=xml.slice(cursor);
  return out;
}

// Client Photo Submission / Invasive "Review of Repairs" checklist colour rule
// (David, Aug 10). Each checklist row = [checkbox] [location label] [status
// dropdown]. The master baked inconsistent SAMPLE colours (some rows all red,
// some all black) that did NOT follow the chosen value. Normalise every such
// row the same way, form-wide:
//   - the LOCATION LABEL and the CHECKBOX are always BLACK;
//   - the STATUS value follows the selection: a submission / review value
//     ("Photos Submitted", "On Site Visual Review") -> RED; "NA" or blank
//     -> BLACK.
// Target rows are found by their status dropdown, which offers a
// "Photos Submitted" option (8 of them across the whole form).
function applyReviewRepairColors(xml){
  const RED='FF0000', BLACK='000000';
  const isValueDropdown=(sdt)=>{
    const pr=parseSdtPr(sdt);
    return pr.type==='dropdown' && pr.options.some(o=>/Photos\s*Submitted/i.test(o.text));
  };
  // enclosing <w:tr>..</w:tr> for a position (skip <w:trPr>)
  function enclosingRow(pos){
    let i=pos, found=-1;
    while((i=xml.lastIndexOf('<w:tr', i))!==-1){
      const nx=xml.charAt(i+5);
      if(nx==='>' || nx===' '){ found=i; break; }
      if(i===0) break; i--;
    }
    if(found===-1) return null;
    const end=xml.indexOf('</w:tr>', pos);
    if(end===-1) return null;
    return {start:found, end:end+7};
  }
  const blocks=findSdtBlocks(xml);
  const rowStarts=new Map();
  for(const b of blocks){
    const outer=xml.slice(b.start,b.end);
    if(!isValueDropdown(outer)) continue;
    const row=enclosingRow(b.start);
    if(!row) continue;
    rowStarts.set(row.start, row);
  }
  if(!rowStarts.size) return xml;
  // Rebuild each row last-first so earlier offsets stay valid.
  const rows=[...rowStarts.values()].sort((a,b)=>b.start-a.start);
  for(const r of rows){
    let row=xml.slice(r.start, r.end);
    // 1) neutralise every explicit run/paragraph colour in the row to black
    row=row.replace(/<w:color\s+w:val="[0-9A-Fa-f]{6}"\s*\/>/g, '<w:color w:val="'+BLACK+'"/>');
    // 2) re-colour just the status dropdown(s) red when the choice is a
    //    submission / review value (anything other than NA / blank).
    row=row.replace(/<w:sdt>[\s\S]*?<\/w:sdt>/g, (sdt)=>{
      if(!isValueDropdown(sdt)) return sdt;
      const cur=currentText(sdt).trim().toUpperCase();
      if(cur!=='' && cur!=='NA') return setBlockColor(sdt, RED, false);
      return sdt;
    });
    xml = xml.slice(0, r.start) + row + xml.slice(r.end);
  }
  return xml;
}

// Clean up the report's pagination + spacing so it looks professional without
// hand-nudging text (David, Aug 13). The template has NO page breaks (pagination
// was purely content-height driven) and ~95 empty "spacer" paragraphs that
// create big uneven gaps and orphan headings. This does three things:
//   1) Break before each major section so it starts at the top of a page. Two-
//      line headings (VISUAL INSPECTION + REPAIRS - NOTATIONS & CONCLUSION) are
//      kept together by breaking before the FIRST line - found reliably by
//      walking back from the static "REPAIRS - NOTATIONS" anchor past the
//      Title-styled heading line(s), so it works even after the dropdown line is
//      filled and no longer matches an ALL-CAPS test.
//   2) Restore the red colour on the VISUAL INSPECTION heading line (the dropdown
//      fill strips it to black).
//   3) Collapse runs of consecutive blank spacer paragraphs so gaps are a single
//      consistent line (and zero right before a page break). Blanks are collapsed
//      to ~0 height, never deleted, so table-separator paragraphs stay valid.
function applyPageBreaks(xml){
  const BREAK='<w:pageBreakBefore/>';
  const NEARZERO='<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/>';
  const RED='FF0000';
  const paraText = (p)=> (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)||[])
    .map(t=>t.replace(/<[^>]+>/g,'')).join('')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
  const isTitle = (p)=> /<w:pStyle w:val="Title"\/>/.test(p);
  const isHeadingLine = (p)=>{ const t=paraText(p); return isTitle(p) && t.length>=2 && t.length<=70; };
  const isCapsTitle = (p)=>{
    if(!isTitle(p)) return false;
    const t = paraText(p); if(t.length<3 || t.length>70) return false;
    const letters = t.replace(/[^A-Za-z]/g,'');
    return letters.length>=3 && t===t.toUpperCase();
  };
  const REPAIRS_NOTATIONS = (p)=> /REPAIRS\s*[–—-]\s*NOTATIONS/.test(paraText(p).toUpperCase());
  const isNamed = (p)=>{
    const t = paraText(p).toUpperCase();
    return REPAIRS_NOTATIONS(p)
        || /COMMENTS\s*-\s*RECOMMENDATIONS/.test(t)
        || /^REVIEW OF REPAIRS/.test(t)
        || /INVASIVE INSPECTION OF REPAIRS/.test(t);
  };
  const isBlank = (p)=> paraText(p)==='' && !/<w:sdt\b/.test(p) && !/<w:drawing\b/.test(p)
    && !/<w:pict\b/.test(p) && !/<w:tbl\b/.test(p) && !/<w:bookmarkStart\b/.test(p);
  const addBreak = (p)=>{
    if(/<w:pageBreakBefore/.test(p)) return p;
    if(/<w:pStyle\b[^>]*\/>/.test(p)) return p.replace(/(<w:pPr>\s*<w:pStyle\b[^>]*\/>)/, '$1'+BREAK);
    if(/<w:pPr>/.test(p)) return p.replace(/<w:pPr>/, '<w:pPr>'+BREAK);
    return p.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr>'+BREAK+'</w:pPr>');
  };
  const collapse = (p)=>{
    let q = p.replace(/<w:spacing\b[^>]*\/>/g,'');
    if(/<w:pStyle\b[^>]*\/>/.test(q)) return q.replace(/(<w:pPr>\s*<w:pStyle\b[^>]*\/>)/, '$1'+NEARZERO);
    if(/<w:pPr>/.test(q)) return q.replace(/<w:pPr>/, '<w:pPr>'+NEARZERO);
    return q.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr>'+NEARZERO+'</w:pPr>');
  };
  // Force every run in the paragraph to red (used to restore the VISUAL
  // INSPECTION heading colour the dropdown fill removed). Inserts colour after
  // any leading rStyle/rFonts to keep the schema order valid.
  const redden = (p)=> p.replace(/(<w:r(?:\s[^>]*)?>)([\s\S]*?)(<\/w:r>)/g, (m,o,inner,c)=>{
    const rm = inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    let body = rm ? rm[1] : '';
    body = body.replace(/<w:color\b[^>]*\/>/g,'');
    // Insert <w:color> in the schema-correct slot: AFTER every rPr child that
    // must precede color (rStyle, rFonts, b, i, caps, strike, etc.) and BEFORE
    // spacing/sz/u. Word silently drops a mis-ordered color (e.g. rFonts->color->b),
    // which is why the heading rendered black even though the run carried FF0000.
    const head = (body.match(/^((?:\s*<w:(?:rStyle|rFonts|b|bCs|i|iCs|caps|smallCaps|strike|dstrike|outline|shadow|emboss|imprint|noProof|snapToGrid|vanish|webHidden)\b[^>]*\/>)*\s*)/)||['',''])[1];
    body = head + '<w:color w:val="'+RED+'"/>' + body.slice(head.length);
    const newRpr = '<w:rPr>'+body+'</w:rPr>';
    inner = rm ? inner.replace(rm[0], newRpr) : newRpr+inner;
    return o+inner+c;
  });

  // Keep a paragraph with the next one (used so the signature block doesn't sit
  // alone on the last page - the paragraphs above it flow down with it).
  const addKeepNext = (p)=>{
    if(/<w:keepNext\/>/.test(p)) return p;
    if(/<w:pStyle\b[^>]*\/>/.test(p)) return p.replace(/(<w:pPr>\s*<w:pStyle\b[^>]*\/>)/, '$1<w:keepNext/>');
    if(/<w:pPr>/.test(p)) return p.replace(/<w:pPr>/, '<w:pPr><w:keepNext/>');
    return p.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr><w:keepNext/></w:pPr>');
  };

  const matches = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)];
  if(!matches.length) return xml;
  const caps  = matches.map(m=>isCapsTitle(m[0]));
  const blank = matches.map(m=>isBlank(m[0]));

  // Signature block: pull the last few paragraphs before the signature table
  // onto the signature's page (keepNext) so it's never a page by itself.
  const keepNextIdx = new Set();
  let sigStart = -1;
  for(const t of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)){
    if(/Inspector Name/.test(t[0]) && /Signature/.test(t[0])){ sigStart = t.index; break; }
  }
  if(sigStart >= 0){
    const before = [];
    matches.forEach((m,k)=>{ if(m.index < sigStart) before.push(k); });
    before.slice(-4).forEach(k=>keepNextIdx.add(k));   // ~2 paragraphs + spacers flow with the table
  }

  // 1) Resolve section break points (walk back past the heading line group).
  const breakIdx = new Set(), redIdx = new Set();
  matches.forEach((m,i)=>{
    const trig = isNamed(m[0]) || (caps[i] && !caps[i-1]);
    if(!trig) return;
    let b = i;
    while(b-1>=0 && isHeadingLine(matches[b-1][0])) b--;   // topmost line of the heading block
    breakIdx.add(b);
    if(REPAIRS_NOTATIONS(m[0])){ for(let k=b;k<=i;k++) redIdx.add(k); } // redden VISUAL INSPECTION block
  });

  // 2) Collapse blank runs: keep the first blank of a run at its natural height,
  //    collapse the rest; collapse the WHOLE run when it sits right before a page
  //    break (so there is no gap at the top of the broken page).
  const collapseIdx = new Set();
  let i = 0;
  while(i < matches.length){
    if(blank[i]){
      let j = i; while(j+1<matches.length && blank[j+1]) j++;   // run [i..j]
      const beforeBreak = breakIdx.has(j+1);
      const from = beforeBreak ? i : i+1;                        // keep first unless before a break
      for(let k=from;k<=j;k++) collapseIdx.add(k);
      i = j+1;
    } else i++;
  }

  if(!breakIdx.size && !collapseIdx.size && !keepNextIdx.size) return xml;
  let out='', cursor=0;
  matches.forEach((m,idx)=>{
    out += xml.slice(cursor, m.index);
    let p = m[0];
    if(collapseIdx.has(idx)) p = collapse(p);
    if(redIdx.has(idx))      p = redden(p);
    if(keepNextIdx.has(idx)) p = addKeepNext(p);
    if(breakIdx.has(idx))    p = addBreak(p);
    out += p; cursor = m.index + m[0].length;
  });
  return out + xml.slice(cursor);
}

// The Invasive "Repair documentation, invoices and photos..." cell is locked to
// an exact 2.5in (3600-twip) row height, leaving a big blank area above the one
// line of text. Halve that row's fixed height so it fits nicely (David, Aug 13).
// Targets ONLY that row (found by its text), never the other fixed-height cells.
function tightenTallCells(xml){
  return xml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (row)=>{
    const flat = row.replace(/<[^>]+>/g,'').replace(/\s+/g,' ');
    if(!/invoices/i.test(flat) && !/repair documentation/i.test(flat)) return row;
    return row.replace(/(<w:trHeight\b[^>]*\bw:val=")(\d+)(")/g,
      (m,a,v,b)=> a + Math.max(720, Math.round(parseInt(v,10)/2)) + b);
  });
}

// Flatten every content control (<w:sdt>) to its inner content, for the PDF
// path ONLY. LibreOffice (the Gotenberg PDF engine) renders the TEXT of a
// content control but DROPS the run colour inside it - so the whole colour
// scheme (green "repairs made" rows, red PASS/FAIL, the red VISUAL INSPECTION
// heading) came out black in the PDF even though it is correct in the Word
// download. Stripping the <w:sdt>/<w:sdtPr>/<w:sdtEndPr>/<w:sdtContent> wrapper
// and keeping the runs (text + colour + checkbox glyph) makes LibreOffice
// honour the colours. Iterative so nested controls collapse innermost-first.
// The Word download keeps real editable controls (this is not called there).
function flattenContentControls(xml){
  let prev;
  do {
    prev = xml;
    xml = xml.replace(/<w:sdt>(?:(?!<w:sdt>)[\s\S])*?<\/w:sdt>/g, (sdt)=>{
      const m = sdt.match(/<w:sdtContent>([\s\S]*)<\/w:sdtContent>/);
      return m ? m[1] : sdt;
    });
  } while (xml !== prev);
  return xml;
}

module.exports.flattenContentControls = flattenContentControls;
module.exports.tightenTallCells = tightenTallCells;
module.exports.applyPageBreaks = applyPageBreaks;
module.exports.applyReviewRepairColors = applyReviewRepairColors;
module.exports.renderFormHtml = renderFormHtml;
module.exports.buildLayout = buildLayout;
module.exports.controlColor = controlColor;
module.exports.rowGroups = rowGroups;
module.exports.substituteCompany = substituteCompany;
module.exports.substituteCompanyInDoc = substituteCompanyInDoc;
module.exports.applyConditionalColors = applyConditionalColors;
