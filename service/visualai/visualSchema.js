// VISUAL REPORT - Claude draft (David, Oct 6 2026: "populate all Visual Inspection
// Reports in the same manner that Claude is doing with the Review Inspections").
// Field definitions shared by the AI service, the route, the web editor and the
// Final Report cover filler.
//   * one SECTION draft per inspected element (the Visual Report's own fields)
//   * one SUMMARY draft = the Final Report cover + Inspection Overview + Comments
'use strict';

const LIFE = ['0-1 Years', '1-4 Years', '4-7 Years', '7-10 Years'];
const YN = ['Yes', 'No'];
const REVIEW = ['Good', 'Fair', 'Bad'];
const ASSESS = ['Pass', 'Fail', 'Future Inspection'];
const PROPERTY_TYPES = ['Apartment (SB 721)', 'HOA / Condominium (SB 326)'];

// Suggested element names (the web editor stores free text, mobile stores lists).
const EXTERIOR = ['Decks', 'Balconies', 'Stairs', 'Landings', 'Walkways', 'Entry Structures', 'Porches', 'Railings', 'Handrails', 'Guard Walls', 'Integrations'];
const WATERPROOF = ['Flashings', 'Waterproofing', 'Membranes', 'Coatings', 'Sealants'];

// Cover checkboxes, in the order they appear on the Final Report master.
const COVER_CHECKS = ['decks', 'railings', 'stairs', 'walkways', 'entryAreas', 'otherEEE',
  'flashings', 'membranes', 'coatings', 'sealants', 'otherAWE', 'allInspectedYes', 'allInspectedNo'];

const SECTION_FIELDS = ['exteriorelements', 'waterproofingelements', 'visualreview', 'visualsignsofleak',
  'furtherinvasivereviewrequired', 'unsafecondition', 'conditionalassessment', 'additionalconsiderations', 'eee', 'lbc', 'awe'];

const s = v => (v == null ? '' : String(v)).trim();
const pick = (v, list, dflt) => {
  const t = s(v).toLowerCase().replace(/\s+/g, ' ');
  const hit = list.find(o => o.toLowerCase() === t);
  return hit || dflt;
};
const yn = v => (v === true || /^(true|yes|y)$/i.test(s(v)) ? 'Yes' : 'No');
const lifeOf = v => {
  const t = s(v).toLowerCase();
  if (!t) return '';
  if (t === 'one' || /^0\s*[-–]\s*1/.test(t)) return LIFE[0];
  if (t === 'four' || /^1\s*[-–]\s*4/.test(t)) return LIFE[1];
  if (t === 'seven' || /^4\s*[-–]\s*7/.test(t)) return LIFE[2];
  if (t === 'sevenplus' || /^7/.test(t)) return LIFE[3];
  return '';
};
const list = v => (Array.isArray(v) ? v : s(v).split(','))
  .map(x => s(x)).filter(Boolean).slice(0, 20);

// Count cells hold only a bare number, "NA" or "N/A" (same rule as the Review Report).
function shortCount(v) {
  const t = s(v);
  if (!t) return '';
  if (/^n\/a$/i.test(t)) return 'N/A';
  if (/^(na|ns|not stated|none stated)$/i.test(t)) return 'NA';
  const m = t.match(/\d+/);
  return m ? m[0] : 'NA';
}

function normalizeSection(d) {
  d = d || {};
  const out = {
    exteriorelements: list(d.exteriorelements),
    waterproofingelements: list(d.waterproofingelements),
    visualreview: pick(d.visualreview, REVIEW, ''),
    visualsignsofleak: yn(d.visualsignsofleak),
    furtherinvasivereviewrequired: yn(d.furtherinvasivereviewrequired),
    unsafecondition: yn(d.unsafecondition),
    conditionalassessment: pick(d.conditionalassessment === 'Futureinspection' ? 'Future Inspection' : d.conditionalassessment, ASSESS, ''),
    additionalconsiderations: s(d.additionalconsiderations).slice(0, 4000),
    eee: lifeOf(d.eee), lbc: lifeOf(d.lbc), awe: lifeOf(d.awe),
    confidence: pick(d.confidence, ['high', 'medium', 'low'], ''),
    note: s(d.note).slice(0, 600),
  };
  // House rules from the Final Report master ("Conclusion and Life Expectancy"):
  // a failed condition assessment is 0-1 years for EEE, LBC and AWE; Bad = Fail;
  // an unsafe condition is always Bad / Fail.
  if (out.unsafecondition === 'Yes') { out.visualreview = 'Bad'; out.conditionalassessment = 'Fail'; }
  if (out.visualreview === 'Bad' && out.conditionalassessment !== 'Fail') out.conditionalassessment = 'Fail';
  if (out.conditionalassessment === 'Fail') { out.eee = LIFE[0]; out.lbc = LIFE[0]; out.awe = LIFE[0]; }
  return out;
}

function emptySummary() {
  const checks = {}; COVER_CHECKS.forEach(k => { checks[k] = false; });
  return { propertyType: '', totalUnitCount: '', unitsWithEEE: '', totalEEE: '', eeeInspected: '', immediateThreatCount: '',
           checks, additionalAreas: '', additionalItems: '', exclusionReason: '', overview: {}, otherLabel: '',
           comments1: '', comments2: '' };
}
function isApartment(t) { return /apartment|721/i.test(s(t)); }

// slots = overview slots read from the tenant's master (see readMasterOptions).
function normalizeSummary(d, slots, exclusionOptions) {
  d = d || {};
  const out = emptySummary();
  out.propertyType = pick(d.propertyType, PROPERTY_TYPES, '');
  ['totalUnitCount', 'unitsWithEEE', 'totalEEE', 'eeeInspected', 'immediateThreatCount'].forEach(k => { out[k] = shortCount(d[k]); });
  // David, Oct 6 2026: apartments (SB 721) - unit counts are not applicable;
  // HOA / condo (SB 326) - they are.
  if (isApartment(out.propertyType)) { out.totalUnitCount = 'N/A'; out.unitsWithEEE = 'N/A'; }
  const c = d.checks || {};
  COVER_CHECKS.forEach(k => { out.checks[k] = !!c[k]; });
  if (out.checks.allInspectedYes && out.checks.allInspectedNo) out.checks.allInspectedNo = false;
  out.additionalAreas = s(d.additionalAreas).slice(0, 200);
  out.additionalItems = s(d.additionalItems).slice(0, 200);
  out.exclusionReason = exclusionOptions && exclusionOptions.length ? pickLoose(d.exclusionReason, exclusionOptions) : s(d.exclusionReason).slice(0, 200);
  const ov = d.overview || {};
  (slots || []).forEach(sl => {
    const v = ov[sl.key] || {};
    out.overview[sl.key] = { type: pickLoose(v.type, sl.typeOptions), condition: pickLoose(v.condition, sl.conditionOptions) };
  });
  const otherSlot = (slots || []).find(x => x.labelOptions && x.labelOptions.length);
  out.otherLabel = otherSlot ? pickLoose(d.otherLabel, otherSlot.labelOptions) : '';
  out.comments1 = s(d.comments1).slice(0, 3000);
  out.comments2 = s(d.comments2).slice(0, 3000);
  return out;
}
// Match a dropdown option ignoring case and stray spaces; '' when not an option.
function pickLoose(v, options) {
  const norm = x => s(x).toLowerCase().replace(/\s+/g, ' ');
  const t = norm(v);
  if (!t) return '';
  return (options || []).find(o => norm(o) === t) || '';
}

// ---------- read the dropdown options from the tenant's Final Report master ----------
// The master is uploaded by the admin, so its option lists are read live rather
// than hard-coded. Returns { slots, exclusionOptions }.
//   slot = { key, label, typeId, typeOptions, conditionId, conditionOptions, labelId?, labelOptions? }
const SLOT_ALIASES = [
  ['building', /^type of structure$/i, 'Building'],
  ['stairs', /^stairs$/i, 'Stairs'],
  ['walkways', /^walkways$/i, 'Walkways'],
  ['balconies', /^balconies$/i, 'Balconies'],
  ['entryDecks', /^entry decks$/i, 'Entry Decks'],
  ['railings', /^railings$/i, 'Railings'],
  ['other', /^handrails$/i, 'Other (Courtyard / Handrails)'],
];
function sdtBlocks(xml) {
  const out = []; const re = /<w:sdt>|<\/w:sdt>/g; let m, depth = 0, st = -1;
  while ((m = re.exec(xml))) {
    if (m[0] === '<w:sdt>') { if (depth === 0) st = m.index; depth++; }
    else { depth--; if (depth === 0 && st !== -1) { out.push({ start: st, end: re.lastIndex }); st = -1; } }
  }
  return out;
}
function sdtInfo(outer) {
  const pr = (outer.match(/<w:sdtPr>([\s\S]*?)<\/w:sdtPr>/) || [])[1] || '';
  const opts = []; const li = /<w:listItem\b([^>]*)\/?>/g; let lm;
  while ((lm = li.exec(pr))) { const dt = (lm[1].match(/w:displayText="([^"]*)"/) || [])[1]; if (dt != null) opts.push(unesc(dt)); }
  return {
    id: (pr.match(/<w:id w:val="(-?\d+)"/) || [])[1] || null,
    alias: unesc((pr.match(/<w:alias w:val="([^"]*)"/) || [])[1] || '').trim(),
    check: /<w14:checkbox/.test(pr), list: /<w:(dropDownList|comboBox)/.test(pr), options: opts,
  };
}
function unesc(t) { return String(t).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

function readMasterOptions(xml) {
  const res = { slots: [], exclusionOptions: [], commentIds: [] };
  const a = xml.indexOf('Inspection overview') !== -1 ? xml.indexOf('Inspection overview') : xml.search(/Inspection\s+overview/i);
  const b = a === -1 ? -1 : xml.indexOf('Repair Method', a);
  if (a !== -1) {
    const region = xml.slice(a, b === -1 ? a + 200000 : b);
    const blocks = sdtBlocks(region).map(bl => sdtInfo(region.slice(bl.start, bl.end)));
    for (let i = 0; i < blocks.length; i++) {
      const bl = blocks[i];
      const def = SLOT_ALIASES.find(d => d[1].test(bl.alias));
      if (def && bl.list) {
        const cond = blocks.slice(i + 1).find(x => x.list && !x.alias);
        const slot = { key: def[0], label: def[2], typeId: bl.id, typeOptions: bl.options,
                       conditionId: cond ? cond.id : null, conditionOptions: cond ? cond.options : [] };
        if (def[0] === 'other') {
          const lab = blocks.slice(0, i).reverse().find(x => x.list && x.options.some(o => /courtyard/i.test(o)));
          if (lab) { slot.labelId = lab.id; slot.labelOptions = lab.options; }
        }
        res.slots.push(slot);
      }
    }
    // the two "Additional Comments" text boxes: text controls (no list) after the last slot
    res.commentIds = blocks.filter(x => !x.list && !x.check && x.id).map(x => x.id).slice(0, 2);
  }
  const r = xml.indexOf('Reason for exclusion');
  if (r !== -1) {
    const seg = xml.slice(r, r + 20000);
    const bl = sdtBlocks(seg).map(x => sdtInfo(seg.slice(x.start, x.end))).find(x => x.list);
    if (bl) { res.exclusionOptions = bl.options; res.exclusionId = bl.id; }
  }
  return res;
}

// ---------- Claude tool schemas ----------
function sectionToolSchema() {
  return {
    type: 'object',
    properties: {
      exteriorelements: { type: 'array', items: { type: 'string' }, description: 'Exterior elevated elements in this section, e.g. ' + EXTERIOR.join(', ') },
      waterproofingelements: { type: 'array', items: { type: 'string' }, description: 'Associated waterproofing elements, e.g. ' + WATERPROOF.join(', ') },
      visualreview: { type: 'string', enum: REVIEW },
      visualsignsofleak: { type: 'string', enum: YN },
      furtherinvasivereviewrequired: { type: 'string', enum: YN },
      unsafecondition: { type: 'string', enum: YN, description: 'Yes only for a condition posing an immediate threat to occupant safety.' },
      conditionalassessment: { type: 'string', enum: ASSESS },
      additionalconsiderations: { type: 'string', description: 'Additional Considerations or Concerns printed in the report: findings and recommendations, 2-5 plain sentences.' },
      eee: { type: 'string', enum: LIFE }, lbc: { type: 'string', enum: LIFE }, awe: { type: 'string', enum: LIFE },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How well the photos and notes support this draft.' },
      note: { type: 'string', description: 'Short note to the inspector (NOT printed): anything the photos could not show or that should be checked.' },
    },
    required: ['exteriorelements', 'waterproofingelements', 'visualreview', 'visualsignsofleak', 'furtherinvasivereviewrequired',
               'unsafecondition', 'conditionalassessment', 'additionalconsiderations', 'eee', 'lbc', 'awe', 'confidence'],
  };
}
function summaryToolSchema(master) {
  const ov = {};
  (master.slots || []).forEach(sl => {
    ov[sl.key] = { type: 'object', description: sl.label,
      properties: { type: { type: 'string', enum: sl.typeOptions.length ? sl.typeOptions : undefined },
                    condition: { type: 'string', enum: sl.conditionOptions.length ? sl.conditionOptions : undefined } },
      required: ['type', 'condition'] };
  });
  const checks = {}; COVER_CHECKS.forEach(k => { checks[k] = { type: 'boolean' }; });
  const other = (master.slots || []).find(x => x.labelOptions);
  const props = {
    propertyType: { type: 'string', enum: PROPERTY_TYPES },
    totalUnitCount: { type: 'string', description: 'HOA only: total units of the property as a bare number; "N/A" for apartments; "NA" if unknown.' },
    checks: { type: 'object', properties: checks, required: COVER_CHECKS },
    additionalAreas: { type: 'string', description: 'Other EEE reviewed, if "otherEEE" is checked (short).' },
    additionalItems: { type: 'string', description: 'Other waterproofing reviewed, if "otherAWE" is checked (short).' },
    exclusionReason: master.exclusionOptions && master.exclusionOptions.length ? { type: 'string', enum: master.exclusionOptions } : { type: 'string' },
    overview: { type: 'object', properties: ov, required: Object.keys(ov) },
    comments1: { type: 'string', description: 'Additional Comments: the summary of findings and conclusions on average across the whole inspection.' },
    comments2: { type: 'string', description: 'Second comments box: recommended next steps / repairs (may be empty).' },
  };
  if (other) props.otherLabel = { type: 'string', enum: other.labelOptions };
  return { type: 'object', properties: props, required: ['propertyType', 'checks', 'overview', 'comments1'] };
}

module.exports = { LIFE, YN, REVIEW, ASSESS, PROPERTY_TYPES, EXTERIOR, WATERPROOF, COVER_CHECKS, SECTION_FIELDS,
  normalizeSection, normalizeSummary, emptySummary, isApartment, shortCount, lifeOf, yn, readMasterOptions,
  sectionToolSchema, summaryToolSchema, sdtBlocks, sdtInfo };
