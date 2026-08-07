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
  if (/<w:dropDownList/.test(pr)) type = 'dropdown';
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
    // no <w:t> existed - inject a run at the end of the first paragraph
    return block.replace('<w:sdtContent>' + content + '</w:sdtContent>',
      '<w:sdtContent>' + content.replace(/(<w:p\b[\s\S]*?<\/w:pPr>)/, '$1<w:r><w:t xml:space="preserve">' + esc + '</w:t></w:r>') + '</w:sdtContent>');
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
      const v = valuesByRef[pr.id];
      if (v != null && v !== '') block = setSdtText(block, v);
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
function buildLayout(xml){
  const controls={};
  for(const c of parse(xml)){
    controls[c.ref]={ type:c.type, options:(c.options||[]).map(o=>o.value), value:c.value||'' };
  }
  return { html: renderFormHtml(xml), controls };
}
module.exports.renderFormHtml = renderFormHtml;
module.exports.buildLayout = buildLayout;
