// VISUAL REPORT - "Draft with Claude" (David, Oct 6 2026: "populate all Visual
// Inspection Reports in the same manner that Claude is doing with the Review
// Inspections"). Mounted at /api/visualai behind authenticateToken (routes.js).
//
// Per project ONE manifest blob  visualdrafts/<projectId>/draft.json  holds:
//   sections - { <sectionId>: { name, building, location, locationType, images, base, draft, at, error } }
//              base  = the inspector's values when Claude drafted (shown as "was")
//              draft = Claude's draft, then the inspector's on-screen edits
//   summary  - the Final Report cover / Inspection Overview / Additional Comments draft
//   status   - '' | 'analyzing' | 'applying' ; error / ai usage / stopped / applied
// Nothing reaches the inspection until POST /:projectId/apply. Apply writes the
// section fields exactly like the web "Edit Inspection" Save, and stores the
// summary that FinalReportGenerator prints on the Final Report cover.
'use strict';
const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PizZip = require('pizzip');
const uploadBlob = require('../database/uploadimage');
const projects = require('../model/project');
const location = require('../model/location');
const subProject = require('../model/subproject');
const tenantsDAO = require('../model/tenantsDAO');
const SectionService = require('../service/sectionService');
const FRG = require('../service/ReportGeneration/FinalReportGenerator');
const V = require('../service/visualai/visualSchema');
const AI = require('../service/visualai/VisualAI');

const CONTAINER = 'visualdrafts';
const CONCURRENCY = 3;
router.use(express.json({ limit: '8mb' }));

const manifestName = pid => `${pid}/draft.json`;
const progressName = pid => `${pid}/progress.json`;
const cleanId = v => String(v || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);

async function putBlob(name, buf, contentType) {
  const tmp = path.join(os.tmpdir(), 'va_' + crypto.randomBytes(8).toString('hex'));
  fs.writeFileSync(tmp, buf);
  try {
    const r = JSON.parse(await uploadBlob.uploadFile(CONTAINER, name, tmp, { blobHTTPHeaders: { blobContentType: contentType } }));
    if (!r.url) throw new Error(r.error || 'blob upload failed');
    return r.url;
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
}
async function readManifest(pid) {
  try { return JSON.parse((await uploadBlob.getBlobBuffer(manifestName(pid), CONTAINER)).toString('utf8')); }
  catch (e) { return { sections: {}, summary: null, status: '', error: '' }; }
}
async function writeManifest(pid, m) {
  m.updatedAt = new Date().toISOString();
  await putBlob(manifestName(pid), Buffer.from(JSON.stringify(m)), 'application/json');
  return m;
}
async function loadProject(req, res) {
  const pid = cleanId(req.params.projectId);
  try {
    const r = await projects.getProjectById(pid);
    const p = r && (r.project || (r.data && r.data.item));
    if (!p) { res.status(404).json({ message: 'Project not found.' }); return null; }
    if (req.user && req.user.company && p.companyIdentifier && p.companyIdentifier !== req.user.company) {
      res.status(403).json({ message: 'Not your project.' }); return null;
    }
    return { pid, project: p };
  } catch (e) { res.status(404).json({ message: 'Project not found.' }); return null; }
}

// Master dropdown options (Inspection Overview etc.) from the Final Report master in use.
let MASTER_CACHE = { at: 0, val: null };
async function masterOptions(company) {
  if (MASTER_CACHE.val && Date.now() - MASTER_CACHE.at < 10 * 60 * 1000) return MASTER_CACHE.val;
  try {
    const buf = await FRG.getTemplateBuffer(company);
    const xml = new PizZip(buf).file('word/document.xml').asText();
    MASTER_CACHE = { at: Date.now(), val: V.readMasterOptions(xml) };
  } catch (e) { console.log('visualai: master options failed', e.message); MASTER_CACHE = { at: Date.now(), val: { slots: [], exclusionOptions: [], commentIds: [] } }; }
  return MASTER_CACHE.val;
}

// Every section of the project, in report order (project-level locations, then buildings).
const LOC_TYPE = { apartment: 'Apartment', buildinglocation: 'Building Common', projectlocation: 'Project Common' };
function inspectorValues(s) {
  return {
    exteriorelements: [].concat(s.exteriorelements || []).join(', '),
    waterproofingelements: [].concat(s.waterproofingelements || []).join(', '),
    visualreview: s.visualreview || '',
    visualsignsofleak: V.yn(s.visualsignsofleak != null ? s.visualsignsofleak : s.visualsignofleak),
    furtherinvasivereviewrequired: V.yn(s.furtherinvasivereviewrequired),
    unsafecondition: V.yn(s.unsafecondition),
    conditionalassessment: s.conditionalassessment === 'Futureinspection' ? 'Future Inspection' : (s.conditionalassessment || ''),
    additionalconsiderations: String(s.additionalconsiderations || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    eee: V.lifeOf(s.eee) || s.eee || '', lbc: V.lifeOf(s.lbc) || s.lbc || '', awe: V.lifeOf(s.awe) || s.awe || '',
  };
}
// Reads are retried and FAIL LOUDLY (the model functions return {error:{code:500}} instead of
// throwing): a silently-missing unit would leave sections out of Claude's draft and the counts.
// Sections come from ONE bulk query for every unit (was one query per unit: 7-12 s live).
const SectionDAO = require('../model/sectionDAO');
async function retry(label, fn) {
  let last;
  for (let a = 0; a < 3; a++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
  }
  throw new Error('Could not read the inspection (' + label + '): ' + (last && last.message) + ' - please try again.');
}
function rowsOf(r, label) {
  if (r && r.data && Array.isArray(r.data.item)) return r.data.item;
  if (r && r.error && r.error.code === 401) return [];          // "none found"
  throw new Error(label + ' ' + ((r && r.error && r.error.message) || 'failed'));
}
async function collectSections(projectId) {
  const locs = [];   // { loc, building }
  (await retry('locations', async () => rowsOf(await location.getLocationByParentId(projectId), 'locations')))
    .forEach(l => locs.push({ loc: l, building: '' }));
  const subs = await retry('buildings', async () => rowsOf(await subProject.getSubProjectsByParentId(projectId), 'buildings'));
  for (const b of subs) {
    (await retry('locations of ' + (b.name || 'building'), async () => rowsOf(await location.getLocationByParentId(b.id || b._id), 'locations')))
      .forEach(l => locs.push({ loc: l, building: b.name || '' }));
  }
  const ids = locs.map(x => String(x.loc.id || x.loc._id)).filter(Boolean);
  const rows = ids.length ? await retry('sections', () => SectionDAO.getSectionsByParentIds(ids)) : [];
  const byParent = new Map();
  rows.forEach(s => { const k = String(s.parentid); if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(s); });
  const out = [];
  for (const { loc, building } of locs) {
    const id = String(loc.id || loc._id);
    for (const s of (byParent.get(id) || [])) {
      out.push({ id: s.id || s._id, locationId: id, building, location: loc.name || '', locationType: LOC_TYPE[loc.type] || '',
                 name: s.name || '', images: [].concat(s.images || []).filter(Boolean), unitUnavailable: !!s.unitUnavailable,
                 current: inspectorValues(s), raw: s });
    }
  }
  return out;
}

// David, Oct 6 2026: "Additional Considerations" prints in bright red, so it is only written
// for a real concern. No concern (Pass, not Bad, no leaks / invasive / unsafe, not Future
// Inspection) => keep the inspector's own text, or leave it empty when the inspector wrote none.
function hasConcern(d) {
  return d.conditionalassessment === 'Fail' || d.conditionalassessment === 'Future Inspection' || d.visualreview === 'Bad'
    || d.visualsignsofleak === 'Yes' || d.furtherinvasivereviewrequired === 'Yes' || d.unsafecondition === 'Yes';
}
function quietWhenNoConcern(draft, inspector) {
  if (!draft || hasConcern(draft)) return draft;
  const own = String((inspector && inspector.additionalconsiderations) || '').trim();
  if (!own) return Object.assign({}, draft, { additionalconsiderations: '' });
  return draft;
}

// E3 counts from the section list + drafts (deterministic, not Claude's).
// EEE COUNT (David, Oct 8 2026: "each section location has inspection points ... Stairs have
// railings & landings"; he chose "statutory EEE elements only"). Total # EEE = the exterior
// elements listed in every section that ARE EEE under SB 721 / SB 326 (decks, balconies, stairs,
// landings, walkways, porches, entries, railings); Integrations, Door Threshold, Stucco Interface
// and the waterproofing points (flashings, membranes, coatings, sealants) are not counted.
// A section that lists no EEE element still counts as one. EEE Inspected = the same count over
// the sections that were not "unit unavailable".
const EEE_WORDS = /deck|balcon|stair|landing|walkway|corridor|breezeway|porch|entry|entries|entrance|rail|guard|bridge|catwalk/i;
const NOT_EEE = /integration|threshold|stucco|flashing|membrane|coating|sealant|waterproof|door|window|siding|parapet\s*cap/i;
function eeeElements(values) {
  const names = [].concat(values.exteriorelements || []).join(',').split(',').map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  return names.filter(n => EEE_WORDS.test(n) && !NOT_EEE.test(n)).filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function eeeCountOf(values) { return Math.max(1, eeeElements(values).length); }
function countsFrom(list, drafts) {
  const units = new Set(), inspected = list.filter(x => !x.unitUnavailable);
  list.forEach(x => units.add(x.locationId));
  const valuesOf = x => (drafts[x.id] && drafts[x.id].draft) || x.current;
  // Immediate threat (David, Oct 8 2026): "Only the unit location would be marked unsafe ... if one
  // element is unsafe, the unit location is marked unsafe" - count LOCATIONS with any unsafe section.
  const threat = new Set(inspected.filter(x => valuesOf(x).unsafecondition === 'Yes').map(x => x.locationId)).size;
  const total = list.reduce((n, x) => n + eeeCountOf(valuesOf(x)), 0);
  const insp = inspected.reduce((n, x) => n + eeeCountOf(valuesOf(x)), 0);
  return { units: units.size, unitsWithEEE: units.size, sections: list.length, totalEEE: total, eeeInspected: insp, immediateThreatCount: threat,
           unavailable: list.length - inspected.length };
}

function publicView(m, master) {
  const sections = {};
  Object.entries(m.sections || {}).forEach(([id, x]) => { sections[id] = Object.assign({}, x, { draft: x.draft ? V.normalizeSection(x.draft) : null }); });
  return Object.assign({}, m, { sections,
    summary: m.summary ? V.normalizeSummary(m.summary, master.slots, master.exclusionOptions) : null,
    aiConfigured: AI.isConfigured(), aiModel: AI.modelName() });
}

// ---------- progress (separate blob, same idea as the Review Report) ----------
async function readProgress(pid, run) {
  try { const p = JSON.parse((await uploadBlob.getBlobBuffer(progressName(pid), CONTAINER)).toString('utf8')); return p && p.run === run ? p : null; }
  catch (e) { return null; }
}
function progressWriter(pid, run) {
  let state = { run, phase: 'collecting', phaseAt: new Date().toISOString() };
  let chain = Promise.resolve(), lastWrite = 0, timer = null;
  const flush = () => {
    timer = null; lastWrite = Date.now();
    const snap = Object.assign({}, state, { at: new Date().toISOString() });
    chain = chain.then(() => putBlob(progressName(pid), Buffer.from(JSON.stringify(snap)), 'application/json')).catch(e => console.log('visualai progress write failed', e.message));
    return chain;
  };
  return {
    set(p) {
      const newPhase = p.phase && p.phase !== state.phase;
      state = Object.assign({}, state, p, newPhase ? { phaseAt: new Date().toISOString() } : {});
      if (newPhase || Date.now() - lastWrite > 2500) { if (timer) clearTimeout(timer); return flush(); }
      if (!timer) timer = setTimeout(flush, 2500 - (Date.now() - lastWrite));
      return chain;
    },
    async done() { if (timer) { clearTimeout(timer); timer = null; } await chain; },
  };
}

const RUNNING = new Map();
const stoppedError = () => { const e = new Error('stopped'); e.stopped = true; return e; };
async function stillMine(pid, run) { const m = await readManifest(pid); return m.status === 'analyzing' && m.statusAt === run; }
// A job dies with its server (deploy / restart). After 5 quiet minutes the run counts as interrupted.
const STALE_MS = 5 * 60 * 1000;

// ---------- COMPANY WRITING RULES for Claude (David, Oct 6 2026) ----------
// One blob per company: visualdrafts/_rules/<company>.json { text, by, at }.
// Every "Draft with Claude" run of that company follows them.
const rulesName = company => `_rules/${String(company || 'unknown').replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'unknown'}.json`;
async function readRules(company) {
  try { return JSON.parse((await uploadBlob.getBlobBuffer(rulesName(company), CONTAINER)).toString('utf8')); }
  catch (e) { return { text: '', by: '', at: '' }; }
}

// ---------- routes ----------
router.get('/schema', async (req, res) => {
  const master = await masterOptions(req.user && req.user.company);
  res.json({ options: { life: V.LIFE, review: V.REVIEW, assess: V.ASSESS, yn: V.YN, propertyTypes: V.PROPERTY_TYPES,
                        exterior: V.EXTERIOR, waterproof: V.WATERPROOF, exclusion: master.exclusionOptions },
             coverChecks: V.COVER_CHECKS, slots: master.slots.map(s => ({ key: s.key, label: s.label, typeOptions: s.typeOptions, conditionOptions: s.conditionOptions, labelOptions: s.labelOptions || null })),
             aiConfigured: AI.isConfigured(), model: AI.modelName(), maxPhotos: AI.MAX_PHOTOS });
});

router.get('/rules', async (req, res) => res.json(await readRules(req.user && req.user.company)));
router.put('/rules', async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\r/g, '').slice(0, 6000);
  const r = { text, by: (req.user && req.user.username) || '', at: new Date().toISOString() };
  await putBlob(rulesName(req.user && req.user.company), Buffer.from(JSON.stringify(r)), 'application/json');
  console.log('Visual AI writing rules saved', req.user && req.user.company, r.by, text.length, 'chars');
  res.json(r);
});

router.get('/:projectId', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const master = await masterOptions(req.user.company);
  const m = await readManifest(ctx.pid);
  const view = publicView(m, master);
  let list;
  try { list = await collectSections(ctx.pid); } catch (e) { return res.status(503).json({ message: e.message }); }
  // the inspection as it is NOW (for the editor and the cost estimate)
  view.inspection = list.map(x => ({ id: x.id, building: x.building, location: x.location, locationType: x.locationType, name: x.name,
                                     photos: x.images.length, images: x.images.slice(0, AI.MAX_PHOTOS), unitUnavailable: x.unitUnavailable, current: x.current }));
  view.counts = countsFrom(list, m.sections || {});
  if (m.status === 'analyzing') {
    view.progress = await readProgress(ctx.pid, m.statusAt);
    const last = Date.parse((view.progress && view.progress.at) || m.statusAt);
    if (Date.now() - last > STALE_MS && !RUNNING.has(ctx.pid)) { view.stale = true; }
  }
  res.json(view);
});

router.post('/:projectId/cancel', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const master = await masterOptions(req.user.company);
  const job = RUNNING.get(ctx.pid);
  if (job) { try { job.controller.abort(); } catch (e) { /* ignore */ } }
  const m = await readManifest(ctx.pid);
  if (m.status !== 'analyzing') return res.json(publicView(m, master));
  m.status = ''; m.error = '';
  m.stopped = { at: new Date().toISOString(), by: (req.user && req.user.username) || '', run: m.statusAt };
  await writeManifest(ctx.pid, m);
  console.log('Visual AI stopped by user', ctx.pid, m.stopped.by);
  res.json(publicView(m, master));
});

router.post('/:projectId/clear', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const master = await masterOptions(req.user.company);
  const m = await readManifest(ctx.pid);
  if (m.status === 'analyzing' || m.status === 'applying') return res.status(409).json({ message: 'Stop Claude first.' });
  m.sections = {}; m.summary = null; m.error = '';
  delete m.ai; delete m.stopped;
  await writeManifest(ctx.pid, m);
  res.json(publicView(m, master));
});

// The inspector's on-screen edits (draft only - the inspection is not changed).
router.put('/:projectId/draft', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const master = await masterOptions(req.user.company);
  const m = await readManifest(ctx.pid);
  if (m.status === 'analyzing') return res.status(409).json({ message: 'Claude is still drafting - wait or press Stop.' });
  const b = req.body || {};
  Object.entries(b.sections || {}).forEach(([id, d]) => { if (m.sections && m.sections[id]) { m.sections[id].draft = V.normalizeSection(d); m.sections[id].edited = true; } });
  if (b.summary) m.summary = V.normalizeSummary(b.summary, master.slots, master.exclusionOptions);
  m.editedBy = (req.user && req.user.username) || '';
  res.json(publicView(await writeManifest(ctx.pid, m), master));
});

// Claude drafts every section, then the summary (background job; the page polls).
router.post('/:projectId/analyze', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  if (!AI.isConfigured()) return res.status(400).json({ message: 'The AI key (ANTHROPIC_API_KEY) has not been added to the server settings yet.' });
  const master = await masterOptions(req.user.company);
  const m = await readManifest(ctx.pid);
  if (m.status === 'analyzing' && (RUNNING.has(ctx.pid) || Date.now() - Date.parse(m.updatedAt || m.statusAt) < STALE_MS)) {
    const p = await readProgress(ctx.pid, m.statusAt);
    if (RUNNING.has(ctx.pid) || (p && Date.now() - Date.parse(p.at) < STALE_MS)) return res.status(409).json({ message: 'Claude is already drafting this report.' });
  }
  let list;
  try { list = await collectSections(ctx.pid); } catch (e) { return res.status(503).json({ message: e.message }); }
  if (!list.length) return res.status(400).json({ message: 'This project has no inspected sections yet.' });
  // resume = keep the sections already drafted by an interrupted / stopped run
  const resume = !!(req.body && req.body.resume);
  if (!resume) { m.sections = {}; m.summary = null; }
  m.sections = m.sections || {};
  m.status = 'analyzing'; m.statusAt = new Date().toISOString(); m.error = ''; delete m.stopped;
  const run = m.statusAt;
  // ONE CLICK (David, Oct 6 2026): the page creates the report as soon as this run finishes.
  m.autoCreate = req.body && req.body.autoCreate ? { run, at: run, by: (req.user && req.user.username) || '' } : null;
  const todo = list.filter(x => !x.unitUnavailable && !(resume && m.sections[x.id] && m.sections[x.id].draft && !m.sections[x.id].error));
  const prog = progressWriter(ctx.pid, run);
  await prog.set({ phase: 'sections', done: 0, total: todo.length, all: list.length });
  await writeManifest(ctx.pid, m);
  const view = publicView(m, master); view.progress = { run, phase: 'sections', done: 0, total: todo.length, phaseAt: run };
  res.status(202).json(view);

  const controller = new AbortController();
  RUNNING.set(ctx.pid, { run, controller });
  (async () => {
    const t0 = Date.now();
    const usage = Object.assign({}, (resume && m.ai && m.ai.usage) || {});
    let model = AI.modelName(), photos = 0, done = 0, failed = 0, lastSave = Date.now();
    const results = Object.assign({}, m.sections);
    const save = async (final) => {
      const m2 = await readManifest(ctx.pid);
      if (m2.status !== 'analyzing' || m2.statusAt !== run) throw stoppedError();
      m2.sections = Object.assign({}, m2.sections || {}, results);
      m2.ai = { model, usage, photosSent: photos, sections: Object.keys(results).length, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
      if (final) { m2.status = ''; m2.error = final.error || ''; if (final.summary) m2.summary = final.summary; }
      await writeManifest(ctx.pid, m2);
      lastSave = Date.now();
    };
    try {
      const tenant = await tenantsDAO.getTenantByCompanyIdentifier(req.user.company).catch(() => null);
      const company = (tenant && tenant.name) || req.user.company;
      const rules = (await readRules(req.user.company)).text || '';
      const project = { name: ctx.project.name || '', address: String(ctx.project.address || '').replace(/\s+/g, ' ').trim(),
                        description: ctx.project.description || '', projecttype: ctx.project.projecttype || '' };
      // sections: a small worker pool
      const queue = todo.slice();
      const worker = async () => {
        while (queue.length) {
          if (controller.signal.aborted) throw stoppedError();
          const sec = queue.shift();
          const entry = { name: sec.name, building: sec.building, location: sec.location, locationType: sec.locationType,
                          locationId: sec.locationId, images: sec.images.slice(0, AI.MAX_PHOTOS), base: sec.current };
          try {
            const r = await AI.draftSection({ sec, project, company, rules, signal: controller.signal });
            AI.addUsage(usage, r.usage); model = r.model; photos += r.photosSent;
            results[sec.id] = Object.assign(entry, { draft: quietWhenNoConcern(r.draft, sec.current), photosSent: r.photosSent, at: new Date().toISOString() });
          } catch (e) {
            if (e.stopped || controller.signal.aborted) throw stoppedError();
            failed++;
            console.log('Visual AI section failed', ctx.pid, sec.id, e.message);
            results[sec.id] = Object.assign(entry, { draft: null, error: e.message.slice(0, 300), at: new Date().toISOString() });
          }
          done++;
          prog.set({ phase: 'sections', done, total: todo.length, label: [sec.building, sec.location, sec.name].filter(Boolean).join(' / ') });
          if (Date.now() - lastSave > 20000) await save(false);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));
      if (!(await stillMine(ctx.pid, run))) throw stoppedError();

      // summary for the Final Report cover
      await prog.set({ phase: 'summary' });
      const drafted = list.map(x => Object.assign({}, x, { draft: (results[x.id] && results[x.id].draft) || V.normalizeSection(x.current) }));
      const draftsById = {}; drafted.forEach(x => { draftsById[x.id] = { draft: x.draft }; });
      const counts = countsFrom(list, draftsById);
      let summary = null;
      try {
        const s = await AI.draftSummary({ project, sectionsOut: drafted, counts, master, company, rules, signal: controller.signal });
        AI.addUsage(usage, s.usage);
        summary = s.input;
      } catch (e) {
        if (e.stopped || controller.signal.aborted) throw stoppedError();
        console.log('Visual AI summary failed', ctx.pid, e.message);
        summary = {}; failed++;
      }
      summary = Object.assign({}, summary, { unitsWithEEE: String(counts.unitsWithEEE), totalEEE: String(counts.totalEEE),
                                             eeeInspected: String(counts.eeeInspected), immediateThreatCount: String(counts.immediateThreatCount) });
      if (!summary.propertyType) summary.propertyType = /hoa|association|condo/i.test(project.name + ' ' + project.description) ? V.PROPERTY_TYPES[1] : V.PROPERTY_TYPES[0];
      summary = V.normalizeSummary(summary, master.slots, master.exclusionOptions);
      await prog.set({ phase: 'saving' }); await prog.done();
      await save({ summary, error: failed ? `${failed} item(s) could not be drafted - see the red notes below, or run Draft with Claude again and choose Continue.` : '' });
      console.log('Visual AI done', ctx.pid, JSON.stringify({ sections: todo.length, failed, photos, usage, seconds: Math.round((Date.now() - t0) / 1000) }));
    } catch (e) {
      await prog.done().catch(() => {});
      if (e.stopped || controller.signal.aborted) {
        // keep what was finished so "Continue" can pick up from here
        try { const m2 = await readManifest(ctx.pid); m2.sections = Object.assign({}, m2.sections || {}, results);
              m2.ai = { model, usage, photosSent: photos, sections: Object.keys(results).length, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
              if (m2.status === 'analyzing' && m2.statusAt === run) m2.status = '';
              await writeManifest(ctx.pid, m2); } catch (x) { /* ignore */ }
        console.log('Visual AI stopped', ctx.pid); return;
      }
      console.error('Visual AI failed', ctx.pid, e.message);
      if (!(await stillMine(ctx.pid, run))) return;
      const m2 = await readManifest(ctx.pid); m2.sections = Object.assign({}, m2.sections || {}, results);
      m2.status = ''; m2.error = 'Claude draft failed: ' + e.message; await writeManifest(ctx.pid, m2);
    } finally {
      const j = RUNNING.get(ctx.pid); if (j && j.run === run) RUNNING.delete(ctx.pid);
    }
  })();
});

// APPLY: write the (edited) drafts into the inspection, exactly like the web
// Edit Inspection Save, and keep the summary for the Final Report cover.
const toBool = v => v === true || /^(true|yes)$/i.test(String(v));
function ynBack(orig, yes) {
  if (typeof orig === 'boolean' || orig == null) return yes;
  const s = String(orig);
  if (/^(yes|no)$/i.test(s)) return yes ? 'Yes' : 'No';
  if (/^(true|false)$/i.test(s)) return yes ? 'true' : 'false';
  return yes;
}
router.post('/:projectId/apply', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const master = await masterOptions(req.user.company);
  const m = await readManifest(ctx.pid);
  if (m.status === 'analyzing') return res.status(409).json({ message: 'Claude is still drafting - wait or press Stop.' });
  const b = req.body || {};
  Object.entries(b.sections || {}).forEach(([id, d]) => { if (m.sections && m.sections[id]) m.sections[id].draft = V.normalizeSection(d); });
  if (b.summary) m.summary = V.normalizeSummary(b.summary, master.slots, master.exclusionOptions);
  const only = Array.isArray(b.ids) ? new Set(b.ids.map(String)) : null;
  let list;
  try { list = await collectSections(ctx.pid); } catch (e) { return res.status(503).json({ message: e.message }); }
  const byId = new Map(list.map(x => [String(x.id), x]));
  const who = (req.user && req.user.username) || '';
  let ok = 0; const failed = [];
  for (const [id, x] of Object.entries(m.sections || {})) {
    if (!x.draft || (only && !only.has(id))) continue;
    const cur = byId.get(id); if (!cur) { failed.push({ id, name: x.name, error: 'section no longer exists' }); continue; }
    const o = cur.raw, d = V.normalizeSection(x.draft);
    const payload = {
      exteriorelements: Array.isArray(o.exteriorelements) || o.exteriorelements == null ? d.exteriorelements : d.exteriorelements.join(', '),
      waterproofingelements: Array.isArray(o.waterproofingelements) || o.waterproofingelements == null ? d.waterproofingelements : d.waterproofingelements.join(', '),
      visualreview: d.visualreview,
      visualsignsofleak: toBool(d.visualsignsofleak),
      furtherinvasivereviewrequired: toBool(d.furtherinvasivereviewrequired),
      unsafecondition: ynBack(o.unsafecondition, d.unsafecondition === 'Yes'),
      conditionalassessment: d.conditionalassessment,
      additionalconsiderations: d.additionalconsiderations,
      eee: d.eee, lbc: d.lbc, awe: d.awe,
      editedat: new Date().toISOString(), lasteditedby: who, aidraftedat: x.at || '',
    };
    if (o.additionalconsiderationshtml !== undefined) payload.additionalconsiderationshtml = d.additionalconsiderations;
    try {
      const r = await SectionService.editSetion(id, payload);
      if (r && r.reason) throw new Error(r.reason);
      ok++; x.appliedAt = new Date().toISOString();
    } catch (e) { failed.push({ id, name: x.name, error: e.message }); }
  }
  // the counts follow the inspection as it is now
  if (m.summary) {
    const c = countsFrom(await collectSections(ctx.pid).catch(() => list), {});
    Object.assign(m.summary, { totalEEE: String(c.totalEEE), eeeInspected: String(c.eeeInspected), immediateThreatCount: String(c.immediateThreatCount) });
    if (!V.isApartment(m.summary.propertyType)) m.summary.unitsWithEEE = String(c.unitsWithEEE);
    m.summary = V.normalizeSummary(m.summary, master.slots, master.exclusionOptions);
  }
  m.applied = { at: new Date().toISOString(), by: who, sections: ok, failed: failed.length, summary: m.summary || null };
  await writeManifest(ctx.pid, m);
  console.log('Visual AI applied', ctx.pid, ok, 'sections', failed.length, 'failed');
  const view = publicView(m, master); view.applyResult = { ok, failed };
  res.json(view);
});

// Used by FinalReportGenerator: the applied summary for the Final Report cover (or null).
async function appliedSummary(projectId) {
  try { const m = await readManifest(cleanId(projectId)); return (m.applied && m.applied.summary) || null; }
  catch (e) { return null; }
}

module.exports = router;
module.exports.appliedSummary = appliedSummary;
module.exports.masterOptions = masterOptions;
