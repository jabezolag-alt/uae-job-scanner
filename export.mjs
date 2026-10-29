import pg from 'pg';
import fs from 'fs';
const c = new pg.Client({ connectionString: process.env.NEON_DATABASE_URL });
await c.connect();
const r = await c.query("select company_id,name,website,career_url,status,note from discovered_careers order by name");
fs.writeFileSync('discovered_export.json', JSON.stringify(r.rows));
await c.end();
console.log(r.rows.length);
