'use strict';

// Reproducible corpus builder.
//
// Pulls ~48 real, licensed-free photos from Wikimedia Commons across six groups
// (red fox, gray wolf, domestic dog, brown bear, white-tailed deer, city skyline),
// downloads the ORIGINAL image files (thumbnail URLs are blocked by Wikimedia's
// 403 policy), resizes them locally with ImageMagick to max 800px / JPEG q72, and
// writes:
//   corpus/<slug>.jpg          resized images (~75 KB each, ~4 MB total)
//   corpus/manifest.json       provenance: source url, Commons title, license, artist, dims
//   corpus/eval_golden.json    post slug -> expected image filename (or null = expected refusal)
//   printed label audit table  human-checkable, so no label is silently wrong
//
// Labels for the golden set are derived from the Commons FILE TITLE via the same
// taxonomy map the guard uses — never guessed from a bare filename and never
// invented. A title whose resolved group is ambiguous (mentions two groups) or
// unknown is marked needs_review and excluded from the golden set.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveGroup, TAXONOMY } = require('../src/services/taxonomy');

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'FlyRankCapstone/1.0 (educational image-relevance corpus; contact: chandu@localhost)';
const OUT_DIR = path.join(__dirname, '..', 'corpus');
const ORIG_DIR = path.join(OUT_DIR, 'originals');
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024; // skip absurdly large originals
const MIN_WIDTH = 600;

const GROUPS = [
  { group: 'fox', queries: ['red fox', 'Vulpes vulpes', 'red fox portrait'] },
  { group: 'wolf', queries: ['gray wolf', 'Canis lupus', 'grey wolf'] },
  { group: 'dog', queries: ['domestic dog', 'dog portrait', 'puppy'] },
  { group: 'bear', queries: ['brown bear', 'grizzly bear'] },
  { group: 'deer', queries: ['white-tailed deer', 'red deer stag'] },
  { group: 'city skyline', queries: ['city skyline', 'urban skyline panorama'] },
];
const PER_GROUP_TARGET = Number(process.env.CORPUS_PER_GROUP || 8);

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(ORIG_DIR, { recursive: true });
  // A rebuild regenerates manifest.json + eval_golden.json with fresh filenames, so any
  // image left over from a prior (possibly rate-truncated) run would drift out of sync
  // with the labels. Clear corpus JPEGs and the scratch originals dir before building.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/\.(jpg|jpeg|png)$/i.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }
  for (const f of fs.readdirSync(ORIG_DIR)) {
    fs.unlinkSync(path.join(ORIG_DIR, f));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Anonymous Commons access is aggressively rate-limited (HTTP 429). We throttle every
// request with a fixed gap and retry 429/5xx with exponential backoff so a full build
// survives the limiter instead of collapsing to a two-group corpus.
const REQUEST_GAP_MS = Number(process.env.CORPUS_GAP_MS || 800);
const MAX_RETRIES = Number(process.env.CORPUS_RETRIES || 2);
const MAX_BACKOFF_MS = Number(process.env.CORPUS_MAX_BACKOFF_MS || 8000);

async function fetchWithBackoff(url, init, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(REQUEST_GAP_MS);
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      // Honour a small Retry-After, but never block the whole build on a persistent
      // limiter — after MAX_RETRIES we skip this item and keep going.
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      await sleep(Math.min(MAX_BACKOFF_MS, Math.max(REQUEST_GAP_MS, retryAfter * 1000) || 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${label || url}`); // permanent (403/404/...)
  }
  throw new Error(`${label || url}: giving up after retries (${lastErr && lastErr.message})`);
}

async function getJson(url) {
  const res = await fetchWithBackoff(url, { headers: { 'User-Agent': UA } });
  return res.json();
}

async function searchFiles(query, limit = 25) {
  const u = `${API}?action=query&list=search&srnamespace=6&srlimit=${limit}&format=json&srsearch=${encodeURIComponent(query)}`;
  const j = await getJson(u);
  return (j.query && j.query.search ? j.query.search : []).map((r) => r.title);
}

// Fetch imageinfo for a batch of titles (up to 50 per request).
async function imageInfo(titles) {
  const u =
    `${API}?action=query&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json` +
    `&titles=${encodeURIComponent(titles.join('|'))}`;
  const j = await getJson(u);
  const pages = (j.query && j.query.pages ? Object.values(j.query.pages) : []) || [];
  return pages
    .filter((p) => p.imageinfo)
    .map((p) => ({ title: p.title, info: p.imageinfo[0] }));
}

// Derive a group from the Commons title, flagging ambiguity.
function classifyTitle(title) {
  const norm = title.toLowerCase();
  const hits = new Set();
  for (const [group, aliases] of Object.entries(TAXONOMY)) {
    if (aliases.some((a) => new RegExp(`(^|[^a-z])${a.replace(/\s+/g, '[^a-z]+')}([^a-z]|$)`).test(norm))) {
      hits.add(group);
    }
  }
  if (hits.size === 0) return { group: null, ambiguous: false };
  if (hits.size > 1) return { group: [...hits][0], ambiguous: true, allGroups: [...hits] };
  return { group: [...hits][0], ambiguous: false };
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function pickConvert() {
  // Prefer ImageMagick v7 `magick`, fall back to v6 `convert`.
  for (const bin of ['magick', 'convert']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  throw new Error('ImageMagick (magick/convert) not found — required to resize the corpus');
}

async function download(url, dest) {
  const res = await fetchWithBackoff(url, { headers: { 'User-Agent': UA } }, 'download');
  const cl = Number(res.headers.get('content-length') || 0);
  if (cl > MAX_ORIGINAL_BYTES) throw new Error(`original too large (${cl} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ORIGINAL_BYTES) throw new Error('original too large after read');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function resizeToJpeg(convert, src, dest) {
  // Flatten transparency onto white, cap max dimension at 800px, q72.
  execFileSync(convert, [src, '-auto-orient', '-background', 'white', '-flatten', '-resize', '800x800>', '-quality', '72', dest], {
    stdio: 'ignore',
  });
}

async function build() {
  ensureDirs();
  const convert = pickConvert();
  console.log(`[corpus] using ImageMagick: ${convert}`);

  const manifest = [];
  const seenTitles = new Set();
  const perGroupCount = {};

  for (const { group, queries } of GROUPS) {
    perGroupCount[group] = 0;
    // Gather candidate titles for this group from all its queries.
    const titles = [];
    for (const q of queries) {
      try {
        titles.push(...(await searchFiles(q)));
      } catch (e) {
        console.warn(`[corpus] search failed for "${q}": ${e.message}`);
      }
    }

    // Look up imageinfo in chunks and accept only files whose title resolves to
    // this exact group (unambiguously). This is what keeps labels correct.
    for (let i = 0; i < titles.length && perGroupCount[group] < PER_GROUP_TARGET; i += 20) {
      const chunk = titles.slice(i, i + 20).filter((t) => !seenTitles.has(t));
      if (!chunk.length) continue;
      let infos;
      try {
        infos = await imageInfo(chunk);
      } catch (e) {
        console.warn(`[corpus] imageinfo failed: ${e.message}`);
        continue;
      }
      for (const { title, info } of infos) {
        if (perGroupCount[group] >= PER_GROUP_TARGET) break;
        if (seenTitles.has(title)) continue;
        seenTitles.add(title);

        const cls = classifyTitle(title);
        if (cls.group !== group || cls.ambiguous) continue; // require an unambiguous match
        if (!/^(image\/jpeg|image\/png)$/i.test(info.mime || '')) continue;
        if ((info.width || 0) < MIN_WIDTH || (info.height || 0) < MIN_WIDTH) continue;

        const base = slugify(title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''));
        const filename = `${group.replace(/\s+/g, '-')}-${base}-${manifest.length + 1}.jpg`;
        const origPath = path.join(ORIG_DIR, `orig-${manifest.length + 1}`);
        const outPath = path.join(OUT_DIR, filename);
        try {
          await download(info.url, origPath);
          resizeToJpeg(convert, origPath, outPath);
          fs.unlinkSync(origPath);
        } catch (e) {
          console.warn(`[corpus] skip "${title}": ${e.message}`);
          if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
          continue;
        }

        const md = info.extmetadata || {};
        manifest.push({
          filename,
          commons_title: title,
          source_url: info.url,
          page_url: info.descriptionurl || null,
          license: (md.LicenseShortName && md.LicenseShortName.value) || 'unknown',
          artist: stripHtml((md.Artist && md.Artist.value) || 'unknown'),
          original_width: info.width,
          original_height: info.height,
          title_group: cls.group,
          bytes: fs.statSync(outPath).size,
          needs_review: false,
        });
        perGroupCount[group]++;
      }
    }
  }

  // Build the golden set: for each in-scope post, the first unambiguous image whose
  // title-group equals the post's group. Out-of-scope posts get null (expected refusal).
  const postsPath = path.join(OUT_DIR, 'posts.json');
  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8')).posts;
  const golden = {};
  for (const p of posts) {
    const match = manifest.find((m) => m.title_group === p.group && !m.needs_review);
    golden[p.slug] = match ? match.filename : null; // null => system should refuse
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'eval_golden.json'), JSON.stringify({ generated_at: new Date().toISOString(), labels: golden }, null, 2));

  printAudit(manifest, perGroupCount, golden, posts);
  console.log(`\n[corpus] wrote ${manifest.length} images (target ${GROUPS.length * PER_GROUP_TARGET}).`);
  if (manifest.length < 40) console.warn('[corpus] WARNING: fewer than 40 images; consider raising CORPUS_PER_GROUP or adding queries.');
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function printAudit(manifest, counts, golden, posts) {
  console.log('\n=== LABEL AUDIT (verify each title->group before trusting) ===');
  console.log('group'.padEnd(14), 'count');
  for (const [g, c] of Object.entries(counts)) console.log(g.padEnd(14), c);
  console.log('\nfilename'.padEnd(40), 'titleGroup'.padEnd(13), 'license'.padEnd(16), 'commons title');
  for (const m of manifest) {
    console.log(m.filename.padEnd(40), String(m.title_group).padEnd(13), String(m.license).padEnd(16), m.commons_title.slice(0, 50));
  }
  console.log('\n=== GOLDEN PAIRS (null = expected refusal) ===');
  for (const p of posts) {
    console.log(p.slug.padEnd(28), '->', golden[p.slug] || '(no image: expect refusal)');
  }
}

build().catch((e) => {
  console.error('[corpus] FAILED:', e);
  process.exit(1);
});
