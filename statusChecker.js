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
        // === FIXED (2026-08-22, round 9) === Every structural theory
        // about the Claim ID field itself is now disproven with hard
        // evidence - it's enabled, correctly named, genuinely in the
        // form, visible, no hidden proxy. The value is correct right up
        // to the moment of submission and still doesn't survive. This
        // points to something at the navigation/session level, not the
        // field: direct page.goto() to this URL, while it loads the
        // correct real page, may not carry the exact same internal
        // session-validation lineage (ASP.NET's anti-tampering tokens)
        // as a genuine browser click would. This is the one real
        // combination not yet tried: force-click the real link itself
        // (bypassing Playwright's normal "must be visible" check, since
        // we know it's real but hidden inside a collapsed menu) rather
        // than jump straight to its URL - a real click event through
        // the real DOM element, which may establish page state a raw
        // URL load doesn't.
        const searchLink = page.locator('a[title="Search Claims"]').first();
        const href = await searchLink.getAttribute('href');
        if (!href) {
          throw new Error('Could not find the real Search Claims link href on the page after login.');
        }
        let navigationMethodUsed = 'force_click';
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }),
            searchLink.click({ force: true, timeout: 8000 })
          ]);
        } catch (e) {
          // Fall back to the previously-proven-reliable direct URL
          // method if the force-click doesn't work for any reason - we
          // don't want to lose existing reliability while testing this.
          navigationMethodUsed = 'direct_url_fallback';
          const searchUrl = new URL(href, page.url()).toString();
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 });
        }
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const searchScreenUrl = page.url();

        // --- Search by Claim ID (confirmed: alone is sufficient) ---
        const claimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
        await claimIdField.click();
        await claimIdField.fill('');
        await claimIdField.type(String(claimId), { delay: 80 });

        // === ADDED (2026-08-21, round 6) === Real diagnostic: check the
        // value at the EARLIEST possible moment, right after typing and
        // before Tab/blur ever fires. Suspicion: our own press('Tab')
        // call may itself be triggering the portal's mask-validation
        // logic and wiping the field BEFORE the explicit handler call
        // that follows - meaning the handler was correctly invoked on
        // an already-empty field, not that the handler itself failed.
        const valueImmediatelyAfterTyping = await claimIdField.inputValue().catch(() => null);

        // === ADDED (2026-08-21, round 7) === Real, precise evidence
        // now points to a DUPLICATE ELEMENT mismatch: typing lands on
        // whichever node .last() resolves to at that moment, but the
        // portal's own inline handler looks the field up by its EXACT,
        // hardcoded ID string (visible in the handler attribute itself,
        // e.g. "dnn_ctr1016_..._ClaimIDCmnTextBox_Control") via $get() -
        // if that's a DIFFERENT node than the one we typed into, the
        // portal sees it as empty regardless of what we typed. Fix:
        // extract that exact real ID directly from the handler
        // attribute (which we already read), then explicitly verify and
        // set the value on that SPECIFIC element - the same one the
        // portal itself will actually read - not a suffix-based guess.
        const handlerAttrProbe = await claimIdField.evaluate(el =>
          el.getAttribute('onkeyup') || el.getAttribute('onchange') || ''
        ).catch(() => '');
        const exactIdMatch = handlerAttrProbe.match(/SetBusinessType\('([^']+)'/);
        const exactClaimIdFieldId = exactIdMatch ? exactIdMatch[1] : null;

        const duplicateNodeCheck = await page.evaluate(([targetValue, exactId]) => {
          const nodes = Array.from(document.querySelectorAll('[id$="ClaimIDCmnTextBox_Control"]'));
          const byExactId = exactId ? document.getElementById(exactId) : null;
          // Set the value directly on every matching node, including
          // the specific one the portal's own code will actually read -
          // belt-and-suspenders, since we now have real evidence more
          // than one may exist.
          nodes.forEach(n => { n.value = targetValue; });
          if (byExactId) byExactId.value = targetValue;
          return {
            nodeCount: nodes.length,
            exactIdFound: Boolean(byExactId),
            exactIdValueAfterSet: byExactId ? byExactId.value : null,
            allNodeValues: nodes.map(n => n.value)
          };
        }, [String(claimId), exactClaimIdFieldId]).catch(err => ({ error: err.message }));

        // === ADDED (2026-08-21, round 8) === Duplicate-node theory now
        // DISPROVEN with real evidence (exactly one node, correct value
        // confirmed set). Remaining real possibilities, checked all at
        // once: the field is disabled/readonly (never posted), missing
        // its "name" attribute entirely (never posted), sitting inside a
        // hidden/inactive tab panel (excluded from postback), or there's
        // a separate hidden mask-extender proxy field that's the one
        // actually read on submit while this visible box is cosmetic.
        const postFormDiagnostic = await page.evaluate((exactId) => {
          const el = exactId ? document.getElementById(exactId) : null;
          if (!el) return { error: 'element_not_found_for_diagnostic' };
          let hiddenAncestor = null;
          let n = el;
          while (n) {
            const style = window.getComputedStyle(n);
            if (style.display === 'none' || style.visibility === 'hidden') {
              hiddenAncestor = n.id || n.className || n.tagName;
              break;
            }
            n = n.parentElement;
          }
          const siblingHiddens = Array.from(document.querySelectorAll('input[type="hidden"][id*="ClaimID" i]'))
            .map(h => ({ id: h.id, name: h.getAttribute('name'), value: h.value }));
          return {
            disabled: el.disabled,
            readOnly: el.readOnly,
            name: el.getAttribute('name'),
            inForm: Boolean(el.closest('form')),
            formId: el.closest('form')?.id ?? null,
            hiddenAncestor,
            siblingHiddens
          };
        }, exactClaimIdFieldId).catch(err => ({ error: err.message }));

        await claimIdField.press('Tab').catch(() => {});
        await claimIdField.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }).catch(() => {});

        // === FIXED (2026-08-22, final) === Confirmed via a real, direct
        // DOM inspection of the live Search Claims screen: there is NO
        // "Business Type" dropdown anywhere on this page. The inline
        // onkeyup="SetBusinessType(...)" handler is a global DNN layout
        // artifact that doesn't apply here - it was never going to fire
        // meaningfully, and the entire wait/invoke logic built around it
        // was chasing a control that doesn't exist. Removed entirely.
        // Confirmed instead: Claim ID is fully enabled and usable from
        // page load with zero prerequisites, and the real page text
        // itself confirms Claim ID alone is a valid, complete search.

        // Re-query fresh right before reading, per the earlier lesson -
        // don't trust a handle that may have gone stale.
        const freshClaimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
        const valueRightBeforeClick = await freshClaimIdField.inputValue().catch(() => null);

        if (valueRightBeforeClick !== String(claimId)) {
          await page.screenshot({ path: `${__dirname}/last-run-success.png`, fullPage: true }).catch(() => {});
          return {
            status: 'CHECK_COMPLETE',
            claim_id: claimId,
            navigation_method: navigationMethodUsed,
            search_screen_url: searchScreenUrl,
            filled_claim_id: valueRightBeforeClick,
            value_immediately_after_typing: valueImmediatelyAfterTyping,
            duplicate_node_check: duplicateNodeCheck,
            post_form_diagnostic: postFormDiagnostic,
            exact_claim_id_field_id: exactClaimIdFieldId,
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
          navigation_method: navigationMethodUsed,
          search_screen_url: searchScreenUrl,
          filled_claim_id: valueRightBeforeClick,
          value_immediately_after_typing: valueImmediatelyAfterTyping,
          duplicate_node_check: duplicateNodeCheck,
          post_form_diagnostic: postFormDiagnostic,
          exact_claim_id_field_id: exactClaimIdFieldId,
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
