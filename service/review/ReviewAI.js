// REVIEW REPORT - AI draft (David, Oct 6 2026).
// Claude reads the uploaded PRIOR inspection report (page images) together with
// this company's own E3 inspection of the same property, and returns every field
// of the Review Report through ONE tool call (tool_choice auto - Opus 5.5 rejects forced), so the answer is structured
// JSON that matches the Word master's dropdowns exactly (reviewSchema.js).
// The inspector always reviews and edits the draft on screen before the Word
// report is generated - the AI never publishes anything by itself.
'use strict';
const axios = require('axios');
const schema = require('./reviewSchema');

const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_PAGES = 100;

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function modelName() { return (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim(); }

function systemPrompt(reviewerCompany) {
  const A = schema.A_ITEMS.map(a => `A${a.n}. ${a.title} ${a.cite}`).join('\n');
  const B = schema.B_ITEMS.map(b => `B${b.n}. ${b.text}`).join('\n');
  const C = schema.C_ITEMS.map(c => `C${c.n}. ${c.text}`).join('\n');
  return `You are drafting a "REVIEW REPORT - Review of Prior Inspection Report" for ${reviewerCompany || 'the reviewing company'}, a California exterior elevated element (EEE) inspection company. The Reviewer reviews ANOTHER company's SB 721 / SB 326 inspection report (the "Prior Report", supplied as page images) and states whether it is accurate, whether it complies with the law, and whether it requires anything the law does not. The Reviewer's own E3 inspection data for the same property (the Reviewer's site observation) is supplied as JSON.

THE LAW (apply only the statute that fits the property type):
- SB 721, Health & Safety Code §17973 (apartment buildings with 3+ multifamily units; not common interest developments). Inspector must be a licensed architect, licensed civil or structural engineer, a contractor holding A, B or C-5 with at least 5 years' experience AS A HOLDER of that classification constructing multistory wood-frame buildings, or a certified building inspector/building official not employed by the local jurisdiction. EEE = balconies, decks, porches, stairways, walkways and entry structures (including their supports and railings) extending beyond exterior walls, walking surface more than 6 ft above ground, designed for human occupancy, relying in whole or substantial part on wood. At least 15% of each type of EEE inspected, by direct visual examination or comparable means. The evaluation must address current condition, expected future performance and projected service life, and recommendations of further inspection. Written report stamped or signed, to the owner within 45 days, with photographs, any test results and narrative sufficient to establish a baseline; it must advise which EEE, if any, pose an immediate threat to occupants and whether preventing occupant access or emergency repairs including shoring are necessary. Such a report goes to the local enforcement agency within 15 days. Non-emergency repairs: permit within 120 days, then 120 days to complete. Repairs per a licensed professional's recommendations, manufacturer specs, the California Building Standards Code consistent with H&S §17922(d), and local requirements. Subsequent reports incorporate prior reports.
- SB 326, Civil Code §5551 (HOA / condominium associations, buildings with 3+ attached units). Licensed structural engineer or architect only. Visual inspection = the least intrusive method necessary. Random, statistically significant sample (95% confidence, +/-5% margin of error) from a randomly generated list. Further inspection where water intrusion is indicated. Report: identification of load-bearing components and waterproofing, current physical condition including immediate threats, expected future performance and remaining useful life, repair recommendations. FIRST PAGE must state inspection date, total units, units with EEE, total EEE, EEE inspected, EEE posing an immediate threat, and the inspector's certification. Signed report to the board, incorporated into the reserve study. Immediate threats: notice to the association immediately and to local code enforcement within 15 days; access prevented until repairs are approved. The total unit count is relevant for HOA property only.
- H&S §17922(d): existing buildings may retain original materials and methods of construction unless substandard.
- Neither statute makes current-code dimensional criteria (guard/railing height, baluster/picket spacing, walking-surface slope) or lateral load testing of railings an inspection requirement for existing elements. Railings ARE part of the SB 721 EEE definition as to their CONDITION (decay, deterioration, attachment).

THE REVIEW REPORT FIELDS (fill every one by calling fill_review_report exactly once):
page2 - the Review Report's first data page. reviewInspectionDate = the date of the Reviewer's own E3 site inspection (earliest section createdat in the E3 data, as MM/DD/YYYY; blank if no E3 data). totalUnitCount = "N/A" for apartment property, else the HOA total unit count if stated. unitsWithEEE, totalEEE, eeeInspected, immediateThreatCount = as stated or countable from the Prior Report (use "NA" if not stated and not countable - never "NS"). Every page2 count (and totalUnitCount) must be ONLY a bare number, "NA" or "N/A" - never words or a breakdown, because the cells are narrow and longer text pushes the signature to the next page; put any breakdown (e.g. "20 balconies and 9 walkway landings") in the Section A comments instead. checks = which EEE types and waterproofing elements the Prior Report reviewed; allInspectedYes/No = whether the Prior Report states all unit EEE were inspected.
prior - facts identifying the Prior Report (company, inspector names, licenses exactly as printed, dates, title/reference with page count). Note conflicting dates. basis: use "Review of Prior Report and on-site visual observation" when E3 inspection data is supplied, otherwise "Review of Prior Report and photographs only". reviewDate = "Site observation <reviewInspectionDate>; Review completed <today>".
A - statutory compliance, 12 rows in this order:
${A}
B - items in the Prior Report not required by law, 8 rows (present=true only if the Prior Report actually contains it; ref = page numbers; opinion "Not Present in Prior Report" when absent):
${B}
C - inspection practices and site conditions, 8 rows:
${C}
D - up to 6 repairs the Prior Report requires, preferring the elements the Reviewer also inspected; opinion = whether the applicable law requires each; basis cites the Reviewer's observation and statute.
E - overall opinion, accuracy, recommendation, a summary of opinion (3-5 short paragraphs separated by line breaks) and additional critique.

RULES:
- Be accurate and fair. Every statement about the Prior Report must be supported by its pages; cite page numbers ("p. 9"). Quote short phrases exactly when it matters.
- Where the Prior Report is right, say so. Acknowledge real deterioration that the Reviewer's E3 data confirms.
- Compare element by element with the E3 data (match unit/location names). Where the Reviewer found a different condition (e.g. Good/Pass vs. the Prior Report's Immediate Action), state both plainly.
- Do not speculate about motives, and do not say WHO installed barricades or opened surfaces unless a document says so; use neutral wording ("were installed", "were found").
- If information is missing, say "Not Determinable from Prior Report" / "Not Determinable" rather than guessing.
- Plain, professional English; short sentences; no markdown, no bullet characters. Comments 1-4 sentences each.
- Use only the exact option strings allowed by the tool schema for dropdown fields.`;
}

// pages: [{ n, buffer (jpeg) }], e3: plain object (project + locations + sections)
// onProgress(p) is called often with { phase: 'reading'|'thinking'|'writing', section, sections, label, chars }.
async function analyze({ pages, e3, reviewerCompany, today, onProgress, signal }) {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const use = pages.slice(0, MAX_PAGES);
  const content = [];
  content.push({ type: 'text', text:
    `Today is ${today}. Reviewer company: ${reviewerCompany || ''}.\n\nREVIEWER'S E3 INSPECTION DATA (JSON):\n${JSON.stringify(e3, null, 1)}\n\n` +
    `PRIOR INSPECTION REPORT: ${pages.length} page image(s) follow${pages.length > MAX_PAGES ? ` (only the first ${MAX_PAGES} are included)` : ''}.` });
  for (const p of use) {
    content.push({ type: 'text', text: `Prior Report page ${p.n}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text: 'Now call fill_review_report with every field of the Review Report.' });

  const body = {
    model: modelName(),
    max_tokens: 20000,
    stream: true,
    system: systemPrompt(reviewerCompany),
    tools: [{ name: 'fill_review_report', description: 'Return every field of the Review Report.', input_schema: schema.toolInputSchema() }],
    // claude-opus-5-5 rejects a forced tool_choice ('tool'/'any'), so let the model choose;
    // the prompt tells it to call fill_review_report, and a missing call is reported below.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  };
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  progress({ phase: 'reading' });
  const resp = await axios.post(API_URL, body, {
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    timeout: 15 * 60 * 1000, maxBodyLength: Infinity, maxContentLength: Infinity, responseType: 'stream', signal,
  }).catch(async err => {
    if (signal && signal.aborted) { const e = new Error('stopped'); e.stopped = true; throw e; }
    let d = err.response && err.response.data;
    if (d && typeof d.on === 'function') { d = await readAll(d).then(t => { try { return JSON.parse(t); } catch (e) { return null; } }).catch(() => null); }
    const msg = (d && d.error && d.error.message) || err.message;
    throw new Error('Claude API: ' + msg);
  });

  // Streamed reply (server-sent events). We follow it to report real progress:
  // "reading" until the first event, "thinking" while Claude reasons, then "writing"
  // section by section as the fill_review_report answer arrives.
  const usage = {};
  let model = modelName(), stop = null, toolJson = null, gotTool = false, kind = '', thinkChars = 0, sectionIdx = -1;
  const seen = new Set();
  await new Promise((resolve, reject) => {
    let buf = '';
    const onEvent = ev => {
      switch (ev.type) {
        case 'message_start':
          if (ev.message) { model = ev.message.model || model; Object.assign(usage, ev.message.usage || {}); }
          break;
        case 'content_block_start': {
          const b = ev.content_block || {};
          kind = b.type === 'tool_use' && b.name === 'fill_review_report' ? 'tool' : b.type;
          if (kind === 'tool') { gotTool = true; toolJson = ''; progress({ phase: 'writing', section: 0, sections: SECTIONS.length, label: SECTION_LABELS[0], chars: 0 }); }
          else if (kind === 'thinking' || kind === 'redacted_thinking') progress({ phase: 'thinking', chars: thinkChars });
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'input_json_delta' && kind === 'tool') {
            toolJson += d.partial_json || '';
            // Which section keys have started so far (keys look like  "A":  in the partial JSON).
            SECTIONS.forEach((k, i) => {
              if (!seen.has(k) && SECTION_RE[i].test(toolJson.slice(-4000))) { seen.add(k); sectionIdx = i; }
            });
            progress({ phase: 'writing', section: Math.max(0, seen.size - 1), sections: SECTIONS.length,
                       label: SECTION_LABELS[Math.max(0, sectionIdx)], chars: toolJson.length });
          } else if (d.type === 'thinking_delta') {
            thinkChars += (d.thinking || '').length;
            progress({ phase: 'thinking', chars: thinkChars });
          }
          break;
        }
        case 'message_delta':
          if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage) Object.assign(usage, ev.usage);
          break;
        case 'error':
          reject(new Error('Claude API: ' + ((ev.error && ev.error.message) || 'stream error')));
          break;
        default: break;
      }
    };
    resp.data.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch (e) { /* ignore a malformed line */ }
      }
    });
    const onAbort = () => { const e = new Error('stopped'); e.stopped = true; reject(e); try { resp.data.destroy(); } catch (x) { /* ignore */ } };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    resp.data.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
    resp.data.on('error', err => { if (signal && signal.aborted) return; reject(new Error('Claude API stream: ' + err.message)); });
  });

  if (!gotTool) throw new Error('Claude did not return the review fields (stop: ' + stop + ').');
  if (stop === 'max_tokens') throw new Error('Claude ran out of room before finishing the answers (max_tokens). Try again, or ask for the limit to be raised.');
  let input;
  try { input = JSON.parse(toolJson || '{}'); } catch (e) { throw new Error('Claude returned incomplete answers (' + e.message + ').'); }
  return { fields: schema.normalize(input), usage, model, pagesSent: use.length };
}

// Top-level keys of fill_review_report, in the order Claude writes them.
const SECTIONS = ['page2', 'prior', 'A', 'B', 'C', 'D', 'E'];
const SECTION_RE = SECTIONS.map(k => new RegExp('(^|[^\\\\])"' + k + '"\\s*:'));
const SECTION_LABELS = ['Page 2 counts', 'Prior report details', 'Section A - statutory compliance', 'Section B - items not required by law',
                        'Section C - inspection practices', 'Section D - required repairs', 'Section E - overall opinion'];

function readAll(stream) {
  return new Promise((resolve, reject) => { let t = ''; stream.on('data', c => { t += c; }); stream.on('end', () => resolve(t)); stream.on('error', reject); });
}

module.exports = { analyze, isConfigured, modelName, MAX_PAGES, systemPrompt, SECTIONS, SECTION_LABELS };
