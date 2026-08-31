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
  // Keep only the fields that are useful to diagnose WebForms submission.
  // Do not return the full ViewState or unrelated form contents.
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

  // Playwright returns multipart bodies as raw text on this portal. Pull out
  // EVENTTARGET/EVENTARGUMENT without exposing the rest of the form.
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
  // Expand the real Claims menu first so we prefer the same link a human
  // would use. The session-specific p17/p6 values must come from THIS login.
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

  // Prefer the visible/exact menu item. If DNN keeps it hidden, use the href
  // harvested from this freshly authenticated page. Never reuse a stored URL.
  const chosen = candidates.find(c => c.visible && /Search Claims/i.test(c.text || c.title)) || candidates[0];
  return { href: chosen.href, candidates };
}

/**
 * Extract claim status from the row's Claim Status column ONLY.
 * The Claim Status column is typically the 4th column (index 3) or identified
 * by position after Claim ID, Member, Claim Type. We extract from the cells
 * immediately following the claim ID match, NOT from the full joined text
 * which may contain page-wide filter labels.
 */
function extractClaimStatusFromRow(cells, claimIdString) {
  // Find the index of the cell containing our claim ID
  const claimIdIndex = cells.findIndex(c => c.includes(claimIdString));
  if (claimIdIndex === -1) return null;

  // HCPF portal typically arranges: [Claim ID, Member, ClaimType, Status, Amount, Date, ...]
  // Status column is usually index 3 relative to claim ID at index 0, or we scan forward
  // within a reasonable distance (next 6 cells) and match the FIRST status keyword found.
  const searchWindow = cells.slice(claimIdIndex, claimIdIndex + 6);
  for (const cell of searchWindow) {
    const match = cell.match(/\b(Paid|Suspended|Denied|Rejected|In Process)\b/i);
    if (match) {
      return match[1]; // Return the matched keyword in original case from portal
    }
  }
  return null;
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
        // ----- Login -----
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

        // ----- Navigate with a FRESH Search Claims URL from this session -----
        // Live testing proved the search works when the p17/p6 tokens are
        // harvested from the current authenticated page. A stale token pair
        // renders the form but causes the postback to come back pristine/blank.
        const { href: freshHref, candidates } = await getFreshSearchClaimsHref(page);
        const searchUrl = new URL(freshHref, page.url()).toString();
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(900);

        const searchScreenUrl = page.url();
        const claimIdField = page.locator('[id$="SearchMedicalAndDentalClaimsTabPanel_ClaimIDCmnTextBox_Control"]').first();
        await claimIdField.waitFor({ state: 'visible', timeout: 12000 });

        // ----- Fill exactly like the successful human-like control -----
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

        // Capture only the successful/failed Search Claims POST metadata.
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

        // Find the actual result row for THIS claim. Do not infer Paid from the
        // search form's status dropdown text or page-wide filter labels.
        const parsed = await page.evaluate((wantedClaim) => {
          const rows = Array.from(document.querySelectorAll('tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('th,td'))
              .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean);
            if (!cells.length) continue;
            if (!cells.some(c => c.includes(wantedClaim))) continue;
            const joined = cells.join(' | ');
            // Extract status from the row's cells ONLY, not from page-wide text
            const paidAmount = joined.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] || null;
            const dates = joined.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
            return {
              found: true,
              cells,
              row_text: joined.slice(0, 1000),
              paid_amount: paidAmount,
              dates
            };
          }
          const body = document.body.innerText || '';
          return {
            found: false,
            cells: [],
            row_text: null,
            paid_amount: null,
            dates: [],
            total_records_zero: /Total\s+Records\s*:?\s*0\b/i.test(body),
            body_text_sample: body.slice(0, 3000)
          };
        }, claimIdString);

        // Extract status from row cells ONLY, using the targeted function
        const detectedStatus = parsed.found ? extractClaimStatusFromRow(parsed.cells, claimIdString) : null;

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
          detected_status: detectedStatus,
          paid_amount: parsed.paid_amount,
          result_row: parsed.found ? parsed.cells : null,
          wire_capture: capturedPost,
          raw_dump: parsed.found
            ? { row_text: parsed.row_text, dates: parsed.dates }
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

module.exports = { checkClaimStatus, extractClaimStatusFromRow };

