// One-off repair pass over data/wind-history.
//
// Two jobs:
//  1. Strip stored nulls from existing records so the collector treats those
//     fields as absent (and therefore fillable) rather than settled.
//  2. Fill what the NOAA feeds still carry. The RTSW feeds only expose a short
//     rolling window, so anything older than that window is unrecoverable —
//     this reports what it could not reach instead of pretending otherwise.
//
// Safe to run repeatedly. Never overwrites a finite value with a missing one.
//
//   node scripts/backfill-wind-history.mjs           # apply
//   node scripts/backfill-wind-history.mjs --dry-run # report only
import fs from 'node:fs/promises';
import path from 'node:path';

const WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const DIR = path.join(process.cwd(), 'data', 'wind-history');
const DRY = process.argv.includes('--dry-run');

const FIELDS = {
  speed:   { from: 'wind', key: 'proton_speed',   min: 100,  max: 3000 },
  density: { from: 'wind', key: 'proton_density', min: 0.05, max: 500 },
  bt:      { from: 'mag',  key: 'bt',             min: 0,    max: 300 },
  bx:      { from: 'mag',  key: 'bx_gsm',         min: -300, max: 300 },
  by:      { from: 'mag',  key: 'by_gsm',         min: -300, max: 300 },
  bz:      { from: 'mag',  key: 'bz_gsm',         min: -300, max: 300 }
};
const NAMES = Object.keys(FIELDS);

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function parseTimeTag(tag) {
  if (typeof tag !== 'string' || !tag) return NaN;
  return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(tag) ? tag : tag + 'Z');
}

function activeByT(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r.active || !r.time_tag) continue;
    const t = parseTimeTag(r.time_tag);
    if (Number.isFinite(t) && !out.has(t)) out.set(t, r);
  }
  return out;
}

function readField(row, spec) {
  if (!row) return undefined;
  const raw = row[spec.key];
  if (raw === null || raw === undefined || raw === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) return undefined;
  return v;
}

async function main() {
  const files = (await fs.readdir(DIR).catch(() => []))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  if (!files.length) { console.log('no day files found in', DIR); return; }

  const [windRaw, magRaw] = await Promise.all([
    fetchJson(WIND_URL).catch(e => { console.warn('wind fetch failed', e); return []; }),
    fetchJson(MAG_URL).catch(e => { console.warn('mag fetch failed', e); return []; })
  ]);
  const windByT = activeByT(windRaw), magByT = activeByT(magRaw);
  const feedFrom = Math.min(
    windByT.size ? Math.min(...windByT.keys()) : Infinity,
    magByT.size ? Math.min(...magByT.keys()) : Infinity
  );
  console.log(
    `feed window starts ${Number.isFinite(feedFrom) ? new Date(feedFrom).toISOString() : '-'} ` +
    `(wind=${windByT.size} mag=${magByT.size} rows)`
  );

  const totals = { nullsStripped: 0, filled: 0, added: 0, unreachable: 0 };

  for (const f of files) {
    const day = f.replace('.jsonl', '');
    const text = await fs.readFile(path.join(DIR, f), 'utf8');
    const map = new Map();
    let stripped = 0;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let p;
      try { p = JSON.parse(line); } catch { continue; }
      if (!Number.isFinite(p?.t)) continue;
      for (const name of NAMES) {
        if (name in p && !Number.isFinite(p[name])) { delete p[name]; stripped++; }
      }
      map.set(p.t, p);
    }

    let filled = 0, added = 0;
    for (const [t, row] of [...windByT, ...magByT]) {
      if (dayOf(t) !== day) continue;
      const prev = map.get(t);
      const target = prev ?? { t };
      let gainedHere = 0;
      for (const [name, spec] of Object.entries(FIELDS)) {
        if (Number.isFinite(target[name])) continue;
        const src = spec.from === 'wind' ? windByT.get(t) : magByT.get(t);
        const v = readField(src, spec);
        if (v !== undefined) { target[name] = v; gainedHere++; }
      }
      if (!NAMES.some(k => Number.isFinite(target[k]))) continue;
      if (!prev) { map.set(t, target); added++; }
      else filled += gainedHere;
      if (!target.source && row.source) target.source = row.source;
    }

    // Count minutes still missing that the feed can no longer supply.
    let unreachable = 0;
    for (const p of map.values())
      for (const name of NAMES)
        if (!Number.isFinite(p[name])) unreachable++;

    const points = [...map.values()]
      .filter(p => NAMES.some(k => Number.isFinite(p[k])))
      .sort((a, b) => a.t - b.t);

    if (!DRY) {
      const out = points.map(p => JSON.stringify(p)).join('\n') + (points.length ? '\n' : '');
      await fs.writeFile(path.join(DIR, f), out, 'utf8');
    }

    const cov = NAMES.map(k => `${k} ${points.filter(p => Number.isFinite(p[k])).length}`).join('  ');
    console.log(`${day}: ${points.length} rows | nulls stripped ${stripped} | filled ${filled} | added ${added}`);
    console.log(`          ${cov}`);

    totals.nullsStripped += stripped;
    totals.filled += filled;
    totals.added += added;
    totals.unreachable += unreachable;
  }

  if (!DRY) {
    const manifest = (await fs.readdir(DIR))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => f.replace('.jsonl', '')).sort();
    await fs.writeFile(path.join(DIR, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }

  console.log(
    `\n${DRY ? '[dry run] ' : ''}nulls stripped ${totals.nullsStripped}, ` +
    `fields filled ${totals.filled}, rows added ${totals.added}`
  );
  console.log(
    `${totals.unreachable} field-slots remain empty — outside the NOAA rolling ` +
    `window and not recoverable. New history accumulates from now on.`
  );
}

function dayOf(t) { return new Date(t).toISOString().slice(0, 10); }

main().catch(e => { console.error(e); process.exit(1); });
