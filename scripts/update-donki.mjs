// Fetches NASA DONKI CME/FLR/IPS/GST/SEP events (last 3 days) and saves as static JSON
// in the repo so the page can read them same-origin, avoiding browser CORS/proxy flakiness.
import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = 'ELqmf5t53DLXh0h1K3aKiaTWamKenTg7RzP8pnd5';
const DIR = path.join(process.cwd(), 'data', 'donki');
const TYPES = ['FLR', 'IPS'];

function dateRange(days) {
  const end = new Date(), start = new Date(end.getTime() - days * 86400000);
  const f = x => x.toISOString().slice(0, 10);
  return { start: f(start), end: f(end) };
}

async function fetchType(type) {
  const { start, end } = dateRange(3);
  const url = `https://api.nasa.gov/DONKI/${type}?startDate=${start}&endDate=${end}&api_key=${API_KEY}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${type} -> HTTP ${r.status}`);
  return r.json();
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  for (const type of TYPES) {
    try {
      const data = await fetchType(type);
      await fs.writeFile(path.join(DIR, `${type.toLowerCase()}.json`), JSON.stringify(data), 'utf8');
      console.log(`Saved ${type}: ${Array.isArray(data) ? data.length : 0} item(s)`);
    } catch (e) {
      console.warn(`${type} fetch failed, keeping previous file`, e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
