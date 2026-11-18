const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { getDemoPapersData } = require('./seed-data');

function getDataRoot() {
  return path.join(app.getPath('appData'), 'PaperReader');
}

function getPapersDir() {
  return path.join(getDataRoot(), 'papers');
}

function getConfigPath() {
  return path.join(getDataRoot(), 'config.json');
}

function getRecentPath() {
  return path.join(getDataRoot(), 'recent.json');
}

function ensureDirs() {
  fs.mkdirSync(getDataRoot(), { recursive: true });
  fs.mkdirSync(getPapersDir(), { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.error(`Failed reading JSON ${filePath}:`, err.message);
  }
  return fallback;
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getDefaultConfig() {
  return {
    theme: 'dark',
    pdfFilter: 'none',
    snowMode: false
  };
}

function loadConfig() {
  ensureDirs();
  return { ...getDefaultConfig(), ...readJsonSafe(getConfigPath(), {}) };
}

function getPublicConfig() {
  const cfg = loadConfig();
  return {
    theme: cfg.theme || 'dark',
    pdfFilter: cfg.pdfFilter || 'none',
    snowMode: Boolean(cfg.snowMode)
  };
}

function saveConfig(updates = {}) {
  const cfg = loadConfig();
  if (updates.theme === 'dark' || updates.theme === 'light' || updates.theme === 'cosmic') cfg.theme = updates.theme;
  if (['none', 'dim', 'sepia', 'invert'].includes(updates.pdfFilter)) cfg.pdfFilter = updates.pdfFilter;
  if (typeof updates.snowMode === 'boolean') cfg.snowMode = updates.snowMode;
  writeJsonSafe(getConfigPath(), cfg);
  return getPublicConfig();
}

function buildIndexEntry(paperDir) {
  const meta = readJsonSafe(path.join(paperDir, 'meta.json'), null);
  if (!meta || !meta.pdf_hash) return null;

  const annotations = readJsonSafe(path.join(paperDir, 'annotations.json'), {
    highlights: [],
    bookmarks: [],
    comments: []
  });
  const translations = readJsonSafe(path.join(paperDir, 'translations.json'), {});
  const hasSummary = fs.existsSync(path.join(paperDir, 'summary.md'));
  const totalPages = Math.max(1, Number(meta.total_pages) || 1);
  const bodyEndPage = Math.max(1, Math.min(totalPages, Number(meta.body_end_page) || totalPages));
  const readPages = Array.isArray(meta.read_pages) ? meta.read_pages : [];
  const translatedPagesCount = Object.keys(translations).length;

  return {
    ...meta,
    total_pages: totalPages,
    body_end_page: bodyEndPage,
    read_pages: readPages,
    read_count: readPages.length,
    translated_pages_count: translatedPagesCount,
    has_summary: hasSummary,
    counts: {
      bookmarks: (annotations.bookmarks || []).length,
      highlights: (annotations.highlights || []).length,
      comments: (annotations.comments || []).length
    },
    preview_highlight: (annotations.highlights || [])[0] || null,
    preview_comment: (annotations.comments || [])[0] || null
  };
}

function rebuildRecentIndex() {
  ensureDirs();
  const papersDir = getPapersDir();
  const entries = [];
  for (const name of fs.readdirSync(papersDir)) {
    const full = path.join(papersDir, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        const entry = buildIndexEntry(full);
        if (entry) entries.push(entry);
      }
    } catch {}
  }
  entries.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  writeJsonSafe(getRecentPath(), entries);
  return entries;
}

function seedInitialDemoPapersIfNeeded() {
  ensureDirs();
}

function getRecentList() {
  seedInitialDemoPapersIfNeeded();
  return rebuildRecentIndex();
}

function getAllTags() {
  const list = getRecentList();
  const set = new Set();
  for (const item of list) {
    for (const tag of item.tags || []) {
      set.add(tag);
    }
  }
  return Array.from(set);
}

function loadPaper(pdfHash) {
  const dir = path.join(getPapersDir(), pdfHash);
  if (!fs.existsSync(dir)) {
    throw new Error('논문 캐시 폴더를 찾을 수 없습니다.');
  }
  const meta = readJsonSafe(path.join(dir, 'meta.json'), null);
  const blocks = readJsonSafe(path.join(dir, 'blocks.json'), {});
  const translations = readJsonSafe(path.join(dir, 'translations.json'), {});
  const annotations = readJsonSafe(path.join(dir, 'annotations.json'), {
    highlights: [],
    bookmarks: [],
    comments: []
  });
  const summaryPath = path.join(dir, 'summary.md');
  const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf-8') : '';
  const pdfPath = path.join(dir, 'paper.pdf');
  const pdfBase64 = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath).toString('base64') : '';

  return {
    meta,
    blocks,
    translations,
    annotations,
    summaryMd,
    pdfBase64
  };
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function registerPdfBuffer(pdfBuffer, { title, arxivUrl = '' } = {}) {
  ensureDirs();
  if (!pdfBuffer || pdfBuffer.length < 16 || pdfBuffer.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('유효한 PDF 파일이 아닙니다.');
  }

  const pdfHash = hashBuffer(pdfBuffer);
  const dir = path.join(getPapersDir(), pdfHash);
  const now = Date.now();

  if (fs.existsSync(path.join(dir, 'meta.json'))) {
    const existing = readJsonSafe(path.join(dir, 'meta.json'), {});
    existing.updated_at = now;
    writeJsonSafe(path.join(dir, 'meta.json'), existing);
    rebuildRecentIndex();
    return { pdfHash, alreadyExists: true };
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper.pdf'), pdfBuffer);

  const cleanTitle = String(title || 'Untitled Paper')
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();

  const meta = {
    pdf_hash: pdfHash,
    title: cleanTitle || 'Untitled Paper',
    short_title: cleanTitle.slice(0, 40),
    authors: '',
    year: String(new Date().getFullYear()),
    venue: arxivUrl ? 'arXiv' : 'Local PDF',
    arxiv_url: arxivUrl,
    code_url: '',
    tags: [],
    one_line_summary: '',
    review: '',
    total_pages: 1,
    body_end_page: 1,
    last_page: 1,
    read_pages: [],
    status: 'Unread',
    created_at: now,
    updated_at: now
  };

  writeJsonSafe(path.join(dir, 'meta.json'), meta);
  writeJsonSafe(path.join(dir, 'blocks.json'), {});
  writeJsonSafe(path.join(dir, 'translations.json'), {});
  writeJsonSafe(path.join(dir, 'annotations.json'), {
    highlights: [],
    bookmarks: [],
    comments: []
  });
  rebuildRecentIndex();
  return { pdfHash, alreadyExists: false };
}

function importPdfFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('파일을 찾을 수 없습니다.');
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.paperpkg' || ext === '.zip') {
    return importPaperPkg(filePath);
  }
  const buf = fs.readFileSync(filePath);
  return registerPdfBuffer(buf, { title: path.basename(filePath, ext) });
}

function importPaperPkg(pkgPath) {
  ensureDirs();
  const zip = new AdmZip(pkgPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) {
    throw new Error('.paperpkg 패키지가 비어 있습니다.');
  }

  const findEntry = (filename) =>
    entries.find((e) => path.basename(e.entryName).toLowerCase() === filename.toLowerCase());

  const pdfEntry = findEntry('paper.pdf') || entries.find((e) => e.entryName.toLowerCase().endsWith('.pdf'));
  const metaEntry = findEntry('meta.json');
  if (!pdfEntry && !metaEntry) {
    throw new Error('올바른 .paperpkg 형식이 아닙니다 (paper.pdf 또는 meta.json 필요).');
  }

  const pdfBuf = pdfEntry ? pdfEntry.getData() : null;
  let meta = {};
  if (metaEntry) {
    try {
      meta = JSON.parse(metaEntry.getData().toString('utf-8'));
    } catch {}
  }

  const pdfHash = meta.pdf_hash || (pdfBuf ? hashBuffer(pdfBuf) : hashBuffer(Buffer.from(path.basename(pkgPath))));
  const dir = path.join(getPapersDir(), pdfHash);
  fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const mergedMeta = {
    pdf_hash: pdfHash,
    title: meta.title || path.basename(pkgPath, path.extname(pkgPath)),
    short_title: meta.short_title || (meta.title || '').slice(0, 40),
    authors: meta.authors || '',
    year: meta.year || String(new Date().getFullYear()),
    venue: meta.venue || 'Package Import',
    arxiv_url: meta.arxiv_url || '',
    code_url: meta.code_url || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    one_line_summary: meta.one_line_summary || '',
    review: meta.review || '',
    total_pages: Number(meta.total_pages) || 1,
    body_end_page: Number(meta.body_end_page) || Number(meta.total_pages) || 1,
    last_page: Number(meta.last_page) || 1,
    read_pages: Array.isArray(meta.read_pages) ? meta.read_pages : [],
    status: ['Unread', 'Reading', 'Done'].includes(meta.status) ? meta.status : 'Unread',
    created_at: meta.created_at || now,
    updated_at: now
  };

  writeJsonSafe(path.join(dir, 'meta.json'), mergedMeta);

  const copyJson = (fname, fallback) => {
    const ent = findEntry(fname);
    if (ent) {
      try {
        const parsed = JSON.parse(ent.getData().toString('utf-8'));
        writeJsonSafe(path.join(dir, fname), parsed);
        return;
      } catch {}
    }
    if (!fs.existsSync(path.join(dir, fname))) {
      writeJsonSafe(path.join(dir, fname), fallback);
    }
  };

  copyJson('blocks.json', {});
  copyJson('translations.json', {});
  copyJson('annotations.json', { highlights: [], bookmarks: [], comments: [] });

  const sumEntry = findEntry('summary.md');
  if (sumEntry) {
    fs.writeFileSync(path.join(dir, 'summary.md'), sumEntry.getData().toString('utf-8'), 'utf-8');
  }
  if (pdfBuf) {
    fs.writeFileSync(path.join(dir, 'paper.pdf'), pdfBuf);
  }

  rebuildRecentIndex();
  return { pdfHash, importedPackage: true };
}

function exportPaperPkg(pdfHash, destPath) {
  const dir = path.join(getPapersDir(), pdfHash);
  if (!fs.existsSync(dir)) throw new Error('논문 데이터를 찾을 수 없습니다.');

  const zip = new AdmZip();
  for (const fname of ['meta.json', 'blocks.json', 'translations.json', 'annotations.json', 'summary.md', 'paper.pdf']) {
    const full = path.join(dir, fname);
    if (fs.existsSync(full)) {
      zip.addLocalFile(full);
    }
  }
  zip.writeZip(destPath);
  return { ok: true, path: destPath };
}

async function importFromUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) throw new Error('URL을 입력해 주세요.');

  let fetchUrl = trimmed;
  let arxivUrl = '';
  let suggestedTitle = '';

  const arxivAbsMatch = trimmed.match(/arxiv\.org\/abs\/([0-9]+\.[0-9]+(?:v\d+)?)/i);
  const arxivPdfMatch = trimmed.match(/arxiv\.org\/pdf\/([0-9]+\.[0-9]+(?:v\d+)?)/i);
  const rawIdMatch = trimmed.match(/^([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$/);

  if (arxivAbsMatch) {
    const id = arxivAbsMatch[1];
    arxivUrl = `https://arxiv.org/abs/${id}`;
    fetchUrl = `https://arxiv.org/pdf/${id}.pdf`;
    suggestedTitle = `arXiv_${id}`;
  } else if (arxivPdfMatch) {
    const id = arxivPdfMatch[1];
    arxivUrl = `https://arxiv.org/abs/${id}`;
    fetchUrl = `https://arxiv.org/pdf/${id}.pdf`;
    suggestedTitle = `arXiv_${id}`;
  } else if (rawIdMatch) {
    const id = rawIdMatch[1];
    arxivUrl = `https://arxiv.org/abs/${id}`;
    fetchUrl = `https://arxiv.org/pdf/${id}.pdf`;
    suggestedTitle = `arXiv_${id}`;
  } else {
    try {
      const u = new URL(trimmed);
      suggestedTitle = path.basename(u.pathname, '.pdf') || 'Downloaded_Paper';
    } catch {
      throw new Error('올바른 arXiv ID 또는 PDF URL 형식이 아닙니다.');
    }
  }

  const res = await fetch(fetchUrl, {
    headers: { 'User-Agent': 'PaperReader/1.0' }
  });
  if (!res.ok) {
    throw new Error(`PDF 다운로드 실패 (HTTP ${res.status})`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  return registerPdfBuffer(buf, { title: suggestedTitle, arxivUrl });
}

function updateMeta(pdfHash, updates = {}) {
  const metaPath = path.join(getPapersDir(), pdfHash, 'meta.json');
  const meta = readJsonSafe(metaPath, null);
  if (!meta) throw new Error('논문 메타데이터를 찾을 수 없습니다.');

  const allowedKeys = [
    'title',
    'short_title',
    'authors',
    'year',
    'venue',
    'arxiv_url',
    'code_url',
    'tags',
    'one_line_summary',
    'review',
    'total_pages',
    'body_end_page',
    'last_page',
    'read_pages',
    'status',
    'attachments',
    'favorite'
  ];

  for (const k of allowedKeys) {
    if (updates[k] !== undefined) {
      meta[k] = updates[k];
    }
  }
  if (Array.isArray(meta.read_pages)) {
    meta.read_pages = Array.from(new Set(meta.read_pages.map(Number).filter((n) => n >= 1))).sort((a, b) => a - b);
  }
  meta.updated_at = Date.now();
  writeJsonSafe(metaPath, meta);
  rebuildRecentIndex();
  return meta;
}

function saveBlocks(pdfHash, { page, blocks, totalPages, bodyEndPage, detectedTitle }) {
  const dir = path.join(getPapersDir(), pdfHash);
  const blocksPath = path.join(dir, 'blocks.json');
  const allBlocks = readJsonSafe(blocksPath, {});
  if (page && Array.isArray(blocks)) {
    allBlocks[String(page)] = blocks;
    writeJsonSafe(blocksPath, allBlocks);
  }

  const metaPath = path.join(dir, 'meta.json');
  const meta = readJsonSafe(metaPath, null);
  if (meta) {
    let changed = false;
    if (totalPages && totalPages !== meta.total_pages) {
      meta.total_pages = totalPages;
      if (!meta.body_end_page || meta.body_end_page === 1 || meta.body_end_page > totalPages) {
        meta.body_end_page = totalPages;
      }
      changed = true;
    }
    if (bodyEndPage && bodyEndPage >= 1 && bodyEndPage <= meta.total_pages) {
      if (meta.body_end_page === meta.total_pages || bodyEndPage < meta.body_end_page) {
        meta.body_end_page = bodyEndPage;
        changed = true;
      }
    }
    if (detectedTitle && /^arXiv_|^Untitled/i.test(meta.title)) {
      meta.title = detectedTitle;
      meta.short_title = detectedTitle.slice(0, 42);
      changed = true;
    }
    if (changed) {
      writeJsonSafe(metaPath, meta);
      rebuildRecentIndex();
    }
  }
  return allBlocks;
}

function saveTranslation(pdfHash, page, translatedBlocks) {
  const dir = path.join(getPapersDir(), pdfHash);
  const transPath = path.join(dir, 'translations.json');
  const all = readJsonSafe(transPath, {});
  all[String(page)] = translatedBlocks;
  writeJsonSafe(transPath, all);
  rebuildRecentIndex();
  return all;
}

function saveSummary(pdfHash, summaryMd, metaUpdates = {}) {
  const dir = path.join(getPapersDir(), pdfHash);
  fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd, 'utf-8');
  if (Object.keys(metaUpdates).length > 0) {
    updateMeta(pdfHash, metaUpdates);
  } else {
    rebuildRecentIndex();
  }
  return summaryMd;
}

function saveAnnotations(pdfHash, annotations) {
  const dir = path.join(getPapersDir(), pdfHash);
  const safeAnn = {
    highlights: Array.isArray(annotations?.highlights) ? annotations.highlights : [],
    bookmarks: Array.isArray(annotations?.bookmarks) ? annotations.bookmarks : [],
    comments: Array.isArray(annotations?.comments) ? annotations.comments : []
  };
  writeJsonSafe(path.join(dir, 'annotations.json'), safeAnn);
  rebuildRecentIndex();
  return safeAnn;
}

function deletePaper(pdfHash) {
  const dir = path.join(getPapersDir(), pdfHash);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return rebuildRecentIndex();
}

function searchLibrary({ query = '', statusFilter = 'all', tagFilter = '', sortBy = 'added' } = {}) {
  const list = getRecentList();
  const q = String(query || '').trim().toLowerCase();
  const tag = String(tagFilter || '').trim().toLowerCase();

  const results = [];
  for (const item of list) {
    if (statusFilter === 'unread' && item.status !== 'Unread') continue;
    if (statusFilter === 'reading' && item.status !== 'Reading') continue;
    if (statusFilter === 'done' && item.status !== 'Done') continue;
    if (statusFilter === 'bookmarked' && (item.counts?.bookmarks || 0) === 0) continue;
    if (tag && !(item.tags || []).some((t) => t.toLowerCase() === tag)) continue;

    const dir = path.join(getPapersDir(), item.pdf_hash);
    const meta = !item.venue ? readJsonSafe(path.join(dir, 'meta.json'), {}) : null;
    const annotations = readJsonSafe(path.join(dir, 'annotations.json'), {
      highlights: [],
      bookmarks: [],
      comments: []
    });
    const translations = readJsonSafe(path.join(dir, 'translations.json'), {});

    let matchInfo = null;
    if (q) {
      const metaHay = [
        item.title,
        item.authors,
        item.one_line_summary,
        item.review,
        ...(item.tags || [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (metaHay.includes(q)) {
        matchInfo = { source: 'meta', page: item.last_page || 1, snippet: item.one_line_summary || item.title };
      }

      if (!matchInfo) {
        for (const h of annotations.highlights || []) {
          const hay = `${h.text || ''} ${h.note || ''}`.toLowerCase();
          if (hay.includes(q)) {
            matchInfo = {
              source: 'highlight',
              page: h.page || 1,
              block_id: h.block_id,
              snippet: h.text || h.note
            };
            break;
          }
        }
      }

      if (!matchInfo) {
        for (const c of annotations.comments || []) {
          const hay = `${c.question || ''} ${c.original_excerpt || ''} ${c.translated_excerpt || ''}`.toLowerCase();
          if (hay.includes(q)) {
            matchInfo = {
              source: 'comment',
              page: c.page || 1,
              block_id: c.block_id,
              snippet: c.question
            };
            break;
          }
        }
      }

      if (!matchInfo) {
        for (const [pStr, blocks] of Object.entries(translations)) {
          for (const b of blocks || []) {
            const md = String(b.translated_md || b.translated_text || '');
            const idx = md.toLowerCase().indexOf(q);
            if (idx !== -1) {
              const start = Math.max(0, idx - 35);
              const end = Math.min(md.length, idx + q.length + 80);
              matchInfo = {
                source: 'translation',
                page: Number(pStr) || 1,
                block_id: b.block_id,
                snippet: (start > 0 ? '...' : '') + md.slice(start, end) + (end < md.length ? '...' : '')
              };
              break;
            }
          }
          if (matchInfo) break;
        }
      }

      if (!matchInfo) continue;
    }

    results.push({
      ...item,
      venue: item.venue || meta?.venue || '',
      matchInfo,
      highlights: annotations.highlights || [],
      comments: annotations.comments || [],
      bookmarks: annotations.bookmarks || []
    });
  }

  const toTimeMs = (v) => (typeof v === 'number' ? v : (Date.parse(v) || 0));

  results.sort((a, b) => {
    const favDiff = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    if (favDiff !== 0) return favDiff;
    if (sortBy === 'year') {
      const yearDiff = (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
      if (yearDiff !== 0) return yearDiff;
      return toTimeMs(b.created_at) - toTimeMs(a.created_at);
    }
    if (sortBy === 'added') {
      return toTimeMs(b.created_at) - toTimeMs(a.created_at);
    }
    return toTimeMs(b.updated_at) - toTimeMs(a.updated_at);
  });

  return results;
}

function exportMarkdownNote(pdfHash, destPath) {
  const paper = loadPaper(pdfHash);
  const { meta, translations, annotations, summaryMd } = paper;

  const lines = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  if (meta.authors) lines.push(`- **Authors**: ${meta.authors}`);
  if (meta.venue) lines.push(`- **Venue**: ${meta.venue}`);
  if (meta.arxiv_url) lines.push(`- **arXiv**: ${meta.arxiv_url}`);
  if (meta.tags?.length) lines.push(`- **Tags**: ${meta.tags.join(', ')}`);
  if (meta.one_line_summary) lines.push(`- **1-Line Summary**: ${meta.one_line_summary}`);
  if (meta.review) lines.push(`- **My Review**: ${meta.review}`);
  lines.push(`- **Status**: ${meta.status} (${(meta.read_pages || []).length} / ${meta.body_end_page}p)`);
  lines.push('');

  if (summaryMd) {
    lines.push('---');
    lines.push('');
    lines.push(summaryMd.trim());
    lines.push('');
  }

  if ((annotations.highlights || []).length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Highlights');
    for (const h of annotations.highlights) {
      lines.push(`- **[p.${h.page}]** (${h.color || 'amber'}) "${h.text}"${h.note ? ` — *${h.note}*` : ''}`);
    }
    lines.push('');
  }

  if ((annotations.comments || []).length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Questions & Notes');
    for (const c of annotations.comments) {
      lines.push(`- **[p.${c.page}]** ${c.resolved ? '[Resolved]' : '[Open]'} **Q:** ${c.question}`);
      if (c.original_excerpt) lines.push(`  > Original: ${c.original_excerpt}`);
      if (c.translated_excerpt) lines.push(`  > Translated: ${c.translated_excerpt}`);
    }
    lines.push('');
  }

  const pageNums = Object.keys(translations)
    .map(Number)
    .sort((a, b) => a - b);
  if (pageNums.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Translated Content');
    for (const pNum of pageNums) {
      lines.push(`### Page ${pNum}`);
      for (const blk of translations[String(pNum)] || []) {
        lines.push(blk.translated_md || blk.translated_text || '');
        lines.push('');
      }
    }
  }

  fs.writeFileSync(destPath, lines.join('\n'), 'utf-8');
  return { ok: true, path: destPath };
}

function resolveArchiveHubItem(itemId) {
  const id = String(itemId || '').trim();
  if (!id) return null;
  try {
    const ahPath = path.join(app.getPath('appData'), 'my-todo-schedule-widget', 'todo-schedule-data.json');
    if (!fs.existsSync(ahPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(ahPath, 'utf-8'));

    const pinned = Array.isArray(parsed.pinnedFiles) ? parsed.pinnedFiles : [];
    const pf = pinned.find((x) => String(x.id) === id);
    if (pf && pf.path) {
      const target = String(pf.path);
      const isUrl = /^https?:\/\//i.test(target) || /^notion:\/\//i.test(target);
      return {
        type: /notion/i.test(target) ? 'notion' : isUrl ? 'web' : 'file',
        title: pf.name || path.basename(target),
        target
      };
    }

    const qLinks = Array.isArray(parsed.quickLinks) ? parsed.quickLinks : [];
    const ql = qLinks.find((x) => String(x.id) === id);
    if (ql && ql.url) {
      const target = String(ql.url);
      return {
        type: /notion/i.test(target) ? 'notion' : 'web',
        title: ql.title || target,
        target
      };
    }
  } catch {}
  return null;
}

module.exports = {
  getDataRoot,
  getPublicConfig,
  saveConfig,
  getRecentList,
  getAllTags,
  loadPaper,
  importPdfFile,
  importPaperPkg,
  exportPaperPkg,
  importFromUrl,
  updateMeta,
  saveBlocks,
  saveTranslation,
  saveSummary,
  saveAnnotations,
  deletePaper,
  searchLibrary,
  exportMarkdownNote,
  resolveArchiveHubItem
};
