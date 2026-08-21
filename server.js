/**
 * RedArt LLC - HCPF Claim Status Checker Server
 *
 * A genuinely separate, minimal service from the main submission robot.
 * Purely read-only: looks up real claim statuses on the real HCPF
 * portal. Never fills a billing form, never clicks Submit or Confirm.
 * Kept intentionally small so it's simple to reason about and can never
 * risk the main submission service, which lives entirely separately.
 */

const express = require('express');
const { checkClaimStatus } = require('./statusChecker');

const app = express();
app.use(express.json());

const jobs = {};

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-claim-status-checker' });
});

app.get('/debug-server-check', (req, res) => {
  try {
    const fs = require('fs');
    const src = fs.readFileSync(__filename, 'utf8');
    res.json({
      file: __filename,
      lineCount: src.split('\n').length,
      lastModified: fs.statSync(__filename).mtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/last-run-screenshot', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const successPath = path.join(__dirname, '../last-run-success.png');
  const errorPath = path.join(__dirname, '../last-run-error.png');
  if (fs.existsSync(errorPath)) return res.sendFile(errorPath);
  if (fs.existsSync(successPath)) return res.sendFile(successPath);
  res.status(404).json({ error: 'No screenshot available yet.' });
});

app.post('/check-claim-status', async (req, res) => {
  const { company_id, claim_id, use_click_navigation } = req.body || {};
  if (!claim_id) {
    return res.status(400).json({ error: 'claim_id is required.' });
  }

  const jobId = `check-${claim_id}-${Date.now()}`;
  jobs[jobId] = { status: 'running', result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  checkClaimStatus(company_id || null, claim_id, use_click_navigation !== false)
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error checking claim status:', err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt Claim Status Checker listening on port ${PORT}`);
});
