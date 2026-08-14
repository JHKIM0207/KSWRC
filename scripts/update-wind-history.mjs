// Run periodically (GitHub Actions) to accumulate NOAA RTSW solar-wind history
// into daily JSONL files, since the live NOAA feed only exposes a short rolling window.
//
// Invariant: this script only ever ADDS information to the archive. A field is
// written only when the feed supplies a valid number; a field already stored is
// never replaced by a missing one. Records are merged field-by-field, so a
// timestamp present in one feed but not the other cannot erase the other feed's
// values. (The previous version rebuilt each record from scratch and wrote null
// for whatever the current response lacked, which quietly destroyed history:
// the mag feed's rolling window outlives the wind feed's, so every run overwrote
// good speed/density values with null for timestamps that only mag still carried.)
import fs from 'node:fs/promises';
import path from 'node:path';

const WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const DIR = path.join(process.cwd(), 'data', 'wind-history');

// Must exceed the dashboard's 5-day x-axis: the window start falls mid-day, so
// the 6th day back is still partly on screen. One extra day of margin.
const KEEP_DAYS = 7;

// Physical plausibility gates. A value outside its range is treated as absent
// rather than stored, so a bad reading never displaces a good one.
const FIELDS = {
  speed:   { from: 'wind', key: 'proton_speed',   min: 100,  max: 3000 },
  density: { from: 'wind', key: 'proton_density', min: 0.05, max: 500 },
  bt:      { from: 'mag',  key: 'bt',             min: 0,    max: 300 },
  bx:      { from: 'mag',  key: 'bx_gsm',         min: -300, max: 300 },
  by:      { from: 'mag',  key: 'by_gsm',         min: -300, max: 300 },
  bz:      { from: 'mag',  key: 'bz_gsm',         min: -300, max: 300 }
};

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function parseTimeTag(tag) {
  if (typeof tag !== 'string' || !tag) return NaN;
  return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(tag) ? tag : tag + 'Z');
}

function activeRows(rows) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    if (!r.active || !r.time_tag || seen.has(r.time_tag)) continue;
    seen.add(r.time_tag);
    const t = parseTimeTag(r.time_tag);
    if (!Number.isFinite(t)) continue;
    out.push({ t, r });
  }
  return out;
}

// Reads one field off a feed row, returning undefined (not null) when the value
// is missing or implausible. undefined means "say nothing about this field".
function readField(row, spec) {
  if (!row) return undefined;
  const raw = row[spec.key];
  if (raw === null || raw === undefined || raw === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) return undefined;
  return v;
}

// Builds a record carrying ONLY the fields this response actually supplied.
// Absent fields are omitted entirely rather than set to null.
function buildPoint(t, windRow, magRow) {
  const point = { t };
  for (const [name, spec] of Object.entries(FIELDS)) {
    const v = readField(spec.from === 'wind' ? windRow : magRow, spec);
    if (v !== undefined) point[name] = v;
  }
  const source = windRow?.source ?? magRow?.source;
  if (source) point.source = source;
  return point;
}

// Field-by-field merge. An incoming value wins only if it is a finite number;
// otherwise whatever is already on disk survives. This is what makes repeated
// runs non-destructive.
function mergePoint(prev, next) {
  const out = { ...prev };
  let gained = 0;
  for (const name of Object.keys(FIELDS)) {
    const v = next[name];
    if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(out[name])) gained++;
    out[name] = v;
  }
  if (next.source && !out.source) out.source = next.source;
  out.t = prev.t;
  return { point: out, gained };
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
      let p;
      try { p = JSON.parse(line); } catch { continue; }
      if (!Number.isFinite(p?.t)) continue;
      // Normalise legacy records: drop stored nulls so they read as "absent"
      // and become fillable by this run instead of blocking it.
      for (const name of Object.keys(FIELDS)) {
        if (p[name] === null || !Number.isFinite(p[name])) delete p[name];
      }
      map.set(p.t, p);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveDayFile(day, map) {
  const points = [...map.values()].sort((a, b) => a.t - b.t);
  // A record with no measurements is not worth a line.
  const kept = points.filter(p => Object.keys(FIELDS).some(k => Number.isFinite(p[k])));
  const text = kept.map(p => JSON.stringify(p)).join('\n') + (kept.length ? '\n' : '');
  await fs.writeFile(path.join(DIR, `${day}.jsonl`), text, 'utf8');
  return kept.length;
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const [windRaw, magRaw] = await Promise.all([
    fetchJson(WIND_URL).catch(e => { console.warn('wind fetch failed', e); return []; }),
    fetchJson(MAG_URL).catch(e => { console.warn('mag fetch failed', e); return []; })
  ]);

  const wind = activeRows(windRaw), mag = activeRows(magRaw);
  const windByT = new Map(wind.map(({ t, r }) => [t, r]));
  const magByT = new Map(mag.map(({ t, r }) => [t, r]));

  // Diagnostics: if the two feeds' windows diverge, it shows up here first.
  const windOnly = [...windByT.keys()].filter(t => !magByT.has(t)).length;
  const magOnly = [...magByT.keys()].filter(t => !windByT.has(t)).length;
  const earliest = m => (m.size ? new Date(Math.min(...m.keys())).toISOString() : '-');
  console.log(
    `feeds: wind=${windByT.size} (from ${earliest(windByT)}) ` +
    `mag=${magByT.size} (from ${earliest(magByT)}) ` +
    `wind-only=${windOnly} mag-only=${magOnly}`
  );

  const byDay = new Map();
  for (const t of new Set([...windByT.keys(), ...magByT.keys()])) {
    const point = buildPoint(t, windByT.get(t), magByT.get(t));
    // Nothing measurable at this timestamp — do not create a record for it.
    if (!Object.keys(FIELDS).some(k => Number.isFinite(point[k]))) continue;
    const day = dayKey(t);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(point);
  }

  let added = 0, filled = 0;
  const summary = [];
  for (const [day, points] of byDay) {
    const map = await loadDayFile(day);
    for (const p of points) {
      const prev = map.get(p.t);
      if (!prev) { map.set(p.t, p); added++; continue; }
      const { point, gained } = mergePoint(prev, p);
      map.set(p.t, point);
      filled += gained;
    }
    const n = await saveDayFile(day, map);
    summary.push(`${day}(${n})`);
  }

  // Prune day files outside the retention window.
  const cutoffDay = dayKey(Date.now() - KEEP_DAYS * 86400000);
  const files = await fs.readdir(DIR).catch(() => []);
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < cutoffDay) await fs.unlink(path.join(DIR, f)).catch(() => {});
  }

  // Manifest of available day files, for the page to know what to fetch.
  const manifest = (await fs.readdir(DIR).catch(() => []))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map(f => f.replace('.jsonl', ''))
    .sort();
  await fs.writeFile(path.join(DIR, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  console.log(`new points: ${added}, gaps filled: ${filled}`);
  console.log(`day files: ${summary.sort().join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
