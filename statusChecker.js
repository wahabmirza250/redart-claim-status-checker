/**
 * RedArt LLC - HCPF Colorado Claim Status Checker
 *
 * Read-only service: logs into the Colorado HCPF provider portal and
 * searches one Claim ID. It never opens, edits, submits, or confirms a
 * claim.
 */

const { chromium } = require('playwright');
const fs = require('fs');

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function jitteredWait(baseMs) {
  const variance = baseMs * 0.2;
  return Math.round(baseMs - variance + Math.random() * variance * 2);
}

async function fetchPortalCredentials(portalId, companyId) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('BILLING_API_URL / BILLING_API_KEY env vars are not set.');
  }

  let url = `${baseUrl.replace(/\/$/, '')}/api/public/get-portal-credential?portal_id=${encodeURIComponent(portalId)}`;
  if (companyId) url += `&company_id=${encodeURIComponent(companyId)}`;

  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Portal credential lookup failed (${res.status}) for portal_id=${portalId}: ${body.error || body.message || 'unknown error'}`
    );
  }
  if (!body.login_email || !body.login_password) {
    throw new Error(`Portal credential response missing login_email/login_password for portal_id=${portalId}.`);
  }
  return { username: body.login_email, password: body.login_password };
}

function redactPostedBody(postData, claimId) {
  if (!postData) return null;
  const out = {
    has_claim_field: postData.includes('ClaimIDCmnTextBox'),
    has_claim_value: postData.includes(String(claimId)),
    has_viewstate: postData.includes('__VIEWSTATE'),
    has_search_button: postData.includes('SearchMedicalAndDentalClaimsCmnButton'),
    has_async_post: postData.includes('__ASYNCPOST'),
    has_script_manager: /ScriptManager/i.test(postData),
    event_target: null,
    event_argument: null,
    body_length: postData.length
  };

  for (const key of ['__EVENTTARGET', '__EVENTARGUMENT']) {
    const multipart = new RegExp(`name="${key}"\\r?\\n\\r?\\n([^\\r\\n]*)`, 'i').exec(postData);
    const urlEncoded = new RegExp(`(?:^|&)${key}=([^&]*)`, 'i').exec(postData);
    const value = multipart?.[1] ?? (urlEncoded ? decodeURIComponent(urlEncoded[1].replace(/\+/g, ' ')) : null);
    if (key === '__EVENTTARGET') out.event_target = value;
    else out.event_argument = value;
  }
  return out;
}

async function getFreshSearchClaimsHref(page) {
  const claimsMenu = page.getByText('Claims', { exact: true }).first();
  await claimsMenu.hover({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);

  const candidates = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a'));
    return anchors
      .filter(a => {
        const text = (a.textContent || '').trim();
        const title = (a.getAttribute('title') || '').trim();
        const href = a.getAttribute('href') || '';
        return /Search Claims/i.test(text) || /Search Claims/i.test(title) || /\/Claims\/SearchClaims\//i.test(href);
      })
      .map(a => {
        const r = a.getBoundingClientRect();
        const s = getComputedStyle(a);
        const visible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        return {
          href: a.getAttribute('href'),
          text: (a.textContent || '').trim(),
          title: (a.getAttribute('title') || '').trim(),
          visible
        };
      })
      .filter(x => x.href && /SearchClaims/i.test(x.href));
  });

  if (!candidates.length) {
    throw new Error('Could not find a Search Claims link after login.');
  }

  const chosen = candidates.find(c => c.visible && /Search Claims/i.test(c.text || c.title)) || candidates[0];
  return { href: chosen.href, candidates };
}


function normalizePortalStatus(value) {
  const raw = String(value || '').trim();
  if (/^paid$/i.test(raw)) return 'paid';
  if (/^denied$/i.test(raw)) return 'denied';
  if (/error\s+submitted\s+data/i.test(raw)) return 'error_submitted_data';
  if (/suspend/i.test(raw)) return 'suspended';
  if (/process|pending|review/i.test(raw)) return 'processing';
  if (/reject/i.test(raw)) return 'rejected';
  return raw ? 'unknown' : 'not_found';
}

function parseMoney(value) {
  const parsed = Number(String(value || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readClaimDetail(page) {
  const raw = await page.evaluate(() => {
    const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('tr'));

    const pairedValue = wantedLabel => {
      const wanted = clean(wantedLabel).toLowerCase();
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td'));
        for (let i = 0; i < cells.length; i++) {
          if (clean(cells[i].innerText || cells[i].textContent).toLowerCase() !== wanted) continue;
          for (let j = i + 1; j < cells.length; j++) {
            const value = clean(cells[j].innerText || cells[j].textContent);
            if (value) return value;
          }
        }
      }
      return null;
    };

    const tables = Array.from(document.querySelectorAll('table'));
    const errorTable = tables.find(table => {
      const text = clean(table.innerText || table.textContent).toLowerCase();
      return text.includes('eob') && text.includes('description');
    });
    const adjudicationErrors = [];
    if (errorTable) {
      const tableRows = Array.from(errorTable.querySelectorAll('tr'));
      const header = tableRows.find(row => {
        const text = clean(row.innerText || row.textContent).toLowerCase();
        return text.includes('eob') && text.includes('description');
      });
      const headers = header ? Array.from(header.querySelectorAll('th,td')).map(cell => clean(cell.innerText || cell.textContent).toLowerCase()) : [];
      const eobIndex = headers.findIndex(name => name === 'eob');
      const descriptionIndex = headers.findIndex(name => name.includes('description'));
      const levelIndex = headers.findIndex(name => /header|detail/.test(name));
      for (const row of tableRows) {
        if (row === header) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        const eob = eobIndex >= 0 ? clean(cells[eobIndex]?.innerText || cells[eobIndex]?.textContent) : null;
        const description = descriptionIndex >= 0 ? clean(cells[descriptionIndex]?.innerText || cells[descriptionIndex]?.textContent) : null;
        if (eob || description) {
          adjudicationErrors.push({
            level: levelIndex >= 0 ? clean(cells[levelIndex]?.innerText || cells[levelIndex]?.textContent) : null,
            eob_code: eob,
            description
          });
        }
      }
    }

    const serviceTable = tables.find(table => {
      const text = clean(table.innerText || table.textContent).toLowerCase();
      return text.includes('procedure code') && text.includes('units') && text.includes('charge amount');
    });
    const serviceLines = [];
    if (serviceTable) {
      const tableRows = Array.from(serviceTable.querySelectorAll('tr'));
      const header = tableRows.find(row => {
        const text = clean(row.innerText || row.textContent).toLowerCase();
        return text.includes('procedure code') && text.includes('units');
      });
      const headers = header ? Array.from(header.querySelectorAll('th,td')).map(cell => clean(cell.innerText || cell.textContent).toLowerCase()) : [];
      const find = pattern => headers.findIndex(name => pattern.test(name));
      const fields = {
        from_date: find(/^from date$/),
        to_date: find(/^to date$/),
        procedure_code: find(/procedure code/),
        modifier: find(/^mod$/),
        units: find(/^units$/),
        charge_amount: find(/charge amount/),
        allowed_amount: find(/allowed amount/)
      };
      for (const row of tableRows) {
        if (row === header) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        const line = Object.fromEntries(Object.entries(fields).map(([name, index]) => [
          name,
          index >= 0 ? clean(cells[index]?.innerText || cells[index]?.textContent) : null
        ]));
        if (line.procedure_code) serviceLines.push(line);
      }
    }

    const body = document.body.innerText || '';
    return {
      claim_id: (body.match(/View Professional Claim\s*-?\s*ID\s+(\d+)/i) || [])[1] || null,
      raw_status: pairedValue('Claim Status'),
      total_charged_amount: pairedValue('Total Charged Amount'),
      total_allowed_amount: pairedValue('Total Allowed Amount'),
      total_paid_amount: pairedValue('Total Paid Amount'),
      adjudication_errors: adjudicationErrors,
      service_lines: serviceLines
    };
  });

  return {
    ...raw,
    normalized_status: normalizePortalStatus(raw.raw_status),
    charged_amount: parseMoney(raw.total_charged_amount),
    allowed_amount: parseMoney(raw.total_allowed_amount),
    paid_amount: parseMoney(raw.total_paid_amount),
    denial_reasons: raw.adjudication_errors
  };
}

async function checkClaimStatus(companyId, claimId) {
  const config = loadConfig(`${__dirname}/hcpf-colorado.json`);
  const portalCredentials = await fetchPortalCredentials('hfc-colorado', companyId || null);
  const claimIdString = String(claimId);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const TIMEOUT_MS = 3 * 60 * 1000;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Status check timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
  );

  try {
    return await Promise.race([
      (async () => {
        await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(jitteredWait(600));
        await page.fill(config.selectors.login.usernameField, portalCredentials.username);
        await page.waitForTimeout(jitteredWait(350));
        await page.fill(config.selectors.login.passwordField, portalCredentials.password);
        await page.waitForTimeout(jitteredWait(250));
        await page.click(config.selectors.login.submitButton);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);

        if (/login/i.test(page.url()) || await page.locator('input[type="password"]').isVisible().catch(() => false)) {
          throw new Error('Portal login did not complete. The session may have been invalidated by another concurrent robot login.');
        }

        const { href: freshHref, candidates } = await getFreshSearchClaimsHref(page);
        const searchUrl = new URL(freshHref, page.url()).toString();
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(900);

        const searchScreenUrl = page.url();
        const claimIdField = page.locator('[id$="SearchMedicalAndDentalClaimsTabPanel_ClaimIDCmnTextBox_Control"]').first();
        await claimIdField.waitFor({ state: 'visible', timeout: 12000 });

        await claimIdField.click();
        await claimIdField.fill('');
        await claimIdField.type(claimIdString, { delay: 90 });
        await page.keyboard.press('Tab');
        await page.waitForTimeout(350);

        const valueImmediatelyAfterTyping = await claimIdField.inputValue();
        if (valueImmediatelyAfterTyping !== claimIdString) {
          return {
            status: 'CHECK_COMPLETE',
            claim_id: claimId,
            navigation_method: 'fresh_session_href',
            search_screen_url: searchScreenUrl,
            filled_claim_id: valueImmediatelyAfterTyping,
            result_state: 'VALUE_LOST',
            detected_status: null,
            nav_result: 'aborted_value_lost_before_click'
          };
        }

        const fieldDiagnostic = await claimIdField.evaluate(el => ({
          id: el.id,
          name: el.getAttribute('name'),
          disabled: el.disabled,
          readOnly: el.readOnly,
          inForm: Boolean(el.closest('form')),
          formId: el.closest('form')?.id || null
        }));

        let capturedPost = null;
        const onRequest = req => {
          if (capturedPost || req.method() !== 'POST') return;
          if (!/SearchClaims/i.test(req.url())) return;
          capturedPost = {
            url: req.url(),
            resource_type: req.resourceType(),
            form: redactPostedBody(req.postData(), claimIdString)
          };
        };
        page.on('request', onRequest);

        const searchButton = page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').first();
        await searchButton.waitFor({ state: 'visible', timeout: 8000 });

        let navResult = 'not_attempted';
        try {
          const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
            .then(() => 'navigation_completed')
            .catch(err => `navigation_wait_failed: ${err.message}`);
          await searchButton.click();
          navResult = await nav;
        } catch (err) {
          navResult = `click_failed: ${err.message}`;
        }

        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
        page.off('request', onRequest);

        const resultsUrl = page.url();
        const claimIdValueAfterClick = await page.locator('[id$="SearchMedicalAndDentalClaimsTabPanel_ClaimIDCmnTextBox_Control"]')
          .first().inputValue().catch(() => null);

        // Enhanced parser: Extract status from the actual Status column position
        // instead of first regex match in joined text. This fixes false positives
        // where status words appear in other columns (e.g., dates, member IDs).
        const parsed = await page.evaluate((wantedClaim) => {
          const rows = Array.from(document.querySelectorAll('tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('th,td'))
              .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean);
            if (!cells.length) continue;

            // Find which column contains the wanted claim ID
            const claimColIndex = cells.findIndex(c => c.includes(wantedClaim));
            if (claimColIndex === -1) continue;

            // HCPF portal structure: [Claim ID] [Member ID] [Service Date] [Status] [Paid Amount] [...]
            // Scan forward from claim ID to find the first legitimate Status value.
            let detectedStatus = null;
            let paidAmountVal = null;

            // Search cells after the claim ID for Status and Amount
            for (let i = claimColIndex; i < cells.length; i++) {
              const cell = cells[i];
              // Match status values: full cell is exactly a status word
              const statusMatch = /^\s*(Paid|Suspended|Denied|Rejected|In Process|Processing)\s*$/i.exec(cell);
              if (statusMatch) {
                detectedStatus = statusMatch[1];
                // Once we find status, look in nearby cells for amount (usually within 2 cells)
                for (let j = i + 1; j < Math.min(i + 3, cells.length); j++) {
                  const amountMatch = /\$[\d,]+(?:\.\d{2})?/.exec(cells[j]);
                  if (amountMatch) {
                    paidAmountVal = amountMatch[0];
                    break;
                  }
                }
                break;
              }
            }

            // Fallback: if strict cell boundary match failed, try regex on joined row
            if (!detectedStatus) {
              const joined = cells.join(' | ');
              const statusMatch = /\b(Paid|Suspended|Denied|Rejected|In Process|Processing)\b/i.exec(joined);
              if (statusMatch) {
                detectedStatus = statusMatch[1];
              }
            }

            // Extract any monetary amounts from the row
            const amounts = [];
            for (const cell of cells) {
              const match = /\$[\d,]+(?:\.\d{2})?/g.exec(cell);
              if (match) amounts.push(match[0]);
            }

            const joined = cells.join(' | ');
            const dates = joined.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];

            return {
              found: true,
              cells,
              row_text: joined.slice(0, 1000),
              status: detectedStatus,
              paid_amount: paidAmountVal || amounts[amounts.length - 1] || null,
              amounts_in_row: amounts,
              dates
            };
          }
          const body = document.body.innerText || '';
          return {
            found: false,
            cells: [],
            row_text: null,
            status: null,
            paid_amount: null,
            amounts_in_row: [],
            dates: [],
            total_records_zero: /Total\s+Records\s*:?\s*0\b/i.test(body),
            body_text_sample: body.slice(0, 3000)
          };
        }, claimIdString);

        let claimDetail = null;
        if (parsed.found) {
          const exactClaimLink = page.locator('a').filter({ hasText: claimIdString }).last();
          if (await exactClaimLink.isVisible().catch(() => false)) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
              exactClaimLink.click({ timeout: 10000 })
            ]);
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(700);
            claimDetail = await readClaimDetail(page);
          }
        }

        await page.screenshot({ path: `${__dirname}/last-run-success.png`, fullPage: true }).catch(() => {});

        return {
          status: 'CHECK_COMPLETE',
          claim_id: claimId,
          navigation_method: 'fresh_session_href',
          search_link_candidates: candidates.map(c => ({ visible: c.visible, title: c.title, text: c.text })),
          search_screen_url: searchScreenUrl,
          filled_claim_id: valueImmediatelyAfterTyping,
          post_form_diagnostic: fieldDiagnostic,
          claim_id_value_after_click: claimIdValueAfterClick,
          nav_result: navResult,
          results_url: resultsUrl,
          result_state: parsed.found ? 'RESULTS_FOUND' : (parsed.total_records_zero ? 'NO_RESULTS' : 'NO_RESULTS'),
          detected_status: claimDetail?.raw_status || parsed.status,
          normalized_status: claimDetail?.normalized_status || normalizePortalStatus(parsed.status),
          paid_amount: claimDetail?.paid_amount ?? parseMoney(parsed.paid_amount),
          charged_amount: claimDetail?.charged_amount ?? null,
          allowed_amount: claimDetail?.allowed_amount ?? null,
          denial_reasons: claimDetail?.denial_reasons || [],
          service_lines: claimDetail?.service_lines || [],
          claim_detail: claimDetail,
          result_row: parsed.found ? parsed.cells : null,
          wire_capture: capturedPost,
          raw_dump: parsed.found
            ? { row_text: parsed.row_text, dates: parsed.dates, amounts_found: parsed.amounts_in_row }
            : { bodyTextSample: parsed.body_text_sample || null }
        };
      })(),
      timeout
    ]);
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/last-run-error.png`, fullPage: true }).catch(() => {});
    return { status: 'CHECK_FAILED', claim_id: claimId, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { checkClaimStatus };

