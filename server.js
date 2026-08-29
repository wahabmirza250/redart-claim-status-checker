/**
 * RedArt LLC - HCPF Claim Status Checker Server
 *
 * Separate READ-ONLY service. It only searches/reads claim status and never
 * fills a billing form or clicks Submit/Confirm.
 */
const express = require('express');
const { checkClaimStatus } = require('./statusChecker');

const app = express();
app.use(express.json());
const jobs = {};

// Chromium is process-heavy. The previous unbounded endpoint could accept many
// simultaneous jobs and eventually fail every browser launch with spawn EAGAIN.
// Keep a small local pool and queue the rest. Multiple Railway checker services
// can be added later; each remains independently bounded.
const MAX_ACTIVE = Math.max(1, Math.min(4, Number(process.env.STATUS_CHECKER_MAX_ACTIVE || 2)));
let active = 0;
const pending = [];

function pump() {
  while (active < MAX_ACTIVE && pending.length) {
    const task = pending.shift();
    active++;
    const job = jobs[task.jobId];
    if (job) {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
    }
    checkClaimStatus(task.companyId, task.claimId)
      .then(result => {
        jobs[task.jobId] = {
          status: 'done', result,
          startedAt: jobs[task.jobId]?.startedAt,
          finishedAt: new Date().toISOString()
        };
      })
      .catch(err => {
        console.error('Error checking claim status:', err);
        jobs[task.jobId] = {
          status: 'error', result: { error: err?.message || String(err) },
          startedAt: jobs[task.jobId]?.startedAt,
          finishedAt: new Date().toISOString()
        };
      })
      .finally(() => {
        active = Math.max(0, active - 1);
        setImmediate(pump);
      });
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-claim-status-checker', active, queued: pending.length, maxActive: MAX_ACTIVE });
});

app.get('/debug-server-check', (req, res) => {
  try {
    const fs = require('fs');
    const src = fs.readFileSync(__filename, 'utf8');
    res.json({ file: __filename, lineCount: src.split('\n').length, lastModified: fs.statSync(__filename).mtime, maxActive: MAX_ACTIVE });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/last-run-screenshot', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const successPath = path.join(__dirname, 'last-run-success.png');
  const errorPath = path.join(__dirname, 'last-run-error.png');
  if (fs.existsSync(errorPath)) return res.sendFile(errorPath);
  if (fs.existsSync(successPath)) return res.sendFile(successPath);
  res.status(404).json({ error: 'No screenshot available yet.' });
});

app.post('/check-claim-status', (req, res) => {
  const { company_id, claim_id } = req.body || {};
  if (!claim_id) return res.status(400).json({ error: 'claim_id is required.' });

  const jobId = `check-${claim_id}-${Date.now()}`;
  jobs[jobId] = { status: 'queued', result: null, queuedAt: new Date().toISOString() };
  pending.push({ jobId, companyId: company_id || null, claimId: claim_id });
  pump();
  res.json({ status: 'started', jobId, queued: jobs[jobId].status === 'queued', checkStatusAt: `/job-status/${jobId}` });
});

app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RedArt Claim Status Checker listening on port ${PORT}; max active browsers=${MAX_ACTIVE}`));
