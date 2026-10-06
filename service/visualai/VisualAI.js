// VISUAL REPORT - Claude draft (David, Oct 6 2026).
// Same pattern as the Review Report (service/review/ReviewAI.js):
//   1. one Claude call PER SECTION: the inspector's photos + field entries ->
//      every Visual Report field for that section (tool fill_section);
//   2. one SUMMARY call (text only): all section drafts + E3 counts -> the Final
//      Report cover, Inspection Overview and the Additional Comments summary
//      (tool fill_summary).
// tool_choice must be 'auto' (claude-opus-5-5 rejects a forced tool). Nothing is
// written to the inspection until the inspector clicks Apply on screen.
'use strict';
const axios = require('axios');
const V = require('./visualSchema');

const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_PHOTOS = 8;              // the Visual Report prints at most 8 per section
const URL_IMAGE_MAX = 3.5 * 1024 * 1024;  // larger photos are shrunk here first

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function modelName() { return (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim(); }
const stoppedError = () => { const e = new Error('stopped'); e.stopped = true; return e; };

const DEFINITIONS = `DEFINITIONS (from the company's Final Report - use them exactly):
- "Bad": the surface is in such poor condition that it failed a visual inspection.
- "Fair": reasonably adequate condition but may require further invasive review.
- "Good": visually appears well maintained, devoid of conditions requiring further invasive review.
- "Further Invasive Review": additional inspection required by an inability to conduct a visual inspection, or by signs of moisture intrusion or damage revealed by the visual inspection.
- "Signs of leaks": possible moisture or water penetration through waterproof barriers into the structure.
- Life expectancy: EEE = the exterior elevated element; LBC = load-bearing components; AWE = associated waterproofing elements.
- Condition Assessment "Fail" => life expectancy 0-1 Years for EEE, LBC and AWE (lack of, or a failed, waterproof membrane).
- Elements repaired with waterproofing applied => 1-4 Years for EEE, LBC and AWE (maintainable with annual or bi-annual inspection and maintenance).
- Load-bearing components where waterproofing does not appear or is not confirmed => LBC 0-1 Years.
- The actual age of the property is unknown, so never give more than "7-10 Years"; use it only for elements in clearly excellent condition.
- "Unsafe condition" = an element posing an immediate threat to the safety of the occupants (access should be prevented / emergency repairs or shoring). Use it rarely and only on clear evidence.
- "Future Inspection" assessment: the element could not be fully evaluated now (blocked, covered, inaccessible).`;

function sectionSystem(company) {
  return `You are a California exterior elevated element (EEE) inspector writing the Visual Inspection Report for ${company || 'the inspection company'} under SB 721 (Health & Safety Code 17973, apartments) / SB 326 (Civil Code 5551, HOA / condominiums). For ONE inspected section you receive the inspector's photographs and the inspector's own field entries, and you draft every field of that section by calling fill_section exactly once.

${DEFINITIONS}

RULES:
- The inspector was on site; the photos show only part of what they saw. Treat the inspector's entries as first-hand observations. Re-draft every field, but change a rating against the inspector's entry only when the photos or notes clearly support it, and say so in "note".
- Describe only what the photos and notes support: visible wood rot, deterioration, cracks, failed or missing coatings, rust, loose or damaged railings, flashing and integration defects, ponding, staining. Do not invent conditions or measurements.
- Visual Review, Condition Assessment and life expectancy must agree: Bad => Fail => 0-1 Years for EEE, LBC and AWE.
- Do not cite current-code dimensional criteria (railing height, baluster spacing, slope) as defects of existing elements.
- additionalconsiderations is printed in the report: 2-5 short, plain, professional sentences - what was observed, where, and the recommendation (repair, maintain, further invasive review). No markdown, no bullets, no photo numbers, no mention of AI.
- exteriorelements / waterproofingelements: short names (e.g. ${V.EXTERIOR.slice(0, 6).join(', ')} / ${V.WATERPROOF.join(', ')}); keep the inspector's names where they are right.`;
}

function summarySystem(company) {
  return `You are completing the first pages of the Final Report of a California EEE Visual Inspection for ${company || 'the inspection company'}: the property counts and checkboxes, the reason for exclusion, the Inspection Overview table (one row per element type: type of construction + conditions noted, chosen ONLY from the dropdown options given), and the Additional Comments. You receive every section of the inspection (already drafted) and the E3 project data. Call fill_summary exactly once.

${DEFINITIONS}

RULES:
- propertyType: Apartment (SB 721) or HOA / Condominium (SB 326), from the project name/description (e.g. "Apartments" => apartment; "HOA", "Association", "Condominium", "Villas HOA" => HOA). For apartments unit counts are not applicable (totalUnitCount "N/A"); for HOA give the total unit count only if the data states it, else "NA".
- checks: which EEE types and waterproofing elements were reviewed; allInspectedYes when every unit with EEE has an inspected section, allInspectedNo when units were unavailable / not accessible.
- overview: for each row pick the option that best describes the typical construction and the conditions noted on average; "None" / "N/A" when that element type is not present.
- comments1 (printed in "Additional Comments"): a summary of the findings and conclusions ON AVERAGE across the whole inspection - how many sections were inspected, the overall condition (how many Good / Fair / Bad, Pass / Fail), the recurring conditions found, the elements and locations that need repair or further invasive review, any immediate threats, and the typical life expectancy. 4-8 plain sentences, no markdown, no bullets.
- comments2: recommended next steps (repairs, further invasive review, maintenance, Final Inspection after repairs) in 1-4 sentences, or empty.
- Plain professional English. Do not mention AI.`;
}

// ---------- photos ----------
// Shrinking a 12 MP photo with jimp takes ~3 s of CPU, so it runs in a worker
// thread - the web server keeps answering other users meanwhile.
const { Worker } = require('worker_threads');
const SHRINK_SRC = `
const { parentPort, workerData } = require('worker_threads');
const Jimp = require(workerData.jimp);
Jimp.read(Buffer.from(workerData.buf), (e, img) => {
  if (e) { parentPort.postMessage({ error: e.message }); return; }
  const w = img.bitmap.width, h = img.bitmap.height, k = 1280 / Math.max(w, h);
  if (k < 1) img.resize(Math.round(w * k), Math.round(h * k));
  img.quality(75);
  img.getBuffer(Jimp.MIME_JPEG, (e2, b) => parentPort.postMessage(e2 ? { error: e2.message } : { buf: b }));
});`;
function shrink(buf) {
  return new Promise((ok, bad) => {
    const w = new Worker(SHRINK_SRC, { eval: true, workerData: { buf, jimp: require.resolve('jimp') } });
    const t = setTimeout(() => { w.terminate(); bad(new Error('photo resize timed out')); }, 60000);
    w.once('message', m => { clearTimeout(t); w.terminate(); m.error ? bad(new Error(m.error)) : ok(Buffer.from(m.buf)); });
    w.once('error', e => { clearTimeout(t); bad(e); });
  });
}
async function photoBlock(url, forceInline) {
  let u; try { u = new URL(String(url)); } catch (e) { return null; }
  let size = 0;
  if (!forceInline) {
    try { const h = await axios.head(u.href, { timeout: 15000 }); size = parseInt(h.headers['content-length'] || '0', 10); } catch (e) { size = 0; }
    if (size > 0 && size <= URL_IMAGE_MAX && /\.blob\.core\.windows\.net$/.test(u.hostname)) {
      return { type: 'image', source: { type: 'url', url: u.href } };
    }
  }
  try {
    const r = await axios.get(u.href, { responseType: 'arraybuffer', timeout: 30000 });
    let buf = Buffer.from(r.data);
    if (buf.length > 25 * 1024 * 1024) return null;
    let media = /png/i.test(r.headers['content-type'] || '') ? 'image/png' : 'image/jpeg';
    if (buf.length > 1.2 * 1024 * 1024) { buf = await shrink(buf); media = 'image/jpeg'; }
    return { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
  } catch (e) { return null; }
}

// ---------- one Claude call with one tool ----------
async function callTool({ system, content, toolName, toolSchema, maxTokens, signal }) {
  const body = {
    model: modelName(), max_tokens: maxTokens || 8000, system,
    tools: [{ name: toolName, description: 'Return the drafted fields.', input_schema: toolSchema }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  };
  let resp;
  try {
    resp = await axios.post(API_URL, body, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 10 * 60 * 1000, maxBodyLength: Infinity, maxContentLength: Infinity, signal,
    });
  } catch (err) {
    if (signal && signal.aborted) throw stoppedError();
    const d = err.response && err.response.data;
    const e = new Error('Claude API: ' + ((d && d.error && d.error.message) || err.message));
    e.status = err.response && err.response.status;
    throw e;
  }
  const msg = resp.data || {};
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === toolName);
  if (!tool) { const e = new Error('Claude did not return the fields (stop: ' + msg.stop_reason + ').'); e.noTool = true; e.usage = msg.usage; throw e; }
  return { input: tool.input || {}, usage: msg.usage || {}, model: msg.model || modelName() };
}

// Retry: a missing tool call, a 429/5xx/overloaded, or a photo URL Claude could not fetch.
async function withRetry(fn, signal) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal && signal.aborted) throw stoppedError();
    try { return await fn(attempt); } catch (e) {
      if (e.stopped) throw e;
      last = e;
      const retryable = e.noTool || [429, 500, 502, 503, 504, 529].includes(e.status) || /overloaded|download|fetch|url/i.test(e.message);
      if (!retryable) throw e;
      await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw last;
}

function addUsage(total, u) {
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].forEach(k => { total[k] = (total[k] || 0) + (u[k] || 0); });
  return total;
}

// sec = { id, building, location, locationType, name, current:{...inspector fields}, images:[urls], unitUnavailable }
async function draftSection({ sec, project, company, signal }) {
  const urls = (sec.images || []).slice(0, MAX_PHOTOS);
  return withRetry(async attempt => {
    const imgs = [];
    for (const u of urls) {
      if (signal && signal.aborted) throw stoppedError();
      const b = await photoBlock(u, attempt > 0);   // a retry sends every photo inline
      if (b) imgs.push(b);
    }
    const content = [{ type: 'text', text:
      `Project: ${project.name}${project.address ? ' - ' + project.address : ''}\n` +
      (project.description ? `Project description: ${project.description}\n` : '') +
      `Location: ${[sec.building, sec.locationType, sec.location].filter(Boolean).join(' / ')}\nSection: ${sec.name}\n\n` +
      `INSPECTOR'S FIELD ENTRIES (JSON):\n${JSON.stringify(sec.current, null, 1)}\n\n` +
      `${imgs.length} photograph(s) of this section follow${(sec.images || []).length > MAX_PHOTOS ? ` (the first ${MAX_PHOTOS} of ${(sec.images || []).length})` : ''}.` }];
    imgs.forEach((b, i) => { content.push({ type: 'text', text: `Photo ${i + 1}:` }); content.push(b); });
    content.push({ type: 'text', text: 'Now call fill_section with every field for this section.' });
    const r = await callTool({ system: sectionSystem(company), content, toolName: 'fill_section', toolSchema: V.sectionToolSchema(), maxTokens: 8000, signal });
    return { draft: V.normalizeSection(r.input), usage: r.usage, model: r.model, photosSent: imgs.length };
  }, signal);
}

async function draftSummary({ project, sectionsOut, counts, master, company, signal }) {
  const compact = sectionsOut.map(x => ({
    building: x.building, location: x.location, locationType: x.locationType, section: x.name, unitUnavailable: !!x.unitUnavailable,
    elements: (x.draft.exteriorelements || []).join(', '), waterproofing: (x.draft.waterproofingelements || []).join(', '),
    review: x.draft.visualreview, leaks: x.draft.visualsignsofleak, invasive: x.draft.furtherinvasivereviewrequired,
    unsafe: x.draft.unsafecondition, assessment: x.draft.conditionalassessment, eee: x.draft.eee, lbc: x.draft.lbc, awe: x.draft.awe,
    findings: x.draft.additionalconsiderations }));
  const options = (master.slots || []).map(sl => `${sl.key} (${sl.label})\n  type options: ${JSON.stringify(sl.typeOptions)}\n  condition options: ${JSON.stringify(sl.conditionOptions)}` +
    (sl.labelOptions ? `\n  row label options (otherLabel): ${JSON.stringify(sl.labelOptions)}` : '')).join('\n');
  const content = [{ type: 'text', text:
    `PROJECT (JSON): ${JSON.stringify(project)}\n\nE3 COUNTS: ${JSON.stringify(counts)}\n\n` +
    `INSPECTION OVERVIEW ROWS AND THEIR DROPDOWN OPTIONS:\n${options || '(none found in the master)'}\n\n` +
    (master.exclusionOptions && master.exclusionOptions.length ? `REASON FOR EXCLUSION OPTIONS: ${JSON.stringify(master.exclusionOptions)}\n\n` : '') +
    `ALL SECTIONS (${compact.length}, JSON):\n${JSON.stringify(compact)}\n\nNow call fill_summary.` }];
  return withRetry(async () => {
    const r = await callTool({ system: summarySystem(company), content, toolName: 'fill_summary', toolSchema: V.summaryToolSchema(master), maxTokens: 12000, signal });
    return { input: r.input, usage: r.usage, model: r.model };
  }, signal);
}

module.exports = { isConfigured, modelName, draftSection, draftSummary, addUsage, MAX_PHOTOS, sectionSystem, summarySystem };
