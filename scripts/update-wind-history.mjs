// Run periodically (GitHub Actions) to accumulate NOAA RTSW solar-wind history
// into daily JSONL files, since the live NOAA feed only exposes a short rolling window.
import fs from 'node:fs/promises';
import path from 'node:path';

const WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const DIR = path.join(process.cwd(), 'data', 'wind-history');
const KEEP_DAYS = 5;

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function activeRows(rows) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    if (!r.active || !r.time_tag || seen.has(r.time_tag)) continue;
    seen.add(r.time_tag);
    const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(r.time_tag) ? r.time_tag : r.time_tag + 'Z');
    if (!Number.isFinite(t)) continue;
    out.push({ t, r });
  }
  return out;
}

function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10);
}

async function loadDayFile(day) {
  try {
    const text = await fs.readFile(path.join(DIR, `${day}.jsonl`), 'utf8');
    const map = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const p = JSON.parse(line);
      map.set(p.t, p);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveDayFile(day, map) {
  const points = [...map.values()].sort((a, b) => a.t - b.t);
  const text = points.map(p => JSON.stringify(p)).join('\n') + '\n';
  await fs.writeFile(path.join(DIR, `${day}.jsonl`), text, 'utf8');
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const [windRaw, magRaw] = await Promise.all([
    fetchJson(WIND_URL).catch(e => { console.warn('wind fetch failed', e); return []; }),
    fetchJson(MAG_URL).catch(e => { console.warn('mag fetch failed', e); return []; })
  ]);

  const windByT = new Map(activeRows(windRaw).map(({ t, r }) => [t, r]));
  const magByT = new Map(activeRows(magRaw).map(({ t, r }) => [t, r]));
  const allT = new Set([...windByT.keys(), ...magByT.keys()]);

  const byDay = new Map();
  for (const t of allT) {
    const w = windByT.get(t), m = magByT.get(t);
    const point = {
      t,
      speed: w && Number(w.proton_speed) >= 100 && Number(w.proton_speed) <= 3000 ? Number(w.proton_speed) : null,
      density: w && Number(w.proton_density) >= 0.05 && Number(w.proton_density) <= 500 ? Number(w.proton_density) : null,
      bt: m && Number(m.bt) >= 0 && Number(m.bt) <= 300 ? Number(m.bt) : null,
      bx: m && Math.abs(Number(m.bx_gsm)) <= 300 ? Number(m.bx_gsm) : null,
      by: m && Math.abs(Number(m.by_gsm)) <= 300 ? Number(m.by_gsm) : null,
      bz: m && Math.abs(Number(m.bz_gsm)) <= 300 ? Number(m.bz_gsm) : null
    };
    const day = dayKey(t);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(point);
  }

  for (const [day, points] of byDay) {
    const map = await loadDayFile(day);
    for (const p of points) map.set(p.t, p);
    await saveDayFile(day, map);
  }

  // Prune files older than KEEP_DAYS
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const files = await fs.readdir(DIR).catch(() => []);
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    if (Date.parse(m[1] + 'T23:59:59Z') < cutoff) await fs.unlink(path.join(DIR, f)).catch(() => {});
  }

  // Manifest of available day files, for the page to know what to fetch.
  const manifest = (await fs.readdir(DIR).catch(() => []))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map(f => f.replace('.jsonl', ''))
    .sort();
  await fs.writeFile(path.join(DIR, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  console.log(`Updated ${byDay.size} day file(s): ${[...byDay.keys()].join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
