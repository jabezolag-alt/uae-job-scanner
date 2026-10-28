// UAE L&D job scanner: opens each career page in a real browser and saves
// matching job links to Neon (table scan_candidates). A Claude scheduled task
// then checks dates and adds good ones to the Jobs page.
import fs from 'node:fs';
import pg from 'pg';
import { chromium } from 'playwright';

const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const PAGE_TIMEOUT = 30000;
const TOPIC = /\b(l\s?&\s?d|learning|talent|training|trainer|organi[sz]ation(al)? development|people development|capability|instructional|e-?learning|leadership development|succession|hr business partner|hrbp|development)\b/i;
const TITLE = /\b(manager|specialist|executive|officer|lead|head|director|partner|coordinator|supervisor|advisor|adviser|consultant|designer|facilitator|trainer|analyst|assistant|vice president|vp|avp|senior|junior|associate|business partner|generalist)\b/i;
const NOT_JOB = /(talent community|talent network|talent pool|talent pipeline|talent programs?|early (talent|career)|(our|group|company'?s|ethics|learning|inclusive|the \\w+) culture|culture (and|&) (values|diversity|inclusion)|talent acquisition|our values|join our|privacy|policy|academy|lms portal|learning hub|lifelong|digital learning|corporate training|personal training|training institute|certification|fitness|school for life|webinar|podcast|emiratis?ation|national talent community|career fair|graduate|internship|apprentice)/i;
const ROLE = { test: (t) => TOPIC.test(t) && TITLE.test(t) && !NOT_JOB.test(t) };
const NOISE = /^(learn more|read more|apply now|view all|see all|search|home|careers?|jobs?|sign in|log ?in|menu|skip to|cookie|privacy|terms|about|contact)$/i;

const companies = JSON.parse(fs.readFileSync('companies.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query(`create table if not exists scan_candidates (
  fingerprint text primary key, company_id text, company_name text, title text, url text,
  context text, found_at timestamptz default now(), reviewed boolean default false)`);
await db.query(`create table if not exists scan_status (
  company_id text primary key, company_name text, url text, status text, matches int,
  note text, scanned_at timestamptz default now())`);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const jobIdFrom = (u) => (u.match(/(\d{3,})(?!.*\d{3,})/) || [])[1] || '';

async function scanOne(browser, c) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (resp && resp.status() >= 400) return { status: 'failed', matches: 0, note: `HTTP ${resp.status()}`, found: [] };
    const found = await page.evaluate(() => {
      const items = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 160) continue;
        const card = a.closest('li, article, tr, [class*="job"], [class*="card"], [class*="result"]');
        const context = ((card && card.innerText) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
        items.push({ text, href: a.href, context });
      }
      return items;
    });
    const hits = found.filter((f) => ROLE.test(f.text) && !NOISE.test(f.text) && f.text.split(' ').length >= 2);
    const seen = new Set();
    const uniq = hits.filter((h) => (seen.has(h.href) ? false : seen.add(h.href)));
    const bodyLen = await page.evaluate(() => document.body.innerText.length);
    if (bodyLen < 200) return { status: 'failed', matches: 0, note: 'page empty or blocked', found: [] };
    return { status: 'ok', matches: uniq.length, note: '', found: uniq };
  } catch (e) {
    return { status: 'failed', matches: 0, note: String(e.message).slice(0, 150), found: [] };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch();
const queue = [...companies.filter((c) => !c.needs_review), ...companies.filter((c) => c.needs_review)];
let ok = 0, failed = 0, added = 0;
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    const r = await scanOne(browser, c);
    r.status === 'ok' ? ok++ : failed++;
    for (const f of r.found) {
      const words = f.text.toLowerCase().match(/[a-z0-9]+/g).slice(0, 4).join('-');
      const fp = [slug(c.id), words, jobIdFrom(f.href)].filter(Boolean).join('-').slice(0, 190);
      const res = await db.query(
        'insert into scan_candidates(fingerprint,company_id,company_name,title,url,context) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
        [fp, c.id, c.name, f.text, f.href, f.context]);
      added += res.rowCount;
    }
    await db.query(
      `insert into scan_status(company_id,company_name,url,status,matches,note,scanned_at) values($1,$2,$3,$4,$5,$6,now())
       on conflict (company_id) do update set status=$4, matches=$5, note=$6, scanned_at=now(), url=$3`,
      [c.id, c.name, c.url, r.status, r.matches, r.note]);
    console.log(`${r.status.padEnd(6)} ${String(r.matches).padStart(2)}  ${c.name}  ${r.note}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();
await db.end();
console.log(`\nDone. Read OK: ${ok}. Failed: ${failed}. New candidate links saved: ${added}.`);
