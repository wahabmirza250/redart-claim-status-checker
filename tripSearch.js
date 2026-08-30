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


async function locateSearchField(page, role) {
  const selectors = {
    member: [
      '[id$="MemberIDCmnTextBox_Control"]',
      'input[id*="MemberID" i]',
      'input[name*="MemberID" i]'
    ],
    from: [
      '[id$="ServiceFromCmnDate_Control"]',
      '[id$="ServiceFromDateCmnDate_Control"]',
      'input[id*="ServiceFrom" i]',
      'input[name*="ServiceFrom" i]',
      'input[id*="FromDate" i]',
      'input[name*="FromDate" i]'
    ],
    to: [
      '[id$="ServiceToCmnDate_Control"]',
      '[id$="ServiceToDateCmnDate_Control"]',
      'input[id*="ServiceTo" i]',
      'input[name*="ServiceTo" i]',
      'input[id*="ToDate" i]',
      'input[name*="ToDate" i]'
    ]
  };

  for (const selector of selectors[role]) {
    const field = page.locator(selector).filter({ visible: true }).first();
    if (await field.isVisible().catch(() => false)) return field;
  }

  // HCPF occasionally changes the generated ASP.NET IDs. Fall back to the
  // visible Service Information row and select its two date inputs by order.
  const marked = await page.evaluate((wantedRole) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inputs = [...document.querySelectorAll('input')].filter(el =>
      visible(el) && !['hidden', 'button', 'submit', 'checkbox', 'radio'].includes((el.type || '').toLowerCase())
    );

    let target = null;
    if (wantedRole === 'member') {
      target = inputs.find(el => {
        const context = [el.id, el.name, el.getAttribute('aria-label'), el.closest('tr,div,td')?.innerText]
          .filter(Boolean).join(' ');
        return /member\s*id/i.test(context);
      });
    } else {
      const containers = [...document.querySelectorAll('tr, fieldset, .form-group, div')].filter(visible);
      const serviceRow = containers
        .filter(el => /Service\s+From/i.test(el.innerText || '') && /\bTo\b/i.test(el.innerText || ''))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        .find(el => {
          const fields = [...el.querySelectorAll('input')].filter(input =>
            visible(input) && !['hidden', 'button', 'submit', 'checkbox', 'radio'].includes((input.type || '').toLowerCase())
          );
          return fields.length >= 2;
        });
      if (serviceRow) {
        const fields = [...serviceRow.querySelectorAll('input')].filter(input =>
          visible(input) && !['hidden', 'button', 'submit', 'checkbox', 'radio'].includes((input.type || '').toLowerCase())
        );
        target = wantedRole === 'from' ? fields[0] : fields[1];
      }
    }

    if (!target) return false;
    target.setAttribute('data-redart-search-role', wantedRole);
    return true;
  }, role);

  if (marked) return page.locator(`[data-redart-search-role="${role}"]`).first();

  const diagnostics = await page.evaluate(() => [...document.querySelectorAll('input')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.type !== 'hidden';
    })
    .map(el => ({ id: el.id || null, name: el.name || null, type: el.type || null }))
    .slice(0, 30));
  throw new Error(`Could not locate HCPF ${role} search field. Visible inputs: ${JSON.stringify(diagnostics)}`);
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

    const memberField = await locateSearchField(page, 'member');
    const fromField = await locateSearchField(page, 'from');
    const toField = await locateSearchField(page, 'to');

    for (const [field, value] of [[memberField, wantedMember], [fromField, wantedDate], [toField, wantedDate]]) {
      await field.click();
      await field.fill(value);
      await field.press('Tab').catch(() => {});
    }

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
