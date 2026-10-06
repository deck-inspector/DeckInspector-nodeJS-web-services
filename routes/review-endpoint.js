// REVIEW REPORT - "Review of Prior Inspection Report" (David, Oct 6 2026).
// Mounted at /api/review behind authenticateToken (routes.js).
//
// Per project, ONE manifest blob  priorreports/<projectId>/review.json  holds:
//   prior   - the uploaded prior report (file name + page-image blob names)
//   fields  - the Review Report answers (AI draft, then the inspector's edits)
//   status  - '' | 'analyzing' | 'generating' ; error / ai usage / last report
// The browser turns the prior PDF into page images (pdf.js) and uploads them one
// page at a time, so no PDF tooling is needed on the server and the same images
// feed both Claude and Annex 1 of the Word report.
'use strict';
const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const uploadBlob = require('../database/uploadimage');
const projects = require('../model/project');
const projectReports = require('../model/projectReports');
const tenantsDAO = require('../model/tenantsDAO');
const schema = require('../service/review/reviewSchema');
const ReviewAI = require('../service/review/ReviewAI');
const Gen = require('../service/review/ReviewReportGenerator');

const CONTAINER = 'priorreports';
const pageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
router.use(express.json({ limit: '2mb' }));

const manifestName = pid => `${pid}/review.json`;
const cleanId = v => String(v || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);

async function putBlob(name, buf, contentType) {
  const tmp = path.join(os.tmpdir(), 'rv_' + crypto.randomBytes(8).toString('hex'));
  fs.writeFileSync(tmp, buf);
  try {
    const r = JSON.parse(await uploadBlob.uploadFile(CONTAINER, name, tmp, { blobHTTPHeaders: { blobContentType: contentType } }));
    if (!r.url) throw new Error(r.error || 'blob upload failed');
    return r.url;
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
}
async function readManifest(pid) {
  try { return JSON.parse((await uploadBlob.getBlobBuffer(manifestName(pid), CONTAINER)).toString('utf8')); }
  catch (e) { return { prior: null, fields: schema.emptyFields(), status: '', error: '' }; }
}
async function writeManifest(pid, m) {
  m.updatedAt = new Date().toISOString();
  await putBlob(manifestName(pid), Buffer.from(JSON.stringify(m)), 'application/json');
  return m;
}
// The project must belong to the caller's company.
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
async function loadPages(m, onPage, signal) {
  const out = [];
  const names = (m.prior && m.prior.pages) || [];
  for (const [i, name] of names.entries()) {
    if (signal && signal.aborted) throw stoppedError();
    out.push({ n: i + 1, buffer: await uploadBlob.getBlobBuffer(name, CONTAINER) });
    if (onPage) onPage(i + 1, names.length);
  }
  return out;
}
function publicView(m) {
  const base = process.env.AZURE_STORAGE_ACCOUNT_NAME ? `https://${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER}/` : '';
  return Object.assign({}, m, {
    fields: schema.normalize(m.fields),
    prior: m.prior ? Object.assign({}, m.prior, { pageUrls: (m.prior.pages || []).map(n => base + n) }) : null,
    aiConfigured: ReviewAI.isConfigured(), aiModel: ReviewAI.modelName(),
  });
}

// Field definitions for the web editor (option lists = the master's dropdowns).
router.get('/schema', (req, res) => res.json({
  options: schema.OPTIONS, A: schema.A_ITEMS, B: schema.B_ITEMS, C: schema.C_ITEMS, dRows: schema.D_ROWS,
  page2Checks: schema.PAGE2_CHECKS, empty: schema.emptyFields(), aiConfigured: ReviewAI.isConfigured(), maxPages: ReviewAI.MAX_PAGES }));

router.get('/:projectId', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const m = await readManifest(ctx.pid);
  const view = publicView(m);
  if (m.status === 'analyzing') view.progress = await readProgress(ctx.pid, m.statusAt);
  res.json(view);
});

// STOP + CLEAR (David, Oct 6 2026: "a button to clear a report if we have already ran the
// report and a button to stop the report from running if we determine there is a mistake").
// Running Claude jobs on THIS server instance, by project id -> { run, controller }.
// Stop also works across instances: it clears the manifest status, and a job only saves
// its result if the manifest still shows ITS run as analyzing.
const RUNNING = new Map();
function stoppedError() { const e = new Error('stopped'); e.stopped = true; return e; }
async function stillMine(pid, run) {
  const m = await readManifest(pid);
  return m.status === 'analyzing' && m.statusAt === run;
}

router.post('/:projectId/cancel', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const m = await readManifest(ctx.pid);
  const job = RUNNING.get(ctx.pid);
  if (job) { try { job.controller.abort(); } catch (e) { /* ignore */ } }
  if (m.status !== 'analyzing') return res.json(publicView(m));
  m.status = ''; m.error = '';
  m.stopped = { at: new Date().toISOString(), by: (req.user && req.user.username) || '', run: m.statusAt };
  await writeManifest(ctx.pid, m);
  console.log('Review AI stopped by user', ctx.pid, m.stopped.by);
  res.json(publicView(m));
});

// Clear the answers and Claude's draft (the uploaded prior report stays unless removePrior).
router.post('/:projectId/clear', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const m = await readManifest(ctx.pid);
  if (m.status === 'analyzing' || m.status === 'generating') {
    return res.status(409).json({ message: m.status === 'analyzing' ? 'Stop Claude\'s review first.' : 'Wait for the Word report to finish first.' });
  }
  m.fields = schema.emptyFields(); m.error = '';
  delete m.aiDraft; delete m.ai; delete m.stopped;
  if (req.body && req.body.removePrior) m.prior = null;   // page images stay in blob storage, unreferenced
  await writeManifest(ctx.pid, m);
  console.log('Review cleared', ctx.pid, req.body && req.body.removePrior ? '(prior report removed)' : '');
  res.json(publicView(m));
});

// PROGRESS (David, Oct 6 2026: "we will need a progress counter"). While Claude works,
// the background job keeps a small separate blob  <projectId>/progress.json  up to date
// (a separate blob, so it can never overwrite the inspector's saved answers):
//   { run, phase: loading|e3|reading|thinking|writing|saving, done, total, section, sections, label, chars, phaseAt, at }
// The page polls it and draws the bar; "run" = the manifest's statusAt, so an old run's
// progress is never shown for a new one.
const progressName = pid => `${pid}/progress.json`;
async function readProgress(pid, run) {
  try {
    const p = JSON.parse((await uploadBlob.getBlobBuffer(progressName(pid), CONTAINER)).toString('utf8'));
    return p && p.run === run ? p : null;
  } catch (e) { return null; }
}
function progressWriter(pid, run) {
  let state = { run, phase: 'loading', phaseAt: new Date().toISOString() };
  let chain = Promise.resolve(), lastWrite = 0, pending = false, timer = null;
  const flush = () => {
    timer = null; pending = false; lastWrite = Date.now();
    const snap = Object.assign({}, state, { at: new Date().toISOString() });
    chain = chain.then(() => putBlob(progressName(pid), Buffer.from(JSON.stringify(snap)), 'application/json'))
                 .catch(e => console.log('review progress write failed', e.message));
    return chain;
  };
  return {
    // Phase changes are written at once; updates inside a phase at most every 2.5 s.
    set(p) {
      const newPhase = p.phase && p.phase !== state.phase;
      state = Object.assign({}, state, p, newPhase ? { phaseAt: new Date().toISOString() } : {});
      if (newPhase || Date.now() - lastWrite > 2500) { if (timer) clearTimeout(timer); return flush(); }
      if (!pending) { pending = true; timer = setTimeout(flush, 2500 - (Date.now() - lastWrite)); }
      return chain;
    },
    async done() { if (timer) { clearTimeout(timer); timer = null; } await chain; },
  };
}

// Prior report upload: start -> page x N -> finish (the old pages stay until finish).
router.post('/:projectId/prior/start', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  res.json({ uploadId: crypto.randomBytes(6).toString('hex') });
});
router.post('/:projectId/prior/page', pageUpload.single('page'), async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  try {
    const uploadId = cleanId(req.body.uploadId), n = parseInt(req.body.n, 10);
    if (!uploadId || !(n >= 1 && n <= 500) || !req.file) return res.status(400).json({ message: 'Bad page upload.' });
    const name = `${ctx.pid}/${uploadId}/p${String(n).padStart(3, '0')}.jpg`;
    await putBlob(name, req.file.buffer, 'image/jpeg');
    res.json({ ok: true, name });
  } catch (e) { console.error('Review page upload failed:', e.message); res.status(500).json({ message: 'Page upload failed: ' + e.message }); }
});
router.post('/:projectId/prior/finish', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const uploadId = cleanId(req.body.uploadId), count = parseInt(req.body.pageCount, 10);
  if (!uploadId || !(count >= 1 && count <= 500)) return res.status(400).json({ message: 'Bad upload.' });
  const m = await readManifest(ctx.pid);
  m.prior = { fileName: String(req.body.fileName || 'prior-report.pdf').slice(0, 200), uploadId, pageCount: count,
              pages: Array.from({ length: count }, (_, i) => `${ctx.pid}/${uploadId}/p${String(i + 1).padStart(3, '0')}.jpg`),
              uploadedAt: new Date().toISOString(), uploadedBy: (req.user && req.user.username) || '' };
  m.error = '';
  res.json(publicView(await writeManifest(ctx.pid, m)));
});

// Inspector's edits.
router.put('/:projectId/fields', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const m = await readManifest(ctx.pid);
  m.fields = schema.normalize(req.body && req.body.fields);
  m.editedBy = (req.user && req.user.username) || '';
  res.json(publicView(await writeManifest(ctx.pid, m)));
});

// Claude drafts every field (background job; the page polls GET /:projectId).
router.post('/:projectId/analyze', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  if (!ReviewAI.isConfigured()) return res.status(400).json({ message: 'The AI key (ANTHROPIC_API_KEY) has not been added to the server settings yet.' });
  const m = await readManifest(ctx.pid);
  if (!m.prior || !(m.prior.pages || []).length) return res.status(400).json({ message: 'Upload the prior inspection report first.' });
  if (m.status === 'analyzing' && m.statusAt && Date.now() - Date.parse(m.statusAt) < 20 * 60 * 1000) return res.status(409).json({ message: 'Claude is already reviewing this report.' });
  m.status = 'analyzing'; m.statusAt = new Date().toISOString(); m.error = ''; delete m.stopped;
  const prog = progressWriter(ctx.pid, m.statusAt);
  const total = m.prior.pages.length;
  await prog.set({ phase: 'loading', done: 0, total });
  await writeManifest(ctx.pid, m);
  const view = publicView(m); view.progress = { run: m.statusAt, phase: 'loading', done: 0, total, phaseAt: m.statusAt };
  res.status(202).json(view);
  const run = m.statusAt;
  const controller = new AbortController();
  RUNNING.set(ctx.pid, { run, controller });
  (async () => {
    const t0 = Date.now();
    try {
      const tenant = await tenantsDAO.getTenantByCompanyIdentifier(req.user.company).catch(() => null);
      const pages = await loadPages(m, (done, tot) => prog.set({ phase: 'loading', done, total: tot }), controller.signal);
      prog.set({ phase: 'e3' });
      const e3 = await Gen.collectE3(ctx.pid);
      if (controller.signal.aborted || !(await stillMine(ctx.pid, run))) throw stoppedError();
      const now = new Date();
      const r = await ReviewAI.analyze({ pages, e3, reviewerCompany: (tenant && tenant.name) || req.user.company,
                                         today: `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`,
                                         onProgress: p => prog.set(Object.assign({ total: Math.min(total, ReviewAI.MAX_PAGES) }, p)),
                                         signal: controller.signal });
      await prog.set({ phase: 'saving' }); await prog.done();
      const m2 = await readManifest(ctx.pid);
      if (m2.status !== 'analyzing' || m2.statusAt !== run) { console.log('Review AI result discarded (stopped or replaced)', ctx.pid); return; }
      m2.fields = r.fields; m2.aiDraft = r.fields;
      m2.ai = { model: r.model, usage: r.usage, pagesSent: r.pagesSent, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
      m2.status = ''; m2.error = '';
      await writeManifest(ctx.pid, m2);
      console.log('Review AI done', ctx.pid, JSON.stringify(m2.ai));
    } catch (e) {
      await prog.done().catch(() => {});
      if (e.stopped || controller.signal.aborted) { console.log('Review AI stopped', ctx.pid); return; }
      console.error('Review AI failed', ctx.pid, e.message);
      if (!(await stillMine(ctx.pid, run))) return;
      const m2 = await readManifest(ctx.pid); m2.status = ''; m2.error = 'Claude review failed: ' + e.message; await writeManifest(ctx.pid, m2);
    } finally {
      const j = RUNNING.get(ctx.pid); if (j && j.run === run) RUNNING.delete(ctx.pid);
    }
  })();
});

// Build the Word Review Report (background; appears in the project's report list).
router.post('/:projectId/generate', async (req, res) => {
  const ctx = await loadProject(req, res); if (!ctx) return;
  const m = await readManifest(ctx.pid);
  if (req.body && req.body.fields) m.fields = schema.normalize(req.body.fields);
  m.status = 'generating'; m.statusAt = new Date().toISOString(); m.error = '';
  await writeManifest(ctx.pid, m);
  res.status(202).json(publicView(m));
  (async () => {
    const name = `${ctx.project.name || 'Project'} - Review Report`;
    try {
      const pages = (await loadPages(m)).map(p => p.buffer);
      const out = await Gen.generate({ projectId: ctx.pid, companyName: req.user.company, fields: m.fields, pageBuffers: pages,
                                       uploader: (req.user && req.user.username) || '' });
      projectReports.addProjectReport({ project_id: ctx.pid, name, url: out.url, uploader: (req.user && req.user.username) || '',
                                        timestamp: new Date().toISOString() }, err => { if (err) console.log(err); });
      const m2 = await readManifest(ctx.pid); m2.status = ''; m2.lastReport = { url: out.url, at: new Date().toISOString(), bytes: out.bytes };
      await writeManifest(ctx.pid, m2);
    } catch (e) {
      console.error('Review report generation failed', ctx.pid, e);
      projectReports.addProjectReport({ project_id: ctx.pid, name: `${name} FAILED [${String(e.message).slice(0, 200)}]`, url: '',
                                        uploader: (req.user && req.user.username) || '', timestamp: new Date().toISOString() }, () => {});
      const m2 = await readManifest(ctx.pid); m2.status = ''; m2.error = 'Report generation failed: ' + e.message; await writeManifest(ctx.pid, m2);
    }
  })();
});

module.exports = router;
