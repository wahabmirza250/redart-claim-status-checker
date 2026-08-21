/**
 * RedArt LLC - HCPF Colorado Claim Status Checker
 *
 * A genuinely SEPARATE service from the main submission robot, by
 * design. This does exactly one thing: log into the real HCPF portal
 * and look up a claim's real status by Claim ID - completely read-only,
 * never fills a billing form, never clicks Submit or Confirm on
 * anything. Kept deliberately small and focused so it's easy to reason
 * about, and so nothing here can ever risk the main submission service.
 *
 * Reuses the exact same proven login flow and config as the main robot
 * (same portal, same credentials store) - only the destination differs.
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

/**
 * Fetch this provider's own HCPF portal login from the app's secure
 * credential store - identical to the main robot's version, since this
 * is the same real, proven mechanism.
 */
async function fetchPortalCredentials(portalId, companyId) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('BILLING_API_URL / BILLING_API_KEY env vars are not set.');
  }

  let url = `${baseUrl.replace(/\/$/, '')}/api/public/get-portal-credential?portal_id=${encodeURIComponent(portalId)}`;
  if (companyId) {
    url += `&company_id=${encodeURIComponent(companyId)}`;
  }

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

/**
 * Look up ONE real claim's status by Claim ID. Read-only, always.
 *
 * companyId: which company's portal credentials to use.
 * claimId: the real Claim ID to search for.
 * useClickNavigation: TESTING A NEW HYPOTHESIS. Every attempt so far
 * navigated to the Search Claims screen via a direct page.goto() with a
 * swapped tabid in the URL. That's non-standard for this kind of classic
 * ASP.NET WebForms site - it can leave the page's __VIEWSTATE /
 * __EVENTVALIDATION hidden fields out of sync with what the server
 * expects for a postback on THIS specific form, which is a well-known
 * cause of a form silently "losing" submitted values. This flag lets us
 * test navigating via a REAL in-page link click instead - the standard,
 * expected way a browser would reach this screen - to see if that
 * changes the outcome.
 */
async function checkClaimStatus(companyId, claimId, useClickNavigation = true) {
  const config = loadConfig(`${__dirname}/../config/hcpf-colorado.json`);
  const portalCredentials = await fetchPortalCredentials('hfc-colorado', companyId || null);

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
    const result = await Promise.race([
      (async () => {
        // --- Login (identical to the main robot's proven flow) ---
        await page.goto(config.loginUrl || config.baseUrl);
        await page.waitForTimeout(jitteredWait(600));
        await page.fill(config.selectors.login.usernameField, portalCredentials.username);
        await page.waitForTimeout(jitteredWait(400));
        await page.fill(config.selectors.login.passwordField, portalCredentials.password);
        await page.waitForTimeout(jitteredWait(300));
        await page.click(config.selectors.login.submitButton);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // --- Navigate to Search Claims ---
        // Confirmed real location: same Claims menu as claim submission,
        // reachable by swapping the tabid on the current URL.
        if (useClickNavigation) {
          // Find the real "Search Claims" link and click it in-page,
          // exactly as a real user would, instead of jumping there via
          // a direct URL.
          const link = page.getByText(/search\s*claim/i).first();
          await link.click({ timeout: 8000 });
        } else {
          const searchUrl = page.url().replace(/tabid\/\d+/, 'tabid/531');
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 });
        }
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const searchScreenUrl = page.url();

        // --- Search by Claim ID (confirmed: alone is sufficient) ---
        const claimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
        await claimIdField.click();
        await claimIdField.fill('');
        await claimIdField.pressSequentially(String(claimId), { delay: 70 });
        await claimIdField.dispatchEvent('input').catch(() => {});
        await claimIdField.dispatchEvent('change').catch(() => {});
        await claimIdField.evaluate(el => el.blur()).catch(() => {});
        await page.waitForTimeout(400);

        const valueRightBeforeClick = await claimIdField.inputValue().catch(() => null);
        const searchButton = page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').last();

        let navResult = 'not_attempted';
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }),
            searchButton.evaluate(el => el.click())
          ]);
          navResult = 'navigation_completed';
        } catch (e) {
          navResult = `navigation_wait_failed: ${e.message}`;
        }
        await page.waitForTimeout(1500);

        // --- Read back whatever the results screen actually shows ---
        const resultsUrl = page.url();
        const dump = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table')).map(t => ({
            id: t.id || null,
            rowCount: t.querySelectorAll('tr').length,
            headerText: t.querySelector('tr')?.textContent?.trim().slice(0, 200) || null,
            firstDataRowText: t.querySelectorAll('tr')[1]?.textContent?.trim().slice(0, 300) || null
          })).filter(t => t.rowCount > 1);
          return {
            tables,
            bodyTextSample: document.body.innerText.slice(0, 3000)
          };
        }).catch(err => ({ error: err.message }));

        await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});

        // Try to pull a real status word out of whatever we found -
        // "Paid", "Suspended", "Denied" etc. are the known real values
        // seen on real claims so far today.
        const statusMatch = dump.bodyTextSample?.match(/\b(Paid|Suspended|Denied|Rejected|In Process)\b/i);

        return {
          status: 'CHECK_COMPLETE',
          claim_id: claimId,
          navigation_method: useClickNavigation ? 'in_page_click' : 'direct_url',
          search_screen_url: searchScreenUrl,
          filled_claim_id: valueRightBeforeClick,
          nav_result: navResult,
          results_url: resultsUrl,
          detected_status: statusMatch ? statusMatch[1] : null,
          raw_dump: dump
        };
      })(),
      timeout
    ]);
    return result;
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/../last-run-error.png`, fullPage: true }).catch(() => {});
    return { status: 'CHECK_FAILED', claim_id: claimId, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { checkClaimStatus };
