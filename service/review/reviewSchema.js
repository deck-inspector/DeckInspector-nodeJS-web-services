// REVIEW REPORT - "Review of Prior Inspection Report" (David, Oct 6 2026).
// ONE definition of every field in the Review master (Deck_ReviewTemplate.docx):
// the AI tool schema, the web editor and the Word generator all read this file,
// so a dropdown value can never drift between them. Option strings must match
// the master's dropdown list items EXACTLY.
'use strict';

const OPTIONS = {
  "law": [
    "SB 326 – Civil Code §5551 (HOA / Common Interest Development)",
    "SB 721 – Health & Safety Code §17973 (Apartment, 3+ Units)"
  ],
  "propertyType": [
    "HOA / Condominium (Common Interest Development)",
    "Apartment (3 or more multifamily units)",
    "Mixed / Other – See Comments"
  ],
  "basis": [
    "Review of Prior Report and photographs only",
    "Review of Prior Report and on-site visual observation",
    "Review of Prior Report, owner records, and on-site visual observation"
  ],
  "finding": [
    "Complies",
    "Partially Complies",
    "Does Not Comply",
    "Not Determinable from Prior Report",
    "N/A – Not Applicable to Selected Law"
  ],
  "scope": [
    "Not Required by Law – Exceeds Statutory Scope",
    "Required by Law",
    "Further Evaluation Recommended",
    "Not Present in Prior Report"
  ],
  "obs": [
    "Observed / Documented",
    "Not Observed",
    "Not Determinable"
  ],
  "opinion": [
    "Required by Law",
    "Not Required by Law",
    "Partially Required – See Basis",
    "Further Evaluation Recommended"
  ],
  "overall": [
    "The Prior Report substantially complies with the applicable law.",
    "The Prior Report complies in part and deviates in part from the applicable law.",
    "The Prior Report does not comply with the applicable law.",
    "The Prior Report requires repairs that exceed the requirements of the applicable law."
  ],
  "accuracy": [
    "Findings are supported by the documentation provided.",
    "Findings are partially supported by the documentation provided.",
    "Findings are not supported by the documentation provided.",
    "Accuracy cannot be determined without further site verification."
  ],
  "recommendation": [
    "No further action required.",
    "Restore occupant access to EEE where no immediate threat was identified.",
    "Prior Report should be revised by its author to conform to the applicable law.",
    "A new inspection conforming to the applicable law is recommended.",
    "Owner should consult legal counsel regarding the Prior Report."
  ]
};

// Section A - statutory compliance (12 rows): title + citation as printed.
const A_ITEMS = [
  {
    "n": 1,
    "title": "Inspector qualifications.",
    "cite": "§17973(a): licensed architect; licensed civil or structural engineer; “A,” “B,” or “C-5” contractor with 5 years’ multistory wood-frame experience; or certified building inspector/official not employed by the local jurisdiction. §5551(b): licensed structural engineer or architect only."
  },
  {
    "n": 2,
    "title": "Elements within statutory scope.",
    "cite": "Only elements more than 6 feet above ground, designed for human occupancy or use, that rely in whole or substantial part on wood or wood-based products for structural support (§17973(b)(2); §5551(a)(3))."
  },
  {
    "n": 3,
    "title": "Sample size and selection.",
    "cite": "§17973(c)(2): at least 15% of each type of EEE. §5551(a)(4), (b), (c): random, statistically significant sample (95% confidence, ±5% margin of error) from a randomly generated list."
  },
  {
    "n": 4,
    "title": "Inspection method.",
    "cite": "Visual inspection by the least intrusive method necessary (§5551(a)(5)); direct visual examination or comparable means (§17973(c)(2)). Further (invasive) inspection only where indicated, e.g. signs of water intrusion (§5551(d); §17973(c)(3)(C))."
  },
  {
    "n": 5,
    "title": "Required evaluation content.",
    "cite": "Current condition; expected future performance and projected service life / remaining useful life; recommendations for further inspection or repair (§17973(c)(3); §5551(e))."
  },
  {
    "n": 6,
    "title": "Photographs, test results, narrative baseline.",
    "cite": "§17973(c)(4): photographs, any test results, and narrative sufficient to establish a baseline for future comparison."
  },
  {
    "n": 7,
    "title": "First-page disclosures (HOA).",
    "cite": "§5551(e): first page states inspection date, total units, units with EEE, total EEE, EEE inspected, EEE posing an immediate threat, and inspector certification."
  },
  {
    "n": 8,
    "title": "Report signed / stamped and delivered.",
    "cite": "§17973(c)(4): stamped or signed, delivered to owner within 45 days. §5551(f): signed report to the board, incorporated into the reserve study."
  },
  {
    "n": 9,
    "title": "Immediate-threat determination.",
    "cite": "Report must state which EEE, if any, pose an immediate threat and whether preventing occupant access or emergency repairs/shoring are necessary (§17973(c)(4), (h)(1); §5551(g))."
  },
  {
    "n": 10,
    "title": "Notice to local enforcement agency.",
    "cite": "Where an immediate threat is reported, a copy to the local enforcement agency within 15 days (§17973(d)(1); §5551(g))."
  },
  {
    "n": 11,
    "title": "Repairs tied to statutory conditions.",
    "cite": "Repairs should address elements that are defective, decayed, or deteriorated to the extent they do not meet load requirements or are not generally safe (§17973(c)(1), (g); §5551(b)) — not upgrades of sound, original construction (H&S §17922(d))."
  },
  {
    "n": 12,
    "title": "Prior reports incorporated.",
    "cite": "§17973(d)(1): subsequent reports incorporate copies of prior inspection reports, including the locations of EEE inspected."
  }
];
// Section B - items in the Prior Report not required by law (8 rows).
const B_ITEMS = [
  {
    "n": 1,
    "text": "Guardrail / railing height measured or required to meet current code."
  },
  {
    "n": 2,
    "text": "Baluster / picket spacing (e.g. 4-inch sphere) measured or required to meet current code."
  },
  {
    "n": 3,
    "text": "Slope of deck or walking surface measured or required to be corrected."
  },
  {
    "n": 4,
    "text": "Lateral (horizontal) load testing of railings or guards."
  },
  {
    "n": 5,
    "text": "Upgrade of existing, sound elements to current building code where no decay, deterioration, or hazardous condition was found."
  },
  {
    "n": 6,
    "text": "Elements outside the statutory definition reported or repaired (6 feet or less above ground, concrete or steel supported, not wood-dependent)."
  },
  {
    "n": 7,
    "text": "Cosmetic surface conditions reported as failures without a documented waterproofing or load-bearing deficiency."
  },
  {
    "n": 8,
    "text": "Other (describe):"
  }
];
// Section C - inspection practices and site conditions (8 rows).
const C_ITEMS = [
  {
    "n": 1,
    "text": "Soffits, ceilings, or surfaces opened for inspection were left open or not restored."
  },
  {
    "n": 2,
    "text": "Occupant access to EEE was restricted (doors blocked, locked, or barricaded) without a documented immediate-threat finding."
  },
  {
    "n": 3,
    "text": "Access restriction remained in place where no damage or hazardous condition was found."
  },
  {
    "n": 4,
    "text": "Invasive openings were made without documented visual indications (e.g. signs of water intrusion) justifying them."
  },
  {
    "n": 5,
    "text": "Immediate-threat finding reported without notice to the local enforcement agency within 15 days."
  },
  {
    "n": 6,
    "text": "Inspector or affiliated company proposed to perform the recommended repairs (potential conflict of interest)."
  },
  {
    "n": 7,
    "text": "Findings or photographs do not support the stated condition rating or life expectancy."
  },
  {
    "n": 8,
    "text": "Other (describe):"
  }
];
const D_ROWS = 6; // rows printed in the master's Section D table

// Page-2 checkboxes, in document order (unlabeled controls in the master).
const PAGE2_CHECKS = ['decks', 'railings', 'stairs', 'walkways', 'entryAreas', 'otherEEE',
  'flashings', 'membranes', 'coatings', 'sealants', 'otherAWE', 'allInspectedYes', 'allInspectedNo'];

function emptyFields() {
  const f = {
    page2: { reviewInspectionDate: '', totalUnitCount: '', unitsWithEEE: '', totalEEE: '', eeeInspected: '', immediateThreatCount: '',
             checks: {} },
    prior: { applicableLaw: '', propertyType: '', company: '', inspector: '', license: '', inspectionDate: '',
             reportDate: '', reference: '', basis: '', reviewDate: '' },
    A: [], B: [], C: [], D: [],
    E: { overall: '', accuracy: '', recommendation: '', summary: '', critique: '' },
  };
  PAGE2_CHECKS.forEach(k => { f.page2.checks[k] = false; });
  A_ITEMS.forEach(() => f.A.push({ finding: '', comments: '' }));
  B_ITEMS.forEach(() => f.B.push({ present: false, ref: '', opinion: '', comments: '' }));
  C_ITEMS.forEach(() => f.C.push({ status: '', comments: '' }));
  for (let i = 0; i < D_ROWS; i++) f.D.push({ location: '', recommendation: '', opinion: '', basis: '' });
  return f;
}

// Keep only known keys / legal option values; anything else becomes ''.
function normalize(input) {
  const out = emptyFields();
  const src = input || {};
  const str = v => (v == null ? '' : String(v)).slice(0, 4000);
  const pick = (v, list) => (list.indexOf(String(v || '')) !== -1 ? String(v) : '');
  const p2 = src.page2 || {};
  ['reviewInspectionDate', 'totalUnitCount', 'unitsWithEEE', 'totalEEE', 'eeeInspected', 'immediateThreatCount']
    .forEach(k => { out.page2[k] = str(p2[k]).slice(0, 60); });
  PAGE2_CHECKS.forEach(k => { out.page2.checks[k] = !!(p2.checks && p2.checks[k]); });
  const pr = src.prior || {};
  Object.keys(out.prior).forEach(k => { out.prior[k] = str(pr[k]); });
  out.prior.applicableLaw = pick(pr.applicableLaw, OPTIONS.law);
  out.prior.propertyType = pick(pr.propertyType, OPTIONS.propertyType);
  out.prior.basis = pick(pr.basis, OPTIONS.basis);
  (src.A || []).slice(0, A_ITEMS.length).forEach((r, i) => { out.A[i] = { finding: pick(r && r.finding, OPTIONS.finding), comments: str(r && r.comments) }; });
  (src.B || []).slice(0, B_ITEMS.length).forEach((r, i) => { out.B[i] = { present: !!(r && r.present), ref: str(r && r.ref).slice(0, 80), opinion: pick(r && r.opinion, OPTIONS.scope), comments: str(r && r.comments) }; });
  (src.C || []).slice(0, C_ITEMS.length).forEach((r, i) => { out.C[i] = { status: pick(r && r.status, OPTIONS.obs), comments: str(r && r.comments) }; });
  (src.D || []).slice(0, D_ROWS).forEach((r, i) => { out.D[i] = { location: str(r && r.location).slice(0, 120), recommendation: str(r && r.recommendation), opinion: pick(r && r.opinion, OPTIONS.opinion), basis: str(r && r.basis) }; });
  const e = src.E || {};
  out.E = { overall: pick(e.overall, OPTIONS.overall), accuracy: pick(e.accuracy, OPTIONS.accuracy),
            recommendation: pick(e.recommendation, OPTIONS.recommendation), summary: str(e.summary), critique: str(e.critique) };
  return out;
}

// JSON schema for the Claude tool call (structured output).
function toolInputSchema() {
  const S = { type: 'string' };
  const en = list => ({ type: 'string', enum: list });
  const checks = {}; PAGE2_CHECKS.forEach(k => { checks[k] = { type: 'boolean' }; });
  return {
    type: 'object',
    properties: {
      page2: { type: 'object', properties: {
        reviewInspectionDate: S, totalUnitCount: S, unitsWithEEE: S, totalEEE: S, eeeInspected: S, immediateThreatCount: S,
        checks: { type: 'object', properties: checks } } },
      prior: { type: 'object', properties: {
        applicableLaw: en(OPTIONS.law), propertyType: en(OPTIONS.propertyType), company: S, inspector: S, license: S,
        inspectionDate: S, reportDate: S, reference: S, basis: en(OPTIONS.basis), reviewDate: S } },
      A: { type: 'array', minItems: A_ITEMS.length, maxItems: A_ITEMS.length, items: { type: 'object', properties: { finding: en(OPTIONS.finding), comments: S }, required: ['finding', 'comments'] } },
      B: { type: 'array', minItems: B_ITEMS.length, maxItems: B_ITEMS.length, items: { type: 'object', properties: { present: { type: 'boolean' }, ref: S, opinion: en(OPTIONS.scope), comments: S }, required: ['present', 'opinion'] } },
      C: { type: 'array', minItems: C_ITEMS.length, maxItems: C_ITEMS.length, items: { type: 'object', properties: { status: en(OPTIONS.obs), comments: S }, required: ['status', 'comments'] } },
      D: { type: 'array', maxItems: D_ROWS, items: { type: 'object', properties: { location: S, recommendation: S, opinion: en(OPTIONS.opinion), basis: S }, required: ['location', 'recommendation', 'opinion', 'basis'] } },
      E: { type: 'object', properties: { overall: en(OPTIONS.overall), accuracy: en(OPTIONS.accuracy), recommendation: en(OPTIONS.recommendation), summary: S, critique: S },
           required: ['overall', 'accuracy', 'recommendation', 'summary', 'critique'] },
    },
    required: ['page2', 'prior', 'A', 'B', 'C', 'D', 'E'],
  };
}

module.exports = { OPTIONS, A_ITEMS, B_ITEMS, C_ITEMS, D_ROWS, PAGE2_CHECKS, emptyFields, normalize, toolInputSchema };
