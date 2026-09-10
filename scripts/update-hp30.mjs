// Fetches GFZ Hp30 and writes data/hp30.json. Runs in GitHub Actions, where
// there is no CORS restriction — the browser cannot call kp.gfz.de directly.
import { mkdir, writeFile } from 'node:fs/promises';

const DAYS = 8;
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const end = new Date();
const start = new Date(end.getTime() - DAYS * 864e5);
const url = `https://kp.gfz.de/app/json/?start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}&index=Hp30`;

async function fetchJson(attempt = 1) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'space-weather-dashboard/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise(r => setTimeout(r, attempt * 3000));
    return fetchJson(attempt + 1);
  }
}

const data = await fetchJson();
const vals = data?.Hp30;
const times = data?.datetime;
if (!Array.isArray(vals) || !Array.isArray(times) || !vals.length) {
  // An empty payload must not overwrite a good archive.
  console.error('Hp30 payload empty; leaving existing archive untouched.');
  process.exit(0);
}
await mkdir('data', { recursive: true });
await writeFile('data/hp30.json', JSON.stringify({
  Hp30: vals,
  datetime: times,
  meta: { ...(data.meta || {}), fetched: iso(new Date()) }
}));
console.log(`Wrote data/hp30.json with ${vals.length} points (${times[0]} → ${times[times.length - 1]}).`);
