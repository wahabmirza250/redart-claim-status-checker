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
 * Reuses the exact same proven login flow and config as the main robot
 * (same portal, same credentials store) - only the destination differs.
 */
async function checkClaimStatus(companyId, claimId) {
  const config = loadConfig(`${__dirname}/hcpf-colorado.json`);
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
        // === FIXED (2026-08-21) === Confirmed via real evidence: the
        // "Search Claims" link genuinely exists in the DOM (exactly
        // where expected), but sits inside a collapsed DNN secondary
        // menu (display:none) - clicking it timed out since Playwright
        // correctly refuses to click something not visible. The fix:
        // read its real href directly (which carries live,
        // session-scoped tokens) and navigate there directly - gets the
        // benefit of a real, valid session-linked URL without needing
        // to click a hidden element at all.
        const searchLink = page.locator('a[title="Search Claims"]').first();
        const href = await searchLink.getAttribute('href');
        if (!href) {
          throw new Error('Could not find the real Search Claims link href on the page after login.');
        }
        const searchUrl = new URL(href, page.url()).toString();
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const searchScreenUrl = page.url();

        // --- Search by Claim ID (confirmed: alone is sufficient) ---
        const claimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
        await claimIdField.click();
        await claimIdField.fill('');
        await claimIdField.type(String(claimId), { delay: 80 });
        await claimIdField.press('Tab').catch(() => {});
        await claimIdField.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }).catch(() => {});

        // === ADDED (2026-08-21, round 5) === Real, precise root cause
        // confirmed: this field has an inline onkeyup="SetBusinessType(...)"
        // HTML attribute handler - generic dispatched events (even from
        // real type()) don't reliably trigger this specific kind of
        // inline attribute handler the same way a genuine physical
        // keystroke does. Rather than keep guessing at event dispatch,
        // read the handler's exact real arguments directly off the page
        // and call the named function itself explicitly - the same
        // thing the portal's own code does internally, called the exact
        // same way.
        const businessTypeCallResult = await claimIdField.evaluate(el => {
          const handlerAttr = el.getAttribute('onkeyup') || el.getAttribute('onchange');
          if (!handlerAttr) return { called: false, reason: 'no_handler_attribute_found' };
          try {
            // The attribute is literally JS source (e.g.
            // SetBusinessType('id1','id2','id3')) - execute it in the
            // page's own real context via a same-element inline handler
            // invocation, not eval() in our injected context, so it runs
            // exactly as the browser would run it on a real keystroke.
            const fn = new Function(handlerAttr);
            fn.call(el);
            return { called: true, handlerAttr };
          } catch (e) {
            return { called: false, reason: e.message, handlerAttr };
          }
        }).catch(err => ({ called: false, reason: `evaluate_failed: ${err.message}` }));

        // Wait for the portal's OWN real signal that it registered our
        // input - the Business Type dropdown becoming enabled - before
        // proceeding. Re-queries fresh each check instead of a cached
        // reference, in case an UpdatePanel re-render detaches it.
        const businessTypeEnabled = await page.waitForFunction(() => {
          const el = document.querySelector('[id*="BusinessType" i][id$="_Control"]');
          return el && !el.disabled;
        }, { timeout: 8000 }).then(() => true).catch(() => false);

        // Re-query fresh right before reading, per the same lesson -
        // don't trust a handle that may have gone stale.
        const freshClaimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
        const valueRightBeforeClick = await freshClaimIdField.inputValue().catch(() => null);

        if (valueRightBeforeClick !== String(claimId)) {
          await page.screenshot({ path: `${__dirname}/last-run-success.png`, fullPage: true }).catch(() => {});
          return {
            status: 'CHECK_COMPLETE',
            claim_id: claimId,
            navigation_method: 'href_from_dom',
            search_screen_url: searchScreenUrl,
            filled_claim_id: valueRightBeforeClick,
            business_type_enabled_before_click: businessTypeEnabled,
            business_type_call_result: businessTypeCallResult,
            nav_result: 'aborted_value_lost_before_click',
            result_state: 'VALUE_LOST',
            detected_status: null
          };
        }

        const searchButton = page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').last();

        let navResult = 'not_attempted';
        try {
          // Dual detection: we've now seen evidence pointing at both a
          // full navigation AND a same-URL partial postback on different
          // attempts. Race both real signals - whichever genuinely
          // happens first is the real answer, rather than assuming one.
          // The click must fire CONCURRENTLY with these waits, not
          // after them, or nothing would ever trigger the signals being
          // waited for.
          //
          // IMPORTANT: each race participant gets its own .catch()
          // attached immediately - a losing promise from Promise.race
          // keeps running in the background and can still reject later
          // (e.g. navigation destroying the context mid-wait). Learned
          // this the hard way earlier: an unattached rejection like that
          // crashes the entire Node process, not just this one request.
          const navPromise = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 })
            .then(() => 'navigation').catch(err => `nav_error: ${err.message}`);
          const respPromise = page.waitForResponse(r => r.request().method() === 'POST', { timeout: 15000 })
            .then(() => 'postback_response').catch(err => `resp_error: ${err.message}`);

          const outcome = await Promise.all([
            Promise.race([navPromise, respPromise]),
            searchButton.evaluate(el => el.click())
          ]);
          navResult = `detected_${outcome[0]}`;
        } catch (e) {
          navResult = `navigation_wait_failed: ${e.message}`;
        }
        await page.waitForTimeout(1500);

        // --- Read back whatever the results screen actually shows ---
        const resultsUrl = page.url();
        const claimIdValueAfterClick = await page.locator('[id$="ClaimIDCmnTextBox_Control"]').last()
          .inputValue().catch(err => `read_failed: ${err.message}`);
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

        await page.screenshot({ path: `${__dirname}/last-run-success.png`, fullPage: true }).catch(() => {});

        // === FIXED (2026-08-21) === CRITICAL SAFETY FIX. Confirmed via
        // real evidence: the previous version matched the word "Paid"
        // anywhere in the page's visible text, including the search
        // form's own "Claim Status: Denied / Paid / Suspended" label
        // options - meaning it reported "Paid" as a false positive even
        // when NO search had actually succeeded and NO claim was found.
        // This is dangerous: it could have marked real unpaid claims as
        // Paid in the Salary/Payroll system. Now: only ever reports a
        // status if a genuine results grid was found (a real table with
        // actual data rows, not the page's static form chrome). If no
        // such table exists, this returns NO_RESULTS explicitly and
        // NEVER guesses a status from surrounding text.
        const realResultsTable = dump.tables?.find(t =>
          t.rowCount > 1 && t.firstDataRowText && !/function\s+Set/.test(t.firstDataRowText)
        );
        const detectedStatus = realResultsTable
          ? (realResultsTable.firstDataRowText.match(/\b(Paid|Suspended|Denied|Rejected|In Process)\b/i)?.[1] ?? null)
          : null;
        const resultState = realResultsTable ? 'RESULTS_FOUND' : 'NO_RESULTS';

        return {
          status: 'CHECK_COMPLETE',
          claim_id: claimId,
          navigation_method: 'href_from_dom',
          search_screen_url: searchScreenUrl,
          filled_claim_id: valueRightBeforeClick,
          business_type_enabled_before_click: businessTypeEnabled,
          business_type_call_result: businessTypeCallResult,
          claim_id_value_after_click: claimIdValueAfterClick,
          nav_result: navResult,
          results_url: resultsUrl,
          result_state: resultState,
          detected_status: detectedStatus,
          raw_dump: dump
        };
      })(),
      timeout
    ]);
    return result;
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/last-run-error.png`, fullPage: true }).catch(() => {});
    return { status: 'CHECK_FAILED', claim_id: claimId, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { checkClaimStatus };
