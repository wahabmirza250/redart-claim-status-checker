/**
 * Read-only HCPF search by member Medicaid ID and service date.
 * Returns every matching portal claim so multiple valid trips on one day
 * are preserved and can be matched by claim ID/amount.
 */
const { chromium } = require('playwright');
const fs = require('fs');

function loadConfig() {
  return JSON.parse(fs.readFileSync(`${__dirname}/hcpf-colorado.json`, 'utf8'));
}

async function fetchPortalCredentials(companyId) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('BILLING_API_URL / BILLING_API_KEY env vars are not set.');
  let url = `${baseUrl.replace(/\/$/, '')}/api/public/get-portal-credential?portal_id=hfc-colorado`;
  if (companyId) url += `&company_id=${encodeURIComponent(companyId)}`;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Portal credential lookup failed (${res.status}): ${body.error || body.message || 'unknown error'}`);
  if (!body.login_email || !body.login_password) throw new Error('Portal credential response is incomplete.');
  return { username: body.login_email, password: body.login_password };
}

async function freshSearchUrl(page) {
  const claims = page.getByText('Claims', { exact: true }).first();
  await claims.hover({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const href = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    const candidates = links.filter(a => /Search Claims/i.test((a.textContent || '') + ' ' + (a.title || '')) || /\/Claims\/SearchClaims\//i.test(a.getAttribute('href') || ''));
    const chosen = candidates.find(a => {
      const r = a.getBoundingClientRect();
      return /SearchClaims/i.test(a.getAttribute('href') || '') && r.width > 0 && r.height > 0;
    }) || candidates.find(a => /SearchClaims/i.test(a.getAttribute('href') || ''));
    return chosen && chosen.getAttribute('href');
  });
  if (!href) throw new Error('Could not find a fresh Search Claims link after login.');
  return new URL(href, page.url()).toString();
}

function normalizeDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error('service_date must be MM/DD/YYYY or YYYY-MM-DD.');
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
}

async function searchClaimsByMemberDate(companyId, memberId, serviceDate) {
  const config = loadConfig();
  const credentials = await fetchPortalCredentials(companyId || null);
  const wantedMember = String(memberId || '').trim();
  const wantedDate = normalizeDate(serviceDate);
  if (!wantedMember) throw new Error('member_id is required.');

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await context.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill(config.selectors.login.usernameField, credentials.username);
    await page.fill(config.selectors.login.passwordField, credentials.password);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (/login/i.test(page.url()) || await page.locator('input[type="password"]').isVisible().catch(() => false)) {
      throw new Error('Portal login did not complete; another session may have invalidated it.');
    }

    await page.goto(await freshSearchUrl(page), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const memberField = page.locator('input[id*="MemberID"], input[name*="MemberID"]').first();
    const fromField = page.locator('input[id*="ServiceFrom"], input[name*="ServiceFrom"]').first();
    const toField = page.locator('input[id*="ServiceTo"], input[name*="ServiceTo"]').first();
    await memberField.waitFor({ state: 'visible', timeout: 12000 });
    await fromField.waitFor({ state: 'visible', timeout: 12000 });
    await toField.waitFor({ state: 'visible', timeout: 12000 });

    await memberField.fill(wantedMember);
    await fromField.fill(wantedDate);
    await toField.fill(wantedDate);

    const searchButton = page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').first();
    await searchButton.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(900);

    const claims = await page.evaluate(({ wantedMember, wantedDate }) => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const results = [];
      for (const row of document.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td')].map(c => clean(c.innerText || c.textContent)).filter(Boolean);
        const joined = cells.join(' | ');
        const claimId = joined.match(/\b\d{12,14}\b/)?.[0];
        if (!claimId || !joined.includes(wantedMember) || !joined.includes(wantedDate)) continue;
        const status = joined.match(/\b(Paid|Suspended|Denied|Rejected|In Process|Processing)\b/i)?.[1] || null;
        const amounts = joined.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
        results.push({
          claim_id: claimId,
          member_id: wantedMember,
          service_date: wantedDate,
          status,
          paid_amount: amounts.length ? amounts[amounts.length - 1] : null,
          row: cells
        });
      }
      return results;
    }, { wantedMember, wantedDate });

    return {
      status: 'SEARCH_COMPLETE',
      member_id: wantedMember,
      service_date: wantedDate,
      result_state: claims.length ? 'RESULTS_FOUND' : 'NO_RESULTS',
      match_count: claims.length,
      claims
    };
  } catch (err) {
    return { status: 'SEARCH_FAILED', member_id: wantedMember, service_date: wantedDate, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { searchClaimsByMemberDate };
