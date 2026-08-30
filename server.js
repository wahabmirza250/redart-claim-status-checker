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
const activeByClaim = new Map();
const MAX_PENDING = 50;
const JOB_RETENTION_MS = 30 * 60 * 1000;

function claimKey(companyId, claimId) {
  return `${companyId || 'default'}::${String(claimId)}`;
}

function publicHealth() {
  return {
    status: 'ok',
    service: 'redart-claim-status-checker',
    active,
    queued: pending.length,
    maxActive: MAX_ACTIVE,
    duplicateCoalescing: true
  };
}

setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [jobId, job] of Object.entries(jobs)) {
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
    if (Number.isFinite(finished) && finished < cutoff) delete jobs[jobId];
  }
}, 5 * 60 * 1000).unref();

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
        if (task.key && activeByClaim.get(task.key) === task.jobId) {
          activeByClaim.delete(task.key);
        }
        setImmediate(pump);
      });
  }
}

app.get('/', (req, res) => {
  res.json(publicHealth());
});

app.get('/health', (req, res) => {
  res.json(publicHealth());
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

  const key = claimKey(company_id || null, claim_id);
  const existingJobId = activeByClaim.get(key);
  if (existingJobId && jobs[existingJobId] && ['pending', 'running'].includes(jobs[existingJobId].status)) {
    return res.json({
      status: 'started',
      jobId: existingJobId,
      queued: jobs[existingJobId].status === 'pending',
      coalesced: true,
      checkStatusAt: `/job-status/${existingJobId}`
    });
  }

  if (pending.length >= MAX_PENDING) {
    return res.status(429).json({
      error: 'Status checker queue is full. Retry later.',
      retry_after_seconds: 60
    });
  }

  const jobId = `check-${claim_id}-${Date.now()}`;
  // RedArt's status poller understands pending/running/started as nonterminal.
  // Keep queued work internally, but expose it as pending so it is not
  // misclassified as a failed checker job before a browser slot opens.
  jobs[jobId] = {
    status: 'pending',
    result: null,
    key,
    queuedAt: new Date().toISOString()
  };
  activeByClaim.set(key, jobId);
  pending.push({ jobId, key, companyId: company_id || null, claimId: claim_id });
  pump();
  res.json({
    status: 'started',
    jobId,
    queued: jobs[jobId].status === 'pending',
    coalesced: false,
    checkStatusAt: `/job-status/${jobId}`
  });
});

app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RedArt Claim Status Checker listening on port ${PORT}; max active browsers=${MAX_ACTIVE}`));
