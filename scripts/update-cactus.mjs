// Fetches the SIDC CACTUS automated CME catalog and saves recent entries as JSON
// in the repo so the page can read them same-origin (avoids CORS/proxy flakiness).
import fs from 'node:fs/promises';
import path from 'node:path';

const URL_ = 'https://www.sidc.be/cactus/out/cmecat.txt';
const DIR = path.join(process.cwd(), 'data', 'cactus');
const KEEP_DAYS = 10;

function parseCatalog(text) {
  const cme = [], flow = [];
  let inFlow = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s*Flow\s*\|/i.test(line)) { inFlow = true; continue; }
    if (line.startsWith('#') || line.startsWith(':')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9 || !/^\d+$/.test(parts[0])) continue;
    const [numStr, t0Str, dt0, pa, da, v, dv, minv, maxv, halo] = parts;
    const iso = t0Str.replace(/\//g, '-').replace(' ', 'T') + ':00Z';
    const t0 = Date.parse(iso);
    if (!Number.isFinite(t0)) continue;
    const entry = {
      cme: numStr, t0, dt0: Number(dt0), pa: Number(pa), da: Number(da),
      v: Number(v), dv: Number(dv), minv: Number(minv), maxv: Number(maxv),
      halo: (halo || '').trim() || null
    };
    (inFlow ? flow : cme).push(entry);
  }
  cme.sort((a, b) => b.t0 - a.t0);
  flow.sort((a, b) => b.t0 - a.t0);
  return { cme, flow };
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const r = await fetch(URL_, { cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpaceWeatherDashboard/1.0)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const { cme: allCme, flow: allFlow } = parseCatalog(text);
  if (allCme.length === 0 && allFlow.length === 0) {
    console.warn('Parsed 0 entries. First 500 chars of response:');
    console.warn(text.slice(0, 500));
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const recentCme = allCme.filter(e => e.t0 >= cutoff);
  const recentFlow = allFlow.filter(e => e.t0 >= cutoff);
  await fs.writeFile(path.join(DIR, 'cmecat.json'), JSON.stringify({ cme: recentCme, flow: recentFlow }), 'utf8');
  console.log(`Saved ${recentCme.length} CACTUS CME entries and ${recentFlow.length} Flow entries (parsed ${allCme.length}/${allFlow.length} total)`);
}

main().catch(e => { console.error(e); process.exit(1); });
