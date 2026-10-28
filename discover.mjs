// Finds the real careers page of each company in discover.json by opening its website
// in a real browser. Results go to Neon table discovered_careers.
import fs from 'fs';
import pg from 'pg';
import { chromium } from 'playwright';

const list = JSON.parse(fs.readFileSync('discover.json', 'utf8'));
const CONC = parseInt(process.env.CONCURRENCY || '10', 10);
const client = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(`create table if not exists discovered_careers (
  company_id text primary key, name text, website text, career_url text,
  status text, note text, checked_at timestamptz default now())`);

const done = new Set((await client.query(`select company_id from discovered_careers where status in ('found','no_careers')`)).rows.map(r => r.company_id));
const todo = list.filter(c => !done.has(c.id));
console.log(`to check: ${todo.length} of ${list.length}`);

const CAREER = /(career|careers|jobs|job-search|vacanc|join[- ]us|work[- ]with[- ]us|work[- ]at|recruit|opportunit|talent|hiring|employment)/i;
const BAD = /(linkedin|facebook|instagram|twitter|youtube|indeed|bayt|naukri|gulftalent|glassdoor|mailto:|tel:|javascript:|\.pdf$)/i;
const ATS = /(myworkdayjobs|oraclecloud|successfactors|taleo|lever\.co|greenhouse\.io|workable\.com|smartrecruiters|icims|eightfold|recruitee|teamtailor|jobvite|bamboohr|ultipro|peoplestrong|pageuppeople|cornerstone|hirebridge|zohorecruit|breezy|jazz\.co)/i;

function score(href, text) {
  let s = 0;
  const h = href.toLowerCase(), t = (text || '').toLowerCase();
  if (ATS.test(h)) s += 6;
  if (/careers?/.test(t)) s += 4;
  if (/careers?/.test(h)) s += 3;
  if (/jobs|vacanc/.test(t)) s += 3;
  if (/jobs|vacanc/.test(h)) s += 2;
  if (/join us|work with us|work at/.test(t)) s += 3;
  if (/apply|search/.test(t)) s += 1;
  if (/news|blog|press|event|article|story/.test(h)) s -= 4;
  return s;
}

async function loads(page, url) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (r && r.status() >= 400) return { ok: false, note: 'HTTP ' + r.status() };
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => document.body ? document.body.innerText.length : 0);
    if (n < 200) return { ok: false, note: 'page empty or blocked' };
    return { ok: true, final: page.url() };
  } catch (e) { return { ok: false, note: String(e.message).split('\n')[0].slice(0, 120) }; }
}

async function findOne(ctx, c) {
  const page = await ctx.newPage();
  try {
    const home = await loads(page, c.website_url);
    if (!home.ok) return { status: 'site_failed', note: home.note };
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) })));
    const cands = [];
    for (const l of links) {
      if (BAD.test(l.href) || !/^https?:/.test(l.href)) continue;
      if (!(CAREER.test(l.href) || CAREER.test(l.text))) continue;
      cands.push({ ...l, s: score(l.href, l.text) });
    }
    cands.sort((a, b) => b.s - a.s);
    const seen = new Set(), top = [];
    for (const x of cands) { const k = x.href.split('#')[0]; if (!seen.has(k)) { seen.add(k); top.push(k); } if (top.length >= 4) break; }
    // common paths as fallback
    const origin = new URL(home.final).origin;
    for (const p of ['/careers', '/en/careers', '/careers/', '/jobs', '/about-us/careers']) { const u = origin + p; if (!seen.has(u)) top.push(u); }
    let tried = 0;
    for (const u of top) {
      if (tried++ >= 6) break;
      const r = await loads(page, u);
      if (r.ok) {
        const t = await page.evaluate(() => (document.title + ' ' + document.body.innerText.slice(0, 1500)).toLowerCase());
        if (/(career|job|vacanc|join|opportunit|apply|hiring)/.test(t)) return { status: 'found', career_url: r.final };
      }
    }
    return { status: 'no_careers', note: 'no working careers link on site' };
  } finally { await page.close().catch(() => {}); }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', locale: 'en-AE' });
let idx = 0, found = 0;
async function worker() {
  while (idx < todo.length) {
    const c = todo[idx++];
    let r;
    try { r = await findOne(ctx, c); } catch (e) { r = { status: 'site_failed', note: String(e.message).slice(0, 120) }; }
    if (r.status === 'found') found++;
    await client.query(`insert into discovered_careers (company_id,name,website,career_url,status,note,checked_at) values ($1,$2,$3,$4,$5,$6,now())
      on conflict (company_id) do update set career_url=excluded.career_url,status=excluded.status,note=excluded.note,checked_at=now()`,
      [c.id, c.name, c.website_url, r.career_url || null, r.status, r.note || null]);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await browser.close();
const sum = await client.query(`select status, count(*) from discovered_careers group by 1`);
console.log(JSON.stringify(sum.rows));
await client.end();
