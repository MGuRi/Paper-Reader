(function () {
  'use strict';

  // Configure PDF.js worker
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      '../node_modules/pdfjs-dist/build/pdf.worker.min.js';
  }

  function createEmptyTabState() {
    return {
      pdfHash: null,
      paper: null,
      pdfDoc: null,
      currentPage: 1,
      totalPages: 1,
      zoomMode: 'fit',
      scale: 1.0,
      syncOn: true,
      middleMode: 'translation',
      sidebarTab: 'notes',
      sidebarCollapsed: true,
      pdfCollapsed: false,
      hoveredBlockId: null,
      translatingPages: new Set(),
      prefetchQueueRunning: false,
      pendingJumpBlockId: null,
      renderTask: null,
      renderGeneration: 0
    };
  }

  const state = {
    view: 'home',
    config: {
      theme: 'dark',
      pdfFilter: 'none',
      model: 'gemini-2.5-flash',
      hasApiKey: false,
      apiKeyMasked: '',
      apiKeySource: 'none'
    },
    dataRoot: '',
    recent: [],
    tags: [],
    openTabs: [],
    activeTabHash: null,
    agyJobs: new Map(),
    library: {
      query: '',
      statusFilter: 'all',
      tagFilter: '',
      viewMode: 'detailed',
      sortBy: 'added',
      results: []
    },
    reader: createEmptyTabState()
  };

  // DOM helpers
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 200ms ease';
      setTimeout(() => el.remove(), 220);
    }, 2800);
  }

  async function copyToClipboard(text, btnEl, restoredLabel) {
    const str = String(text || '');
    try {
      await window.paperAPI.copyText(str);
    } catch {
      await navigator.clipboard.writeText(str).catch(() => {});
    }
    if (btnEl) {
      const orig = restoredLabel || btnEl.textContent;
      btnEl.textContent = 'Copied ✓';
      setTimeout(() => {
        btnEl.textContent = orig;
      }, 1400);
    } else {
      showToast('클립보드에 복사되었습니다.', 'success');
    }
  }

  // Tokenize LaTeX before marked.parse() so _ and * inside math never become <em> tags
  function renderMarkdownWithKatex(mdText, blockId = '') {
    const raw = String(mdText || '');
    const mathTokens = [];

    const stash = (latex, displayMode) => {
      const idx = mathTokens.length;
      mathTokens.push({ latex: latex.trim(), displayMode });
      return `@@MATH_TOKEN_${idx}@@`;
    };

    // Extract display math $$...$$ first, then inline $...$
    let tokenized = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => stash(inner, true));
    tokenized = tokenized.replace(/\$([^\n$]+?)\$/g, (_m, inner) => stash(inner, false));

    let html = window.marked
      ? window.marked.parse(tokenized, { breaks: true, gfm: true })
      : escapeHtml(tokenized).replace(/\n/g, '<br>');

    html = html.replace(/@@MATH_TOKEN_(\d+)@@/g, (_m, idxStr) => {
      const tok = mathTokens[Number(idxStr)];
      if (!tok) return '';
      let rendered = escapeHtml(tok.latex);
      if (window.katex) {
        try {
          rendered = window.katex.renderToString(tok.latex, {
            displayMode: tok.displayMode,
            throwOnError: false
          });
        } catch {}
      }
      const cls = tok.displayMode ? 'katex-wrap katex-block-wrap' : 'katex-wrap';
      return `<span class="${cls}" data-latex="${escapeHtml(tok.latex)}" data-display="${tok.displayMode ? '1' : '0'}" data-block-id="${escapeHtml(blockId)}">${rendered}</span>`;
    });

    return html;
  }

  function formatAiPrompt({ title, page, originalExcerpt, translatedExcerpt, question }) {
    return [
      `[논문] ${title || 'Unknown'} (p.${page || 1})`,
      `[원문 발췌] "${originalExcerpt || '(원문 발췌 없음)'}"`,
      `[번역본] "${translatedExcerpt || '(번역본 없음)'}"`,
      `[질문] ${question || ''}`,
      '위 문맥을 바탕으로 내 질문에 대해 알기 쉽게 설명해줘.'
    ].join('\n');
  }

  // Theme & Config
  function applyTheme(theme) {
    const t = theme === 'light' || theme === 'cosmic' ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    syncCosmosEffect();
    syncSnowEffect();
  }

  function applyPdfFilter() {
    const stack = $('#pdf-pages-stack');
    if (!stack) return;
    stack.classList.remove('filter-dim', 'filter-sepia', 'filter-invert');
    const f = state.config.pdfFilter || 'none';
    if (f !== 'none') {
      stack.classList.add(`filter-${f}`);
    }
    const labels = {
      none: '눈부심: 원본',
      dim: '눈부심: 완화',
      sepia: '눈부심: 세피아',
      invert: '눈부심: 반전'
    };
    const btn = $('#btn-pdf-filter');
    if (btn) btn.textContent = labels[f] || '눈부심: 원본';
  }

  async function toggleTheme(e) {
    const order = ['light', 'dark', 'cosmic'];
    const curTheme = order.includes(state.config.theme) ? state.config.theme : 'dark';
    const curIdx = order.indexOf(curTheme);
    const btn = $('#btn-theme-toggle');

    let clickedTheme = null;
    if (e && typeof e.clientX === 'number' && e.clientX > 0 && btn) {
      if (e.target.closest?.('.sun-icon')) clickedTheme = 'light';
      else if (e.target.closest?.('.moon-icon')) clickedTheme = 'dark';
      else if (e.target.closest?.('.cosmic-icon')) clickedTheme = 'cosmic';
      else {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0) {
          const ratio = (e.clientX - rect.left) / rect.width;
          clickedTheme = ratio < 1 / 3 ? 'light' : ratio < 2 / 3 ? 'dark' : 'cosmic';
        }
      }
    }

    const next =
      clickedTheme && clickedTheme !== curTheme
        ? clickedTheme
        : order[(curIdx + 1) % order.length];
    state.config.theme = next;

    if (btn) {
      btn.classList.remove('is-animating');
      void btn.offsetWidth;
      btn.classList.add('is-animating');
      setTimeout(() => btn.classList.remove('is-animating'), 520);
    }

    const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (typeof document.startViewTransition === 'function' && !prefersReduced && btn) {
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );
      const transition = document.startViewTransition(() => {
        applyTheme(next);
      });
      transition.ready
        .then(() => {
          document.documentElement.animate(
            {
              clipPath: [
                `circle(0px at ${x}px ${y}px)`,
                `circle(${endRadius}px at ${x}px ${y}px)`
              ]
            },
            {
              duration: 520,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              pseudoElement: '::view-transition-new(root)'
            }
          );
        })
        .catch(() => {});
    } else {
      applyTheme(next);
    }

    const res = await window.paperAPI.saveConfig({ theme: next });
    if (res.ok) state.config = res.config;
  }

  let snowRafId = null;
  let snowFlakes = [];

  function syncSnowEffect() {
    const canvas = $('#snow-canvas');
    const btn = $('#btn-snow-toggle');
    const isCosmic = state.config?.theme === 'cosmic';
    const enabled = !isCosmic && Boolean(state.config?.snowMode);
    if (btn) btn.classList.toggle('active', enabled);
    if (!canvas) return;

    const shouldRun = enabled && (state.view === 'home' || state.view === 'library');
    if (!shouldRun) {
      if (snowRafId !== null) {
        cancelAnimationFrame(snowRafId);
        snowRafId = null;
      }
      canvas.classList.add('hidden');
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    canvas.classList.remove('hidden');
    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };
    resizeCanvas();

    if (snowFlakes.length === 0) {
      const count = 52;
      snowFlakes = Array.from({ length: count }, () => ({
        x: Math.random() * (canvas.width || 1200),
        y: Math.random() * (canvas.height || 800),
        r: 1.2 + Math.random() * 2.4,
        vy: 0.45 + Math.random() * 0.9,
        vx: -0.25 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.25 + Math.random() * 0.5
      }));
    }

    if (snowRafId !== null) return;
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (!state.config?.snowMode || (state.view !== 'home' && state.view !== 'library')) {
        snowRafId = null;
        return;
      }
      if (canvas.width !== canvas.parentElement?.clientWidth || canvas.height !== canvas.parentElement?.clientHeight) {
        resizeCanvas();
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const isLight = state.config.theme === 'light';
      for (const f of snowFlakes) {
        f.phase += 0.015;
        f.x += f.vx + Math.sin(f.phase) * 0.35;
        f.y += f.vy;

        if (f.y > h + 8) {
          f.y = -8;
          f.x = Math.random() * w;
        }
        if (f.x > w + 8) f.x = -8;
        if (f.x < -8) f.x = w + 8;

        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = isLight
          ? `rgba(110, 145, 180, ${(f.alpha * 0.72).toFixed(2)})`
          : `rgba(235, 242, 250, ${f.alpha.toFixed(2)})`;
        ctx.fill();
      }
      snowRafId = requestAnimationFrame(tick);
    };
    snowRafId = requestAnimationFrame(tick);
  }

  async function toggleSnowMode() {
    const next = !state.config.snowMode;
    state.config.snowMode = next;
    syncSnowEffect();
    const res = await window.paperAPI.saveConfig({ snowMode: next });
    if (res.ok) state.config = res.config;
  }

  let cosmosRafId = null;
  let cosmosStars = [];
  let milkyWayDust = [];
  let cosmosNoisePattern = null;
  let shootingStars = [];
  let cosmosMouseBound = false;
  const cosmosMouse = { tx: 0, ty: 0, x: 0, y: 0, rawX: -9999, rawY: -9999 };

  const CONSTELLATIONS = [
    // Cassiopeia-style W (top-left)
    {
      pts: [[0.10, 0.16], [0.14, 0.23], [0.18, 0.18], [0.22, 0.25], [0.26, 0.17]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4]]
    },
    // Dipper-style (top-right)
    {
      pts: [[0.72, 0.14], [0.77, 0.17], [0.81, 0.21], [0.86, 0.20], [0.89, 0.27], [0.83, 0.29], [0.81, 0.21]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 2]]
    },
    // Orion-style (bottom-left)
    {
      pts: [[0.11, 0.66], [0.19, 0.64], [0.14, 0.74], [0.16, 0.735], [0.18, 0.73], [0.12, 0.84], [0.21, 0.82]],
      edges: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6], [0, 1], [5, 6]]
    },
    // Lyra / Diamond (bottom-right)
    {
      pts: [[0.78, 0.68], [0.82, 0.74], [0.76, 0.79], [0.83, 0.83], [0.88, 0.76]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]]
    }
  ];

  const COSMOS_ORBITS = [
    { rx: 68, ry: 30, speed: 0.00055, phase: 0.5, color: 'rgba(167, 139, 250, 0.22)', dot: '#C4B5FD', size: 2.4 },
    { rx: 112, ry: 49, speed: 0.00033, phase: 2.4, color: 'rgba(125, 211, 252, 0.16)', dot: '#7DD3FC', size: 3.1 },
    { rx: 162, ry: 70, speed: 0.00020, phase: 4.3, color: 'rgba(244, 114, 182, 0.13)', dot: '#F9A8D4', size: 2.7 }
  ];

  function syncCosmosEffect() {
    const canvas = $('#cosmos-canvas');
    if (!canvas) return;
    const isCosmic = state.config?.theme === 'cosmic';
    const shouldRun = isCosmic && (state.view === 'home' || state.view === 'library');
    if (!shouldRun) {
      if (cosmosRafId !== null) {
        cancelAnimationFrame(cosmosRafId);
        cosmosRafId = null;
      }
      canvas.classList.add('hidden');
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    if (!cosmosMouseBound) {
      cosmosMouseBound = true;
      window.addEventListener('mousemove', (e) => {
        const w = window.innerWidth || 1200;
        const h = window.innerHeight || 800;
        cosmosMouse.tx = (e.clientX / w - 0.5) * 2;
        cosmosMouse.ty = (e.clientY / h - 0.5) * 2;
        const rect = canvas.getBoundingClientRect();
        cosmosMouse.rawX = e.clientX - rect.left;
        cosmosMouse.rawY = e.clientY - rect.top;
      });
    }

    canvas.classList.remove('hidden');
    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };
    resizeCanvas();

    if (cosmosStars.length === 0) {
      const palette = ['#F1F3FF', '#C4B5FD', '#7DD3FC', '#F9A8D4', '#E0E7FF'];
      cosmosStars = Array.from({ length: 100 }, () => ({
        x: Math.random() * (canvas.width || 1200),
        y: Math.random() * (canvas.height || 800),
        r: 0.6 + Math.random() * 1.5,
        depth: 0.25 + Math.random() * 0.85,
        phase: Math.random() * Math.PI * 2,
        speed: 0.012 + Math.random() * 0.024,
        driftX: (Math.random() - 0.5) * 0.1,
        driftY: (Math.random() - 0.5) * 0.08,
        color: palette[Math.floor(Math.random() * palette.length)]
      }));
    }
    if (milkyWayDust.length === 0) {
      const mwPalette = ['#E0E7FF', '#C4B5FD', '#7DD3FC', '#F9A8D4', '#FDE68A'];
      milkyWayDust = Array.from({ length: 340 }, () => {
        const u = Math.random();
        const gauss = (Math.random() + Math.random() + Math.random() - 1.5) * 0.12;
        return {
          u,
          spread: gauss,
          spreadX: (Math.random() - 0.5) * 0.05,
          r: 0.28 + Math.random() * 1.0,
          phase: Math.random() * Math.PI * 2,
          twinkle: 0.008 + Math.random() * 0.018,
          alpha: 0.12 + Math.random() * 0.45,
          color: mwPalette[Math.floor(Math.random() * mwPalette.length)]
        };
      });
    }

    if (!cosmosNoisePattern) {
      const nCanvas = document.createElement('canvas');
      nCanvas.width = 180;
      nCanvas.height = 180;
      const nCtx = nCanvas.getContext('2d');
      if (nCtx) {
        const img = nCtx.createImageData(180, 180);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const rnd = Math.random();
          if (rnd > 0.72) {
            const v = 180 + Math.floor(Math.random() * 75);
            d[i] = v;
            d[i + 1] = v;
            d[i + 2] = 255;
            d[i + 3] = Math.floor((rnd - 0.72) * 58);
          }
        }
        nCtx.putImageData(img, 0, 0);
        const mainCtx = canvas.getContext('2d');
        if (mainCtx) cosmosNoisePattern = mainCtx.createPattern(nCanvas, 'repeat');
      }
    }

    if (cosmosRafId !== null) return;
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (state.config?.theme !== 'cosmic' || (state.view !== 'home' && state.view !== 'library')) {
        cosmosRafId = null;
        return;
      }
      if (canvas.width !== canvas.parentElement?.clientWidth || canvas.height !== canvas.parentElement?.clientHeight) {
        resizeCanvas();
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (cosmosNoisePattern) {
        ctx.save();
        ctx.fillStyle = cosmosNoisePattern;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      // Smooth mouse easing for fluid star flow
      cosmosMouse.x += (cosmosMouse.tx - cosmosMouse.x) * 0.05;
      cosmosMouse.y += (cosmosMouse.ty - cosmosMouse.y) * 0.05;

      // 0. Organic Curved Milky Way & Cosmic Dust Clouds
      const mwParX = -cosmosMouse.x * 8;
      const mwParY = -cosmosMouse.y * 6;
      const mwCurveY = (u) => 0.88 - 0.76 * u + 0.075 * Math.sin(u * Math.PI * 2.1);

      const mwCloudPalette = [
        'rgba(139, 92, 246, 0.052)',
        'rgba(125, 211, 252, 0.042)',
        'rgba(244, 114, 182, 0.036)'
      ];
      for (let i = 0; i < 14; i++) {
        const u = i / 13;
        const cx = (u + Math.sin(i * 1.7) * 0.025) * w + mwParX;
        const cy = (mwCurveY(u) + Math.cos(i * 2.1) * 0.03) * h + mwParY;
        const rad = Math.min(w, h) * (0.14 + (i % 3) * 0.045);
        const cg = ctx.createRadialGradient(cx, cy, 4, cx, cy, rad);
        cg.addColorStop(0, mwCloudPalette[i % mwCloudPalette.length]);
        cg.addColorStop(0.55, 'rgba(139, 92, 246, 0.018)');
        cg.addColorStop(1, 'rgba(9, 10, 20, 0)');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const d of milkyWayDust) {
        d.phase += d.twinkle;
        const bx = (d.u + d.spreadX) * w + mwParX;
        const by = (mwCurveY(d.u) + d.spread) * h + mwParY;
        const tw = 0.65 + 0.35 * Math.sin(d.phase);
        ctx.globalAlpha = d.alpha * tw;
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(bx, by, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 1. Off-Center Main Star (항성) + Concentric Planetary Orbits (right-upper sky)
      const orbitCx = w * 0.83 - cosmosMouse.x * 16;
      const orbitCy = h * 0.24 - cosmosMouse.y * 12;
      ctx.save();
      ctx.translate(orbitCx, orbitCy);

      // Central Star Corona + Core + Diffraction Spikes
      const sunGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 44);
      sunGrad.addColorStop(0, 'rgba(255, 248, 231, 0.95)');
      sunGrad.addColorStop(0.22, 'rgba(196, 181, 253, 0.65)');
      sunGrad.addColorStop(0.55, 'rgba(125, 211, 252, 0.18)');
      sunGrad.addColorStop(1, 'rgba(167, 139, 250, 0)');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 44, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(241, 243, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-22, 0); ctx.lineTo(22, 0);
      ctx.moveTo(0, -22); ctx.lineTo(0, 22);
      ctx.stroke();

      ctx.fillStyle = '#FFFDF7';
      ctx.beginPath();
      ctx.arc(0, 0, 6.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.rotate(-0.24);
      for (const orb of COSMOS_ORBITS) {
        orb.phase += orb.speed * 16;

        ctx.globalAlpha = 1;
        ctx.strokeStyle = orb.color;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.ellipse(0, 0, orb.rx, orb.ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        const dir = orb.speed >= 0 ? -1 : 1;
        ctx.strokeStyle = orb.dot;
        ctx.globalAlpha = 0.34;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, 0, orb.rx, orb.ry, 0, orb.phase, orb.phase + dir * 0.32, dir < 0);
        ctx.stroke();

        const px = Math.cos(orb.phase) * orb.rx;
        const py = Math.sin(orb.phase) * orb.ry;
        ctx.fillStyle = orb.dot;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(px, py, orb.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.24;
        ctx.beginPath();
        ctx.arc(px, py, orb.size * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // 1b. Soft Distant Nebula Cluster (bottom-left sky)
      const nebX = w * 0.14 - cosmosMouse.x * 16;
      const nebY = h * 0.78 - cosmosMouse.y * 12;
      const nebGrad = ctx.createRadialGradient(nebX, nebY, 4, nebX, nebY, 95);
      nebGrad.addColorStop(0, 'rgba(167, 139, 250, 0.14)');
      nebGrad.addColorStop(0.45, 'rgba(125, 211, 252, 0.06)');
      nebGrad.addColorStop(1, 'rgba(9, 10, 20, 0)');
      ctx.fillStyle = nebGrad;
      ctx.beginPath();
      ctx.arc(nebX, nebY, 95, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // 2. Constellations
      const parX = -cosmosMouse.x * 22;
      const parY = -cosmosMouse.y * 16;
      for (const c of CONSTELLATIONS) {
        const screenPts = c.pts.map(([nx, ny]) => [nx * w + parX, ny * h + parY]);
        const nearMouse = screenPts.some(([sx, sy]) => Math.hypot(sx - cosmosMouse.rawX, sy - cosmosMouse.rawY) < 130);
        ctx.strokeStyle = nearMouse ? 'rgba(196, 181, 253, 0.44)' : 'rgba(196, 181, 253, 0.18)';
        ctx.lineWidth = nearMouse ? 1.2 : 0.9;
        ctx.beginPath();
        for (const [a, b] of c.edges) {
          ctx.moveTo(screenPts[a][0], screenPts[a][1]);
          ctx.lineTo(screenPts[b][0], screenPts[b][1]);
        }
        ctx.stroke();

        for (const [sx, sy] of screenPts) {
          ctx.fillStyle = nearMouse ? '#E0E7FF' : '#C4B5FD';
          ctx.globalAlpha = nearMouse ? 0.92 : 0.65;
          ctx.beginPath();
          ctx.arc(sx, sy, nearMouse ? 2.4 : 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // 3. Mouse-Reactive Starfield Flow
      const flowVx = cosmosMouse.x * 0.42;
      const flowVy = cosmosMouse.y * 0.32;
      for (const s of cosmosStars) {
        s.phase += s.speed;
        s.x += (s.driftX + flowVx) * s.depth;
        s.y += (s.driftY + flowVy) * s.depth;
        if (s.x < -4) s.x = w + 4;
        if (s.x > w + 4) s.x = -4;
        if (s.y < -4) s.y = h + 4;
        if (s.y > h + 4) s.y = -4;
        const alpha = 0.25 + 0.68 * (0.5 + 0.5 * Math.sin(s.phase));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4. Occasional Shooting Stars
      if (Math.random() < 0.008 && shootingStars.length < 2) {
        shootingStars.push({
          x: Math.random() * w * 0.7,
          y: Math.random() * h * 0.35,
          vx: 7 + Math.random() * 5,
          vy: 3.5 + Math.random() * 2.5,
          life: 1.0
        });
      }
      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const st = shootingStars[i];
        st.x += st.vx;
        st.y += st.vy;
        st.life -= 0.035;
        if (st.life <= 0) {
          shootingStars.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = st.life * 0.8;
        const grad = ctx.createLinearGradient(st.x, st.y, st.x - st.vx * 6, st.y - st.vy * 6);
        grad.addColorStop(0, '#E0E7FF');
        grad.addColorStop(1, 'rgba(167, 139, 250, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(st.x, st.y);
        ctx.lineTo(st.x - st.vx * 6, st.y - st.vy * 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      cosmosRafId = requestAnimationFrame(tick);
    };
    cosmosRafId = requestAnimationFrame(tick);
  }

  function renderOpenPaperTabs() {
    const strip = $('#open-paper-tabs');
    if (!strip) return;
    strip.innerHTML = state.openTabs
      .map((tab) => {
        const meta = tab.paper?.meta || {};
        const fullTitle = String(meta.title || meta.short_title || 'Untitled').trim();
        const colonIdx = fullTitle.indexOf(':');
        const title = colonIdx > 0 ? fullTitle.slice(0, colonIdx).trim() : fullTitle;
        const isActive = state.view === 'reader' && state.activeTabHash === tab.pdfHash;
        return `
          <div class="paper-tab ${isActive ? 'active' : ''}" data-hash="${escapeHtml(tab.pdfHash)}" title="${escapeHtml(meta.title || title)}">
            <span class="paper-tab-title">${escapeHtml(title)}</span>
            <button class="paper-tab-close" data-close-tab="${escapeHtml(tab.pdfHash)}" title="탭 닫기">✕</button>
          </div>
        `;
      })
      .join('');

    strip.querySelectorAll('.paper-tab').forEach((el) => {
      el.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('[data-close-tab]');
        if (closeBtn) {
          e.stopPropagation();
          closePaperTab(closeBtn.dataset.closeTab);
          return;
        }
        activatePaperTab(el.dataset.hash);
      });
    });
  }

  function formatLastOpened(ts) {
    if (!ts) return '';
    const diffMs = Date.now() - Number(ts);
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return '방금 전';
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const d = new Date(Number(ts));
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function bindPaperDragSource(el, pdfHash, title) {
    if (!el || !pdfHash) return;
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      const safeTitle = String(title || 'PaperReader 논문').trim();
      if (window.paperAPI.startPaperDrag) {
        e.preventDefault();
        window.paperAPI.startPaperDrag({ pdfHash, title: safeTitle });
        return;
      }
      if (!e.dataTransfer) return;
      const deepLink = `paperreader://open/${encodeURIComponent(pdfHash)}?title=${encodeURIComponent(safeTitle)}`;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', deepLink);
    });
  }

  function renderHomeRecentList() {
    const listEl = $('#recent-list');
    if (!listEl) return;
    const MAX_HOME_RECENT = 5;
    const items = (state.recent || [])
      .slice()
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .slice(0, MAX_HOME_RECENT);

    if (items.length === 0) {
      listEl.innerHTML = `<div class="sidebar-card" style="text-align:center;padding:28px;color:var(--text-secondary);">아직 연 논문이 없습니다. 창 아무 곳에나 PDF 파일을 끌어다 놓아보세요.</div>`;
      return;
    }

    listEl.innerHTML = items
      .map(
        (item) => `
        <div class="recent-row" data-hash="${escapeHtml(item.pdf_hash)}" title="${escapeHtml(item.title)}">
          <span class="recent-row-title">${escapeHtml(item.title)}</span>
          <div class="recent-row-meta">
            ${item.year ? `<span class="paper-year-badge">${escapeHtml(item.year)}</span>` : ''}
            <span class="recent-row-time">${escapeHtml(formatLastOpened(item.updated_at))}</span>
          </div>
        </div>`
      )
      .join('');

    listEl.querySelectorAll('.recent-row').forEach((row) => {
      row.addEventListener('click', () => openPaperInReader(row.dataset.hash));
      const title = row.querySelector('.recent-row-title')?.textContent || row.title || '';
      bindPaperDragSource(row, row.dataset.hash, title);
    });
    renderKnowledgeGraph();
  }

  const kgState = {
    nodes: [],
    edges: [],
    hoveredId: null,
    draggingId: null,
    panning: false,
    panStartX: 0,
    panStartY: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragMoved: false,
    rafId: null,
    bound: false,
    signature: ''
  };

  function buildKnowledgeGraphData(width, height) {
    const items = state.recent || [];
    const nodes = [];
    const edges = [];
    const conceptMap = new Map();

    const cx = width / 2;
    const cy = height / 2;
    const pCount = Math.max(1, items.length);

    const paperR = pCount > 8 ? 17 : 21;

    items.forEach((item, idx) => {
      const angle = (idx / pCount) * Math.PI * 2 - Math.PI / 2;
      const rad = Math.min(width, height) * (pCount > 8 ? 0.34 : 0.27);
      const pNodeId = `paper:${item.pdf_hash}`;
      const fullTitle = String(item.title || item.short_title || 'Untitled').trim();
      const colonIdx = fullTitle.indexOf(':');
      const baseLabel = colonIdx > 0 ? fullTitle.slice(0, colonIdx).trim() : fullTitle;
      const label = baseLabel.length > 26 ? `${baseLabel.slice(0, 24)}…` : baseLabel;
      nodes.push({
        id: pNodeId,
        kind: 'paper',
        pdfHash: item.pdf_hash,
        label,
        fullTitle: item.title,
        year: item.year || '',
        summary: item.one_line_summary || '',
        tags: item.tags || [],
        x: cx + Math.cos(angle) * rad,
        y: cy + Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        r: paperR
      });

      const rawTags = Array.isArray(item.tags) ? item.tags.slice(0, 5) : [];
      const hay = `${item.title || ''} ${item.one_line_summary || ''} ${rawTags.join(' ')}`.toLowerCase();
      const extraConcepts = [];
      if (hay.includes('transformer') && !rawTags.some((t) => t.toLowerCase() === '#transformer')) {
        extraConcepts.push('#Transformer');
      }
      if (hay.includes('attention') && !rawTags.some((t) => t.toLowerCase().includes('attention'))) {
        extraConcepts.push('#Attention');
      }
      if ((hay.includes('zero-shot') || hay.includes('transfer')) && !rawTags.some((t) => t.toLowerCase().includes('zeroshot'))) {
        extraConcepts.push('#ZeroShot');
      }

      const allConcepts = [...new Set([...rawTags, ...extraConcepts])];
      allConcepts.forEach((tag) => {
        const key = tag.toLowerCase();
        if (!conceptMap.has(key)) {
          conceptMap.set(key, {
            id: `tag:${key}`,
            kind: 'tag',
            label: tag.startsWith('#') ? tag : `#${tag}`,
            paperIds: []
          });
        }
        conceptMap.get(key).paperIds.push(pNodeId);
      });
    });

    const conceptList = [...conceptMap.values()];
    conceptList.forEach((c, idx) => {
      const angle = (idx / Math.max(1, conceptList.length)) * Math.PI * 2;
      const isShared = c.paperIds.length > 1;
      const rad = isShared ? Math.min(width, height) * 0.08 : Math.min(width, height) * 0.36;
      nodes.push({
        id: c.id,
        kind: 'tag',
        label: c.label,
        shared: isShared,
        x: cx + Math.cos(angle) * rad,
        y: cy + Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        r: isShared ? 9.5 : 6.5
      });
      c.paperIds.forEach((pid) => {
        edges.push({ from: pid, to: c.id, shared: isShared });
      });
    });

    return { nodes, edges };
  }

  function renderKnowledgeGraph(forceRelayout = false) {
    const canvas = $('#knowledge-graph-canvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const width = wrap?.clientWidth || 820;
    const height = wrap?.clientHeight || 440;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const sig = (state.recent || []).map((p) => `${p.pdf_hash}:${(p.tags || []).join(',')}`).join('|');
    if (forceRelayout || kgState.signature !== sig || kgState.nodes.length === 0) {
      const built = buildKnowledgeGraphData(width, height);
      kgState.nodes = built.nodes;
      kgState.edges = built.edges;
      kgState.signature = sig;
      kgState.zoom = 1;
      kgState.panX = 0;
      kgState.panY = 0;
    }

    if (!kgState.bound) {
      kgState.bound = true;
      const getPos = (e) => {
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        return {
          x: sx,
          y: sy,
          wx: (sx - kgState.panX) / kgState.zoom,
          wy: (sy - kgState.panY) / kgState.zoom
        };
      };
      const hitNode = (wx, wy) => {
        for (let i = kgState.nodes.length - 1; i >= 0; i--) {
          const n = kgState.nodes[i];
          if (Math.hypot(n.x - wx, n.y - wy) <= n.r + 8 / kgState.zoom) return n;
        }
        return null;
      };
      const updateTooltip = (node, x, y) => {
        const tip = $('#kg-tooltip');
        if (!tip) return;
        if (!node || node.kind !== 'paper') {
          tip.classList.add('hidden');
          return;
        }
        tip.innerHTML = `
          <div class="kg-tooltip-title">${escapeHtml(node.fullTitle)}${node.year ? ` (${escapeHtml(node.year)})` : ''}</div>
          ${node.summary ? `<div class="kg-tooltip-sub">${escapeHtml(node.summary)}</div>` : ''}
        `;
        tip.classList.remove('hidden');
        const tw = tip.offsetWidth || 240;
        const th = tip.offsetHeight || 70;
        const tx = Math.min(Math.max(10, x + 14), (wrap?.clientWidth || 800) - tw - 10);
        const ty = Math.min(Math.max(10, y - th - 10), (wrap?.clientHeight || 440) - th - 10);
        tip.style.left = `${tx}px`;
        tip.style.top = `${ty}px`;
      };

      canvas.addEventListener(
        'wheel',
        (e) => {
          if (state.view !== 'home') return;
          e.preventDefault();
          e.stopPropagation();
          const { x, y, wx, wy } = getPos(e);
          const factor = e.ctrlKey
            ? Math.exp(-e.deltaY * 0.012)
            : e.deltaY < 0
              ? 1.12
              : 1 / 1.12;
          const nextZoom = Math.min(3.2, Math.max(0.45, kgState.zoom * factor));
          kgState.zoom = nextZoom;
          kgState.panX = x - wx * nextZoom;
          kgState.panY = y - wy * nextZoom;
        },
        { passive: false }
      );

      canvas.addEventListener('mousedown', (e) => {
        const { x, y, wx, wy } = getPos(e);
        const n = hitNode(wx, wy);
        if (n) {
          kgState.draggingId = n.id;
          kgState.dragMoved = false;
          canvas.classList.add('is-dragging');
        } else {
          kgState.panning = true;
          kgState.panStartX = x - kgState.panX;
          kgState.panStartY = y - kgState.panY;
          canvas.classList.add('is-dragging');
        }
      });
      window.addEventListener('mousemove', (e) => {
        if (state.view !== 'home') return;
        const { x, y, wx, wy } = getPos(e);
        if (kgState.panning) {
          kgState.panX = x - kgState.panStartX;
          kgState.panY = y - kgState.panStartY;
          return;
        }
        if (kgState.draggingId) {
          const n = kgState.nodes.find((item) => item.id === kgState.draggingId);
          if (n) {
            n.x = wx;
            n.y = wy;
            n.vx = 0;
            n.vy = 0;
            kgState.dragMoved = true;
            updateTooltip(n, x, y);
          }
          return;
        }
        const n = hitNode(wx, wy);
        kgState.hoveredId = n ? n.id : null;
        canvas.style.cursor = n ? 'pointer' : 'grab';
        updateTooltip(n, x, y);
      });
      window.addEventListener('mouseup', () => {
        if (kgState.panning) {
          kgState.panning = false;
          canvas.classList.remove('is-dragging');
        }
        if (!kgState.draggingId) return;
        const id = kgState.draggingId;
        const moved = kgState.dragMoved;
        kgState.draggingId = null;
        canvas.classList.remove('is-dragging');
        if (!moved) {
          const n = kgState.nodes.find((item) => item.id === id);
          if (n?.kind === 'paper' && n.pdfHash) {
            openPaperInReader(n.pdfHash);
          }
        }
      });
      canvas.addEventListener('mouseleave', () => {
        if (!kgState.draggingId) {
          kgState.hoveredId = null;
          $('#kg-tooltip')?.classList.add('hidden');
        }
      });
    }

    if (kgState.rafId !== null) return;
    const ctx = canvas.getContext('2d');
    const step = () => {
      if (state.view !== 'home') {
        kgState.rafId = null;
        return;
      }
      const w = wrap?.clientWidth || 820;
      const h = wrap?.clientHeight || 440;
      const curDpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(w * curDpr) || canvas.height !== Math.floor(h * curDpr)) {
        canvas.width = Math.floor(w * curDpr);
        canvas.height = Math.floor(h * curDpr);
      }

      const nodes = kgState.nodes;
      const edges = kgState.edges;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Lightweight force simulation
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.id === kgState.draggingId) continue;
        // Center attraction
        a.vx += (w / 2 - a.x) * 0.0008;
        a.vy += (h / 2 - a.y) * 0.0008;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = Math.max(450, dx * dx + dy * dy);
          const minSep = a.kind === 'paper' && b.kind === 'paper' ? 28000 : 8800;
          const f = minSep / d2;
          const dist = Math.sqrt(d2);
          const fx = (dx / dist) * f * 0.085;
          const fy = (dy / dist) * f * 0.085;
          if (a.id !== kgState.draggingId) {
            a.vx += fx;
            a.vy += fy;
          }
          if (b.id !== kgState.draggingId) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }

      for (const e of edges) {
        const a = nodeMap.get(e.from);
        const b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const targetLen = e.shared ? 98 : 72;
        const pull = (dist - targetLen) * 0.0045;
        const fx = (dx / dist) * pull;
        const fy = (dy / dist) * pull;
        if (a.id !== kgState.draggingId) {
          a.vx += fx;
          a.vy += fy;
        }
        if (b.id !== kgState.draggingId) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const n of nodes) {
        if (n.id === kgState.draggingId) continue;
        n.vx *= 0.85;
        n.vy *= 0.85;
        const padX = n.kind === 'paper' ? n.r + 48 : n.r + 28;
        const padY = n.kind === 'paper' ? n.r + 28 : n.r + 22;
        n.x = Math.max(padX, Math.min(w - padX, n.x + n.vx));
        n.y = Math.max(padY, Math.min(h - padY, n.y + n.vy));
      }

      // Draw
      ctx.save();
      ctx.scale(curDpr, curDpr);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(kgState.panX, kgState.panY);
      ctx.scale(kgState.zoom, kgState.zoom);

      const isLight = state.config?.theme === 'light';
      const isCosmic = state.config?.theme === 'cosmic';
      const accent = isCosmic ? '#A78BFA' : isLight ? '#8F573E' : '#C79B85';
      const textPrimary = isCosmic ? '#F1F3FF' : isLight ? '#171614' : '#EFECE6';
      const textMuted = isCosmic ? '#A6B0D6' : isLight ? '#66625B' : '#A3A099';
      const labelBg = isCosmic ? 'rgba(13, 17, 36, 0.72)' : isLight ? 'rgba(244, 241, 234, 0.86)' : 'rgba(28, 28, 27, 0.78)';
      const hoverId = kgState.hoveredId;

      // Edges
      for (const e of edges) {
        const a = nodeMap.get(e.from);
        const b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const highlighted = hoverId && (e.from === hoverId || e.to === hoverId);
        const dimmedEdge = hoverId && !highlighted;
        ctx.globalAlpha = dimmedEdge ? 0.16 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.setLineDash([]);
        ctx.strokeStyle = highlighted
          ? accent
          : e.shared
            ? (isLight ? 'rgba(143,87,62,0.34)' : 'rgba(199,155,133,0.28)')
            : (isLight ? 'rgba(74,71,65,0.2)' : 'rgba(163,160,153,0.16)');
        ctx.lineWidth = highlighted ? 1.9 : 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // Nodes
      for (const n of nodes) {
        const isHover = n.id === hoverId;
        const isConnected = hoverId && edges.some((e) => (e.from === hoverId && e.to === n.id) || (e.to === hoverId && e.from === n.id));
        const dimmed = hoverId && !isHover && !isConnected;
        ctx.globalAlpha = dimmed ? 0.25 : 1;

        if (n.kind === 'paper') {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + (isHover ? 3.5 : 0), 0, Math.PI * 2);
          ctx.fillStyle = isHover ? accent : isLight ? 'rgba(143,87,62,0.16)' : 'rgba(199,155,133,0.20)';
          ctx.fill();
          ctx.lineWidth = isHover ? 2.4 : 1.7;
          ctx.strokeStyle = accent;
          ctx.stroke();

          ctx.font = '600 11.5px "Pretendard Variable", sans-serif';
          const tw = ctx.measureText(n.label).width;
          const lx = n.x;
          const ly = n.y + n.r + 14;
          ctx.fillStyle = labelBg;
          ctx.beginPath();
          ctx.roundRect(lx - tw / 2 - 5, ly - 10, tw + 10, 14, 4);
          ctx.fill();

          ctx.fillStyle = textPrimary;
          ctx.textAlign = 'center';
          ctx.fillText(n.label, lx, ly + 1);
          if (n.year) {
            ctx.font = '700 10px "Pretendard Variable", sans-serif';
            ctx.fillStyle = isHover ? '#FFFFFF' : accent;
            ctx.fillText(n.year, n.x, n.y + 3.5);
          }
        } else {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + (isHover ? 2.5 : 0), 0, Math.PI * 2);
          ctx.fillStyle = n.shared ? accent : isLight ? '#BEB6A6' : '#444440';
          ctx.fill();

          ctx.font = `${n.shared ? '600' : '500'} 10.5px "Pretendard Variable", sans-serif`;
          ctx.fillStyle = n.shared || isHover ? accent : textMuted;
          ctx.textAlign = 'center';
          ctx.fillText(n.label, n.x, n.y + n.r + 12);
        }
      }
      ctx.restore();
      kgState.rafId = requestAnimationFrame(step);
    };
    kgState.rafId = requestAnimationFrame(step);
  }

  // View Switching
  function switchView(viewName, opts = {}) {
    const prevView = state.view;
    state.view = viewName;

    $('#tab-hub').classList.toggle('active', viewName === 'home');
    $('#tab-library').classList.toggle('active', viewName === 'library');
    $('#view-reader')?.classList.toggle('slide-enter', viewName === 'reader' && Boolean(opts.isNewTab));
    $$('.view').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });

    const inReader = viewName === 'reader';
    const hasPaper = Boolean(state.reader?.paper);
    $('#reader-subbar').classList.toggle('hidden', !inReader || !hasPaper);
    $('#reader-workspace').classList.toggle('hidden', !inReader || !hasPaper);
    $('#reader-empty-state').classList.toggle('hidden', !inReader || hasPaper);

    if (inReader && prevView === 'reader' && hasPaper) {
      const ws = $('#reader-workspace');
      if (ws) {
        ws.classList.remove('view-entering');
        void ws.offsetWidth;
        ws.classList.add('view-entering');
      }
    }

    renderOpenPaperTabs();
    hideFloatingOverlays();
    syncSnowEffect();
    syncCosmosEffect();

    if (viewName === 'home') {
      renderHomeRecentList();
    } else if (viewName === 'library') {
      refreshLibrarySearch();
    } else if (viewName === 'reader') {
      if (hasPaper) {
        if (state.reader.zoomMode === 'fit' && !opts.skipAutoFitRender) {
          setTimeout(() => renderCurrentPdfPage(), 40);
        }
      }
    }
  }

  function getStatusMeta(status) {
    if (status === 'Done') {
      return {
        cls: 'done',
        label: 'Done',
        title: '다 읽음 (클릭하여 상태 전환)',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
      };
    }
    if (status === 'Reading') {
      return {
        cls: 'reading',
        label: 'Reading',
        title: '읽는 중 (클릭하여 상태 전환)',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>'
      };
    }
    return {
      cls: 'unread',
      label: 'Unread',
      title: '안 읽음 (클릭하여 상태 전환)',
      icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>'
    };
  }

  async function togglePaperStatus(pdfHash, mode = 'cycle') {
    const target =
      (state.recent || []).find((p) => p.pdf_hash === pdfHash) ||
      (state.library.results || []).find((p) => p.pdf_hash === pdfHash);
    if (!target) return;
    let nextStatus;
    if (mode === 'reader-done') {
      nextStatus = target.status === 'Done' ? 'Reading' : 'Done';
    } else {
      const order = ['Unread', 'Reading', 'Done'];
      const curIdx = order.indexOf(target.status);
      nextStatus = order[(curIdx + 1) % order.length];
    }
    const res = await window.paperAPI.updateMeta({
      pdfHash,
      updates: { status: nextStatus }
    });
    if (res.ok) {
      state.recent = res.recent;
      const openTab = state.openTabs.find((t) => t.pdfHash === pdfHash);
      if (openTab && openTab.paper) {
        openTab.paper.meta = res.meta;
        if (state.reader === openTab) updateReaderHeaderControls();
      }
      await refreshLibrarySearch();
      if (nextStatus === 'Done') {
        showToast('다 읽음 상태로 변경되었습니다.', 'success');
      }
    }
  }

  async function togglePaperFavorite(pdfHash) {
    const target =
      (state.library.results || []).find((p) => p.pdf_hash === pdfHash) ||
      (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!target) return;
    const nextFav = !target.favorite;
    const res = await window.paperAPI.updateMeta({
      pdfHash,
      updates: { favorite: nextFav }
    });
    if (res.ok) {
      state.recent = res.recent;
      const openTab = state.openTabs.find((t) => t.pdfHash === pdfHash);
      if (openTab && openTab.paper) {
        openTab.paper.meta = res.meta;
      }
      await refreshLibrarySearch();
      showToast(nextFav ? '즐겨찾기에 추가되어 상단에 고정되었습니다.' : '즐겨찾기가 해제되었습니다.', 'success');
    }
  }

  // ② LIBRARY VIEW
  async function refreshLibrarySearch() {
    const res = await window.paperAPI.searchLibrary({
      query: state.library.query,
      statusFilter: state.library.statusFilter,
      tagFilter: state.library.tagFilter,
      sortBy: state.library.sortBy
    });
    if (res.ok) {
      state.library.results = res.results;
      state.tags = res.tags || state.tags;
      renderLibraryList();
    }
  }

  function renderLibraryList() {
    const listEl = $('#library-list');
    const items = state.library.results || [];
    const isCompact = state.library.viewMode === 'compact';
    listEl.classList.toggle('compact', isCompact);

    if (items.length === 0) {
      listEl.innerHTML = `<div class="sidebar-card" style="grid-column:1/-1;text-align:center;padding:36px;color:var(--text-secondary);">검색 조건에 맞는 논문이 없습니다.</div>`;
      return;
    }

    if (isCompact) {
      listEl.innerHTML = items
        .map((item) => {
          const st = getStatusMeta(item.status);
          return `
            <div class="lib-compact-row" data-hash="${escapeHtml(item.pdf_hash)}">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                ${item.year ? `<span class="paper-year-badge">${escapeHtml(item.year)}</span>` : ''}
                <span class="card-title" style="-webkit-line-clamp:1;font-size:13.5px;">${escapeHtml(item.title)}</span>
                ${(item.tags || []).slice(0, 3).map((t) => `<span class="lib-tag-pill">${escapeHtml(t)}</span>`).join('')}
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                <button class="status-pill ${st.cls}" data-action="toggle-status" data-hash="${escapeHtml(item.pdf_hash)}" title="${escapeHtml(st.title)}" aria-label="${escapeHtml(st.label)}">${st.icon}</button>
                <button class="icon-btn-sm delete-icon-btn" data-action="delete-paper" data-hash="${escapeHtml(item.pdf_hash)}" title="논문 삭제">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.lib-compact-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          const actionEl = e.target.closest('[data-action]');
          if (actionEl) {
            e.stopPropagation();
            const act = actionEl.dataset.action;
            if (act === 'toggle-status') togglePaperStatus(actionEl.dataset.hash);
            else if (act === 'delete-paper') openDeleteConfirmModal(actionEl.dataset.hash);
            return;
          }
          openPaperInReader(row.dataset.hash);
        });
      });
      return;
    }

    listEl.innerHTML = items
      .map((item) => {
        const st = getStatusMeta(item.status);
        const match = item.matchInfo;

        let snippetHtml = '';
        if (match && match.source === 'translation') {
          snippetHtml = `
            <div class="lib-snippet-box" data-action="jump" data-page="${match.page}" data-block="${escapeHtml(match.block_id || '')}">
              <span class="lib-snippet-label">번역 본문 검색 매칭 (p.${match.page})</span>
              ${escapeHtml(match.snippet)}
            </div>`;
        }

        const attIconSvg = (type) => {
          if (type === 'notion') {
            return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
          }
          if (type === 'web') {
            return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
          }
          return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
        };

        const atts = Array.isArray(item.attachments) ? item.attachments : [];
        const attChipsHtml = atts
          .slice(0, 3)
          .map(
            (a) =>
              `<button class="att-chip" data-action="open-att" data-target="${escapeHtml(a.target)}" title="${escapeHtml(a.target)}">${attIconSvg(a.type)} <span>${escapeHtml(a.title)}</span></button>`
          )
          .join('');
        const extraAtts = atts.length > 3 ? `<span class="lib-tag-pill">+${atts.length - 3}</span>` : '';

        const formatVenueName = (venue) => {
          let v = String(venue || '').trim();
          if (!v) return '';
          const parenMatch = v.match(/\(([^)]+)\)/);
          if (/^arxiv\b/i.test(v) && parenMatch && !/arxiv/i.test(parenMatch[1])) {
            v = parenMatch[1];
          } else {
            v = v.replace(/\([^)]*\)/g, '');
          }
          return v.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/^[\s,;/\-]+|[\s,;/\-]+$/g, '').trim();
        };
        const venueLabel = formatVenueName(item.venue);

        return `
          <article class="lib-card ${item.favorite ? 'is-favorite' : ''}" data-hash="${escapeHtml(item.pdf_hash)}">
            <div class="card-top-row">
              <h3 class="card-title">${escapeHtml(item.title)}</h3>
              <button class="status-pill ${st.cls}" data-action="toggle-status" data-hash="${escapeHtml(item.pdf_hash)}" title="${escapeHtml(st.title)}" aria-label="${escapeHtml(st.label)}">${st.icon}</button>
            </div>
            ${item.one_line_summary ? `<div class="lib-summary-line">${escapeHtml(item.one_line_summary)}</div>` : ''}
            <div class="lib-tags-mini">
              ${item.year ? `<span class="paper-year-badge">${escapeHtml(item.year)}</span>` : ''}
              ${venueLabel ? `<span class="paper-venue-badge" title="${escapeHtml(item.venue)}">${escapeHtml(venueLabel)}</span>` : ''}
              ${(item.tags || []).map((t) => `<span class="lib-tag-pill">${escapeHtml(t)}</span>`).join('')}
            </div>
            ${snippetHtml}
            <div class="lib-card-footer">
              <div class="lib-att-chips">${attChipsHtml}${extraAtts}</div>
              <div class="card-actions-cluster">
                <button class="icon-btn-sm fav-icon-btn ${item.favorite ? 'is-fav' : ''}" data-action="toggle-favorite" data-hash="${escapeHtml(item.pdf_hash)}" title="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기 (상단 고정)'}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="${item.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
                <button class="icon-btn-sm clip-icon-btn ${atts.length > 0 ? 'has-atts' : ''}" data-action="open-attachments" data-hash="${escapeHtml(item.pdf_hash)}" title="노션 페이지 · 링크 · 파일 첨부 (또는 카드에 드래그 앤 드롭)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  ${atts.length > 0 ? `<span class="clip-count">${atts.length}</span>` : ''}
                </button>
                <button class="icon-btn-sm" data-action="edit-meta" data-hash="${escapeHtml(item.pdf_hash)}" title="태그/요약 수정">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button class="icon-btn-sm delete-icon-btn" data-action="delete-paper" data-hash="${escapeHtml(item.pdf_hash)}" title="논문 삭제">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    listEl.querySelectorAll('.lib-card').forEach((card) => {
      const cardTitle = card.querySelector('.card-title')?.textContent || '';
      bindPaperDragSource(card, card.dataset.hash, cardTitle);

      if (!prefersReducedMotion) {
        card.addEventListener('mousemove', (e) => {
          if (card.classList.contains('is-dragging')) return;
          const rect = card.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const py = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
          const rx = (0.5 - py) * 7.5;
          const ry = (px - 0.5) * 9.0;
          card.classList.add('is-tilting');
          card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
          card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
          card.style.setProperty('--glow-opacity', '1');
          card.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-3px) scale(1.012)`;
        });
        const resetTilt = () => {
          card.classList.remove('is-tilting');
          card.style.setProperty('--glow-opacity', '0');
          card.style.transform = '';
        };
        card.addEventListener('mouseleave', resetTilt);
        card.addEventListener('dragstart', resetTilt);
      }

      card.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drag-over');
        await handleAttachmentDrop(card.dataset.hash, e.dataTransfer);
      });

      card.addEventListener('click', (e) => {
        const hash = card.dataset.hash;
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
          e.stopPropagation();
          const act = actionEl.dataset.action;
          if (act === 'toggle-status') {
            togglePaperStatus(hash);
          } else if (act === 'toggle-favorite') {
            togglePaperFavorite(hash);
          } else if (act === 'edit-meta') {
            openMetaModal(hash);
          } else if (act === 'delete-paper') {
            openDeleteConfirmModal(hash);
          } else if (act === 'open-attachments') {
            openAttachmentsModal(hash);
          } else if (act === 'open-att') {
            window.paperAPI.openAttachment(actionEl.dataset.target);
          } else if (act === 'jump') {
            openPaperInReader(hash, Number(actionEl.dataset.page) || 1, actionEl.dataset.block || null);
          }
          return;
        }
        openPaperInReader(hash);
      });
    });
  }

  // ③ READER VIEW (Multi-Tab)
  function applyTabUiPreferences(tab) {
    const syncBtn = $('#btn-sync-toggle');
    syncBtn.classList.toggle('active', tab.syncOn);
    syncBtn.querySelector('span:last-child').textContent = tab.syncOn ? 'Sync ON' : 'Sync OFF';

    const isSum = tab.middleMode === 'summary';
    $$('#middle-mode-toggle .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === tab.middleMode);
    });
    $('#translation-pane').classList.toggle('hidden', isSum);
    $('#summary-pane').classList.toggle('hidden', !isSum);
    updateMiddleStatusControls();

    $('#reader-sidebar').classList.toggle('collapsed', tab.sidebarCollapsed);
    $('#btn-toggle-sidebar').classList.toggle('active', !tab.sidebarCollapsed);
    $('#reader-left-panel').classList.toggle('collapsed', Boolean(tab.pdfCollapsed));
    $('#btn-toggle-pdf').classList.toggle('active', !tab.pdfCollapsed);
  }

  async function activatePaperTab(pdfHash, targetPage = null, jumpBlockId = null) {
    const tab = state.openTabs.find((t) => t.pdfHash === pdfHash);
    if (!tab) return;

    state.reader = tab;
    state.activeTabHash = pdfHash;
    if (jumpBlockId) tab.pendingJumpBlockId = jumpBlockId;

    if (window.paperAPI.getAgyStatus) {
      const agySt = await window.paperAPI.getAgyStatus(pdfHash);
      if (agySt?.status) state.agyJobs.set(pdfHash, agySt);
    }

    switchView('reader', { skipAutoFitRender: true });
    applyTabUiPreferences(tab);
    updateReaderHeaderControls();
    applyPdfFilter();
    renderSummaryPane();
    renderSidebar();

    if (targetPage !== null) {
      await renderCurrentPdfPage();
      renderTranslationPane();
      await goToPage(targetPage);
    } else {
      await renderCurrentPdfPage();
      renderTranslationPane();
      scrollPdfAndTransToPage(tab.currentPage, { smooth: false });
      if (tab.pendingJumpBlockId) {
        const bId = tab.pendingJumpBlockId;
        tab.pendingJumpBlockId = null;
        setHoveredBlock(bId, { scrollRight: true });
      }
    }
  }

  const closingTabHashes = new Set();

  async function animateArchiveClose(pdfHash) {
    const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (prefersReduced) return;

    const tabEl = $(`#open-paper-tabs .paper-tab[data-hash="${CSS.escape(pdfHash)}"]`);
    if (tabEl) tabEl.classList.add('is-closing');

    const isActiveReader = state.view === 'reader' && state.activeTabHash === pdfHash;
    const readerEl = $('#view-reader');

    if (isActiveReader && readerEl) {
      readerEl.classList.add('is-closing');
      await new Promise((r) => setTimeout(r, 175));
    } else if (tabEl) {
      await new Promise((r) => setTimeout(r, 155));
    }
  }

  async function closePaperTab(pdfHash) {
    if (!pdfHash || closingTabHashes.has(pdfHash)) return;
    const idx = state.openTabs.findIndex((t) => t.pdfHash === pdfHash);
    if (idx === -1) return;

    closingTabHashes.add(pdfHash);
    try {
      await animateArchiveClose(pdfHash);
    } finally {
      closingTabHashes.delete(pdfHash);
    }

    const curIdx = state.openTabs.findIndex((t) => t.pdfHash === pdfHash);
    if (curIdx === -1) return;
    const [removed] = state.openTabs.splice(curIdx, 1);
    if (removed?.renderTask) {
      try { removed.renderTask.cancel(); } catch {}
    }

    if (state.activeTabHash === pdfHash) {
      const nextTab = state.openTabs[curIdx] || state.openTabs[curIdx - 1] || null;
      if (nextTab) {
        await activatePaperTab(nextTab.pdfHash);
      } else {
        state.activeTabHash = null;
        state.reader = createEmptyTabState();
        switchView('home');
      }
    } else {
      renderOpenPaperTabs();
    }
    const readerElAfter = $('#view-reader');
    if (readerElAfter) readerElAfter.classList.remove('is-closing');

    if (removed?.pdfDoc) {
      setTimeout(() => {
        try { removed.pdfDoc.destroy(); } catch {}
      }, 60);
    }
  }

  async function openPaperInReader(pdfHash, targetPage = null, jumpBlockId = null) {
    const existing = state.openTabs.find((t) => t.pdfHash === pdfHash);
    if (existing) {
      await activatePaperTab(pdfHash, targetPage, jumpBlockId);
      return;
    }

    const res = await window.paperAPI.loadPaper(pdfHash);
    if (!res.ok) {
      showToast(res.error || '논문을 불러오지 못했습니다.', 'error');
      return;
    }

    const paper = res.paper;
    if (!paper.pdfBase64) {
      showToast('원본 PDF 파일이 없습니다.', 'error');
      return;
    }
    const bin = atob(paper.pdfBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }

    const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
    const pdfDoc = await loadingTask.promise;
    const totalPages = pdfDoc.numPages || paper.meta?.total_pages || 1;

    if (paper.meta && (paper.meta.total_pages !== totalPages || paper.meta.status === 'Unread')) {
      const updates = {};
      if (paper.meta.total_pages !== totalPages) updates.total_pages = totalPages;
      if (paper.meta.status === 'Unread') updates.status = 'Reading';
      const upd = await window.paperAPI.updateMeta({
        pdfHash,
        updates
      });
      if (upd.ok) {
        paper.meta = upd.meta;
        state.recent = upd.recent || state.recent;
      }
    }

    const startPage = Math.max(
      1,
      Math.min(totalPages, targetPage || paper.meta?.last_page || 1)
    );

    const newTab = createEmptyTabState();
    newTab.pdfHash = pdfHash;
    newTab.paper = paper;
    newTab.pdfDoc = pdfDoc;
    newTab.totalPages = totalPages;
    newTab.currentPage = startPage;
    newTab.pendingJumpBlockId = jumpBlockId;

    state.openTabs.push(newTab);
    state.reader = newTab;
    state.activeTabHash = pdfHash;

    if (window.paperAPI.getAgyStatus) {
      const agySt = await window.paperAPI.getAgyStatus(pdfHash);
      if (agySt?.status) state.agyJobs.set(pdfHash, agySt);
    }

    switchView('reader', { skipAutoFitRender: true, isNewTab: true });
    applyTabUiPreferences(newTab);
    updateReaderHeaderControls();
    applyPdfFilter();
    renderSummaryPane();
    renderSidebar();

    await renderCurrentPdfPage();
    renderTranslationPane();
    await goToPage(startPage);
  }

  function updateReaderHeaderControls() {
    const paper = state.reader.paper;
    if (!paper) return;
    const meta = paper.meta || {};
    const titleEl = $('#reader-paper-title');
    titleEl.textContent = meta.short_title || meta.title || 'Untitled';
    titleEl.title = meta.title || '';

    $('#input-current-page').value = state.reader.currentPage;
    $('#input-current-page').max = state.reader.totalPages;
    $('#span-total-pages').textContent = state.reader.totalPages;

    const isDone = meta.status === 'Done';
    const doneBtn = $('#btn-mark-done');
    doneBtn.classList.toggle('is-done', isDone);
    $('#mark-done-label').textContent = isDone ? 'Done' : 'Mark Done';

    const bookmarks = paper.annotations?.bookmarks || [];
    const isBookmarked = bookmarks.some((b) => Number(b.page) === state.reader.currentPage);
    $('#btn-bookmark-page').classList.toggle('bookmarked', isBookmarked);
  }

  function scrollPdfAndTransToPage(pageNum, opts = { smooth: true }) {
    const behavior = opts.smooth ? 'smooth' : 'auto';
    const wrap = document.querySelector(`#pdf-pages-stack .pdf-page-wrap[data-page="${pageNum}"]`);
    if (wrap) {
      wrap.scrollIntoView({ behavior, block: 'start' });
      renderSinglePdfPageWrap(wrap, pageNum);
    }
    const sec = document.querySelector(`#translation-blocks-container .trans-page-section[data-page="${pageNum}"]`);
    if (sec && state.reader.syncOn) {
      sec.scrollIntoView({ behavior, block: 'start' });
    }
  }

  async function goToPage(pageNum) {
    if (!state.reader.pdfDoc || !state.reader.paper) return;
    const clamped = Math.max(1, Math.min(state.reader.totalPages, Number(pageNum) || 1));
    state.reader.currentPage = clamped;
    state.reader.hoveredBlockId = null;

    if (state.reader.paper.meta) {
      state.reader.paper.meta.last_page = clamped;
      window.paperAPI.updateMeta({
        pdfHash: state.reader.pdfHash,
        updates: { last_page: clamped }
      }).then((res) => {
        if (res.ok) state.recent = res.recent;
      });
    }

    updateReaderHeaderControls();
    updateMiddleStatusControls();
    setTimeout(syncTocActiveHighlight, 120);

    const stack = $('#pdf-pages-stack');
    if (!stack || stack.children.length === 0) {
      await renderCurrentPdfPage();
      renderTranslationPane();
    }
    scrollPdfAndTransToPage(clamped, { smooth: true });

    if (state.reader.pendingJumpBlockId) {
      const bId = state.reader.pendingJumpBlockId;
      state.reader.pendingJumpBlockId = null;
      setHoveredBlock(bId, { scrollRight: true });
    }
  }

  let pdfPageObserver = null;

  async function renderSinglePdfPageWrap(wrap, pageNum) {
    const { pdfDoc, paper, pdfHash } = state.reader;
    if (!pdfDoc || !paper || !wrap) return;
    if (wrap.dataset.rendering === '1' || wrap.dataset.rendered === '1') return;
    if (wrap.dataset.hash !== pdfHash) return;

    wrap.dataset.rendering = '1';
    try {
      const page = await pdfDoc.getPage(pageNum);
      if (state.reader.pdfHash !== pdfHash || !wrap.isConnected) return;

      const scale = state.reader.scale || 1.0;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      wrap.style.setProperty('--scale-factor', String(scale));

      const canvas = wrap.querySelector('.pdf-canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;
      if (state.reader.pdfHash !== pdfHash || !wrap.isConnected) return;

      const textLayerEl = wrap.querySelector('.textLayer');
      textLayerEl.innerHTML = '';
      const textContent = await page.getTextContent();
      if (window.pdfjsLib.renderTextLayer) {
        const task = window.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayerEl,
          viewport,
          textDivs: []
        });
        if (task?.promise) await task.promise;
      }

      const pageKey = String(pageNum);
      if (!paper.blocks) paper.blocks = {};
      let extractedNow = false;
      if (!Array.isArray(paper.blocks[pageKey]) || paper.blocks[pageKey].length === 0) {
        const extracted = await window.PdfBlocks.extractPageBlocks(page, pageNum);
        paper.blocks[pageKey] = extracted;
        extractedNow = true;

        let detectedBodyEnd = null;
        if (window.PdfBlocks.detectReferencesHeading(extracted) && pageNum > 1) {
          detectedBodyEnd = pageNum - 1;
        }
        let detectedTitle = null;
        if (pageNum === 1 && extracted.length > 0 && extracted[0].text.length > 8) {
          detectedTitle = extracted[0].text.slice(0, 140);
        }

        window.paperAPI.saveBlocks({
          pdfHash,
          page: pageNum,
          blocks: extracted,
          totalPages: state.reader.totalPages,
          bodyEndPage: detectedBodyEnd,
          detectedTitle
        });
      }

      wrap.dataset.rendered = '1';
      renderPdfBlockOverlaysForPage(wrap, pageNum);
      renderPdfHighlightLayerForPage(wrap, pageNum);

      if (extractedNow) {
        refreshTranslationPageSection(pageNum);
      }
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Failed rendering PDF page ${pageNum}:`, err);
      }
    } finally {
      wrap.dataset.rendering = '0';
    }
  }

  async function renderCurrentPdfPage() {
    const { pdfDoc, paper, pdfHash, totalPages, currentPage } = state.reader;
    if (!pdfDoc || !paper) return;

    const gen = (state.reader.renderGeneration || 0) + 1;
    state.reader.renderGeneration = gen;

    if (pdfPageObserver) {
      pdfPageObserver.disconnect();
      pdfPageObserver = null;
    }

    const firstPage = await pdfDoc.getPage(1);
    if (state.reader.renderGeneration !== gen) return;
    const baseVp = firstPage.getViewport({ scale: 1.0 });

    const scrollContainer = $('#pdf-scroll-container');
    const availW = Math.max(220, scrollContainer.clientWidth - 42);
    let scale = state.reader.scale;
    if (state.reader.zoomMode === 'fit') {
      scale = availW / baseVp.width;
      state.reader.scale = scale;
      $('#zoom-label').textContent = 'Fit';
    } else {
      $('#zoom-label').textContent = `${Math.round(scale * 100)}%`;
    }

    const estW = Math.floor(baseVp.width * scale);
    const estH = Math.floor(baseVp.height * scale);

    const stack = $('#pdf-pages-stack');
    stack.innerHTML = '';
    for (let p = 1; p <= totalPages; p++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = String(p);
      wrap.dataset.hash = pdfHash;
      wrap.dataset.rendered = '0';
      wrap.style.width = `${estW}px`;
      wrap.style.height = `${estH}px`;
      wrap.innerHTML =
        `<canvas class="pdf-canvas"></canvas>` +
        `<div class="pdf-highlights-layer"></div>` +
        `<div class="pdf-blocks-layer"></div>` +
        `<div class="textLayer"></div>`;
      stack.appendChild(wrap);
    }

    pdfPageObserver = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting) {
            const p = Number(ent.target.dataset.page);
            renderSinglePdfPageWrap(ent.target, p);
          }
        }
      },
      { root: scrollContainer, rootMargin: '600px 0px' }
    );

    stack.querySelectorAll('.pdf-page-wrap').forEach((wrap) => {
      pdfPageObserver.observe(wrap);
    });

    // Prioritize rendering current page & adjacent page immediately
    const curWrap = stack.querySelector(`.pdf-page-wrap[data-page="${currentPage}"]`);
    if (curWrap) await renderSinglePdfPageWrap(curWrap, currentPage);
    if (currentPage + 1 <= totalPages) {
      const nextWrap = stack.querySelector(`.pdf-page-wrap[data-page="${currentPage + 1}"]`);
      if (nextWrap) renderSinglePdfPageWrap(nextWrap, currentPage + 1);
    }
  }

  function renderPdfBlockOverlaysForPage(wrap, pageNum) {
    const layer = wrap?.querySelector('.pdf-blocks-layer');
    if (!layer) return;
    const blocks = state.reader.paper?.blocks?.[String(pageNum)] || [];
    layer.innerHTML = blocks
      .map((blk) => {
        const [x, y, w, h] = blk.bbox || [0, 0, 0, 0];
        const isEq = blk.type === 'equation';
        const isHovered = state.reader.hoveredBlockId === blk.block_id;
        return `<div class="pdf-block-overlay ${isEq ? 'eq-block' : ''} ${isHovered ? 'hovered' : ''}" data-block-id="${escapeHtml(blk.block_id)}" style="left:${(x * 100).toFixed(3)}%;top:${(y * 100).toFixed(3)}%;width:${(w * 100).toFixed(3)}%;height:${(h * 100).toFixed(3)}%;"></div>`;
      })
      .join('');
  }

  function renderPdfBlockOverlays() {
    $$('#pdf-pages-stack .pdf-page-wrap[data-rendered="1"]').forEach((wrap) => {
      renderPdfBlockOverlaysForPage(wrap, Number(wrap.dataset.page));
    });
  }

  function renderPdfHighlightLayerForPage(wrap, pageNum) {
    const layer = wrap?.querySelector('.pdf-highlights-layer');
    if (!layer) return;
    const highlights = (state.reader.paper?.annotations?.highlights || []).filter(
      (h) => Number(h.page) === pageNum && h.target === 'original'
    );
    const html = [];
    for (const h of highlights) {
      const color = h.color || 'amber';
      for (const r of h.rects || []) {
        const [x, y, w, rh] = r;
        html.push(
          `<div class="pdf-highlight-rect hl-${escapeHtml(color)}" title="${escapeHtml(h.note || h.text)}" style="left:${(x * 100).toFixed(3)}%;top:${(y * 100).toFixed(3)}%;width:${(w * 100).toFixed(3)}%;height:${(rh * 100).toFixed(3)}%;"></div>`
        );
      }
    }
    layer.innerHTML = html.join('');
  }

  function renderPdfHighlightLayer() {
    $$('#pdf-pages-stack .pdf-page-wrap[data-rendered="1"]').forEach((wrap) => {
      renderPdfHighlightLayerForPage(wrap, Number(wrap.dataset.page));
    });
  }

  let suppressScrollSyncUntil = 0;

  function centerElInContainer(el, container) {
    if (!el || !container) return;
    const eRect = el.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const targetTop =
      container.scrollTop + (eRect.top - cRect.top) - container.clientHeight / 2 + eRect.height / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }

  function setHoveredBlock(blockId, opts = {}) {
    if (state.reader.hoveredBlockId === blockId && !opts.force) return;
    state.reader.hoveredBlockId = blockId || null;

    if (opts.scrollLeft || opts.scrollRight) {
      suppressScrollSyncUntil = Date.now() + 900;
    }

    const leftContainer = $('#pdf-scroll-container');
    const rightContainer = $('#translation-pane');

    $$('#pdf-pages-stack .pdf-block-overlay').forEach((el) => {
      const match = el.dataset.blockId === blockId;
      el.classList.toggle('hovered', match);
      if (match && opts.scrollLeft) {
        centerElInContainer(el, leftContainer);
      }
    });
    $$('#translation-blocks-container .trans-block').forEach((el) => {
      const match = el.dataset.blockId === blockId;
      el.classList.toggle('hovered', match);
      if (match && opts.scrollRight) {
        centerElInContainer(el, rightContainer);
      }
    });
  }

  function applyTranslatedHighlights(contentEl, transHls) {
    for (const hl of transHls) {
      const cls = `inline-hl-${hl.color || 'amber'}`;
      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('.katex-mathml')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const textNodes = [];
      let totalLen = 0;
      let cur;
      while ((cur = walker.nextNode())) {
        const len = cur.nodeValue.length;
        textNodes.push({ node: cur, start: totalLen, end: totalLen + len });
        totalLen += len;
      }

      let targetStart = typeof hl.startOffset === 'number' ? hl.startOffset : -1;
      let targetEnd = typeof hl.endOffset === 'number' ? hl.endOffset : -1;

      if (targetStart < 0 || targetEnd <= targetStart || targetEnd > totalLen) {
        const fullStr = textNodes.map((n) => n.node.nodeValue).join('');
        const idx = hl.text ? fullStr.indexOf(hl.text) : -1;
        if (idx === -1) continue;
        targetStart = idx;
        targetEnd = idx + hl.text.length;
      }

      for (let i = textNodes.length - 1; i >= 0; i--) {
        const entry = textNodes[i];
        if (entry.end <= targetStart || entry.start >= targetEnd) continue;
        const localStart = Math.max(0, targetStart - entry.start);
        const localEnd = Math.min(entry.node.nodeValue.length, targetEnd - entry.start);
        if (localEnd <= localStart) continue;

        const r = document.createRange();
        r.setStart(entry.node, localStart);
        r.setEnd(entry.node, localEnd);
        const mark = document.createElement('mark');
        mark.className = cls;
        if (hl.note) mark.title = hl.note;
        try {
          r.surroundContents(mark);
        } catch {}
      }
    }
  }

  function updateMiddleStatusControls() {
    const badge = $('#translation-status-badge');
    const paper = state.reader?.paper;
    if (!badge || !paper) return;

    const hash = state.reader.pdfHash;
    const job = state.agyJobs.get(hash);
    const isRunning = job?.status === 'running';
    const isSummaryMode = state.reader.middleMode === 'summary';
    const totalPages = state.reader.totalPages || paper.meta?.total_pages || 1;
    const translatedPagesCount = Object.keys(paper.translations || {}).length;
    const pageKey = String(state.reader.currentPage);
    const curPageTranslated = Array.isArray(paper.translations?.[pageKey]) && paper.translations[pageKey].length > 0;
    const hasSummary = Boolean(paper.summaryMd && paper.summaryMd.trim());

    badge.classList.remove('loading', 'ready', 'clickable');

    if (isRunning) {
      badge.classList.add('loading');
      badge.textContent =
        job.mode === 'summary'
          ? 'Antigravity 요약 생성 중...'
          : `Antigravity 처리 중... (${translatedPagesCount}/${totalPages}p)`;
      badge.title = 'Antigravity에서 결과를 생성하고 있습니다';
      return;
    }

    if (isSummaryMode) {
      if (hasSummary) {
        badge.classList.add('ready');
        badge.textContent = 'review-paper 요약 ✓';
        badge.title = '요약본이 준비되었습니다';
      } else {
        badge.classList.add('clickable');
        badge.textContent = '요약 대기 · Antigravity에서 생성';
        badge.title = '클릭하여 /PostPaper 프롬프트 복사 후 Antigravity 열기';
      }
      return;
    }

    if (curPageTranslated) {
      badge.classList.add('ready');
      badge.textContent = `번역 캐시 ✓ (${translatedPagesCount}/${totalPages}p)`;
      badge.title = '번역본이 로드되었습니다';
    } else {
      badge.classList.add('clickable');
      badge.textContent =
        translatedPagesCount > 0
          ? `번역 대기 (${translatedPagesCount}/${totalPages}p)`
          : '번역 대기 · Antigravity에서 생성';
      badge.title = '클릭하여 /PostPaper 프롬프트 복사 후 Antigravity 열기';
    }
  }

  async function triggerAgyForActiveTab(explicitMode = 'full') {
    const hash = state.reader?.pdfHash;
    if (!hash) return;
    const mode = explicitMode || 'full';
    const res = await window.paperAPI.runAgyForPaper(hash, mode);
    if (!res.ok) {
      showToast(res.error || 'Antigravity 실행 실패', 'error');
      return;
    }
    showToast('요약·번역 프롬프트를 복사하고 Antigravity를 열었습니다. 채팅창에 Ctrl+V 해주세요!', 'success');
  }

  function buildTranslationPageSectionHtml(pageNum) {
    const paper = state.reader.paper;
    const pageKey = String(pageNum);
    const blocks = paper.blocks?.[pageKey] || [];
    const translated = paper.translations?.[pageKey];
    const highlights = (paper.annotations?.highlights || []).filter(
      (h) => Number(h.page) === pageNum
    );
    const comments = (paper.annotations?.comments || []).filter(
      (c) => Number(c.page) === pageNum
    );

    const listToRender =
      Array.isArray(translated) && translated.length > 0
        ? translated
        : blocks.map((b) => ({
            block_id: b.block_id,
            type: b.type,
            translated_md: b.text,
            isFallbackOriginal: true
          }));

    const blocksHtml =
      listToRender.length === 0
        ? `<div class="sidebar-card" style="text-align:center;padding:18px;color:var(--text-muted);font-size:12px;">p.${pageNum} 스크롤 시 원문 블록을 불러옵니다...</div>`
        : listToRender
            .map((blk) => {
              const blockHls = highlights.filter((h) => h.block_id === blk.block_id);
              const origHl = blockHls.find((h) => h.target === 'original');
              const blockCms = comments.filter((c) => c.block_id === blk.block_id);
              const hlCls = origHl ? `has-hl-${origHl.color || 'amber'}` : '';
              const hoveredCls = state.reader.hoveredBlockId === blk.block_id ? 'hovered' : '';
              const bodyHtml = renderMarkdownWithKatex(blk.translated_md || blk.translated_text || '', blk.block_id);

              return `
                <div class="trans-block ${hlCls} ${hoveredCls}" data-block-id="${escapeHtml(blk.block_id)}" data-page="${pageNum}">
                  <div class="trans-block-actions ${blockCms.length > 0 ? 'has-comments' : ''}">
                    ${blockCms.length > 0 ? `<button class="block-action-pill has-count" data-action="view-comments" title="이 문단의 질문 보기"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>${blockCms.length}</span></button>` : ''}
                    <button class="block-action-pill" data-action="add-block-comment" title="이 문단에 질문/메모 달기">+ 질문</button>
                  </div>
                  <div class="trans-block-content">${bodyHtml}</div>
                </div>
              `;
            })
            .join('');

    return `<div class="trans-page-marker">Page ${pageNum}</div>${blocksHtml}`;
  }

  function bindTranslationSectionEvents(sectionEl, pageNum) {
    const paper = state.reader.paper;
    const pageKey = String(pageNum);
    const highlights = (paper.annotations?.highlights || []).filter(
      (h) => Number(h.page) === pageNum
    );
    sectionEl.querySelectorAll('.trans-block').forEach((el) => {
      const bId = el.dataset.blockId;
      const transHls = highlights.filter((h) => h.block_id === bId && h.target === 'translated');
      if (transHls.length > 0) {
        const contentEl = el.querySelector('.trans-block-content');
        if (contentEl) applyTranslatedHighlights(contentEl, transHls);
      }
      el.addEventListener('mouseenter', () => setHoveredBlock(el.dataset.blockId));
      el.addEventListener('mouseleave', () => setHoveredBlock(null));
      el.addEventListener('click', (e) => {
        const actBtn = e.target.closest('[data-action]');
        if (!actBtn) {
          const selText = window.getSelection()?.toString()?.trim();
          if (!selText && el.dataset.blockId) {
            setHoveredBlock(el.dataset.blockId, { force: true, scrollLeft: true });
          }
          return;
        }
        if (actBtn.dataset.action === 'view-comments') {
          state.reader.sidebarTab = 'notes';
          state.reader.sidebarCollapsed = false;
          $('#reader-sidebar').classList.remove('collapsed');
          $('#btn-toggle-sidebar').classList.add('active');
          renderSidebar();
        } else if (actBtn.dataset.action === 'add-block-comment') {
          const origBlk = (paper.blocks?.[pageKey] || []).find((b) => b.block_id === bId);
          const transBlk = (paper.translations?.[pageKey] || []).find((b) => b.block_id === bId);
          openNoteModal('comment', {
            page: pageNum,
            block_id: bId,
            original_excerpt: origBlk?.text || '',
            translated_excerpt: transBlk?.translated_md || transBlk?.translated_text || ''
          });
        }
      });
    });
  }

  function refreshTranslationPageSection(pageNum) {
    const sec = document.querySelector(`#translation-blocks-container .trans-page-section[data-page="${pageNum}"]`);
    if (!sec || !state.reader.paper) return;
    sec.innerHTML = buildTranslationPageSectionHtml(pageNum);
    bindTranslationSectionEvents(sec, pageNum);
  }

  function renderTranslationPane() {
    const container = $('#translation-blocks-container');
    const paper = state.reader.paper;
    if (!paper) return;

    updateMiddleStatusControls();

    const total = state.reader.totalPages || paper.meta?.total_pages || 1;
    const sections = [];
    for (let p = 1; p <= total; p++) {
      sections.push(`<section class="trans-page-section" data-page="${p}">${buildTranslationPageSectionHtml(p)}</section>`);
    }
    container.innerHTML = sections.join('');

    container.querySelectorAll('.trans-page-section').forEach((sec) => {
      bindTranslationSectionEvents(sec, Number(sec.dataset.page));
    });
  }

  function renderSummaryPane() {
    const container = $('#summary-content');
    const paper = state.reader.paper;
    if (!paper) return;

    if (paper.summaryMd && paper.summaryMd.trim()) {
      container.innerHTML = renderMarkdownWithKatex(paper.summaryMd, 'summary');
    } else {
      container.innerHTML = `
        <div class="sidebar-card" style="text-align:center;padding:36px 20px;">
          <h3 style="margin:0 0 8px;">아직 생성된 요약본이 없습니다</h3>
          <p style="margin:0;color:var(--text-secondary);font-size:13px;line-height:1.6;">
            Antigravity에서 <code>review-paper</code> 스킬 규격으로 <code>summary.md</code>를 생성해<br>
            로컬 캐시 폴더에 주입하거나 PDF를 업로드하면 즉시 표시됩니다.
          </p>
        </div>
      `;
    }
  }

  function extractPaperToc(paper) {
    const blocksByPage = paper?.blocks || {};
    const pageNums = Object.keys(blocksByPage)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const titleNorm = String(paper?.meta?.title || '').trim().toLowerCase();
    const items = [];
    for (const pNum of pageNums) {
      const list = blocksByPage[String(pNum)] || [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!b || b.type !== 'heading') continue;
        const raw = String(b.text || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length < 2 || raw.length > 140) continue;
        if (pNum === 1 && i === 0 && titleNorm && raw.toLowerCase() === titleNorm) continue;
        if (/^(figure|fig\.|table)\s*\d+/i.test(raw)) continue;
        if (/^[\d\W]+$/.test(raw)) continue;
        const isSub = /^(\d+\.\d+|[A-Z]\.\d+)\b/.test(raw);
        items.push({ page: pNum, block_id: b.block_id, title: raw, isSub });
      }
    }
    return items;
  }

  function syncTocActiveHighlight() {
    if (state.reader.sidebarTab !== 'contents') return;
    const listEl = $('#sidebar-list');
    if (!listEl) return;
    const tocBtns = Array.from(listEl.querySelectorAll('.toc-item'));
    if (tocBtns.length === 0) return;

    let activeBlockId = null;
    const pane = $('#translation-pane');
    if (pane) {
      const paneTop = pane.getBoundingClientRect().top;
      const threshold = paneTop + 110;
      const tocIds = new Set(tocBtns.map((b) => b.dataset.block).filter(Boolean));
      const blocks = pane.querySelectorAll('.trans-block[data-block-id]');
      for (const blk of blocks) {
        if (!tocIds.has(blk.dataset.blockId)) continue;
        if (blk.getBoundingClientRect().top <= threshold) {
          activeBlockId = blk.dataset.blockId;
        } else {
          break;
        }
      }
    }

    let activeBtn = activeBlockId
      ? tocBtns.find((b) => b.dataset.block === activeBlockId)
      : null;

    if (!activeBtn) {
      const curPage = Number(state.reader.currentPage) || 1;
      for (const b of tocBtns) {
        if (Number(b.dataset.page) <= curPage) activeBtn = b;
        else break;
      }
      if (!activeBtn) activeBtn = tocBtns[0];
    }

    for (const b of tocBtns) {
      b.classList.toggle('is-current', b === activeBtn);
    }
    const indicator = listEl.querySelector('.toc-active-indicator');
    if (indicator && activeBtn) {
      indicator.style.transform = `translateY(${activeBtn.offsetTop}px)`;
      indicator.style.height = `${activeBtn.offsetHeight}px`;
      indicator.style.opacity = '1';
    }
    if (activeBtn && !state.reader.sidebarCollapsed) {
      activeBtn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Sidebar (Contents | Bookmarks | Highlights | Notes)
  function renderSidebar() {
    const paper = state.reader.paper;
    if (!paper) return;
    const ann = paper.annotations || { bookmarks: [], highlights: [], comments: [] };
    const tocItems = extractPaperToc(paper);

    $('#count-contents').textContent = tocItems.length;
    $('#count-bookmarks').textContent = (ann.bookmarks || []).length;
    $('#count-highlights').textContent = (ann.highlights || []).length;
    $('#count-notes').textContent = (ann.comments || []).length;

    const tab = state.reader.sidebarTab;
    $$('.sidebar-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    const actionBar = $('#sidebar-action-bar');
    if (actionBar) actionBar.classList.toggle('hidden', tab === 'contents');

    const openComments = (ann.comments || []).filter((c) => !c.resolved);
    $('#btn-copy-all-open-prompts').classList.toggle('hidden', tab !== 'notes' || openComments.length === 0);

    const listEl = $('#sidebar-list');

    if (tab === 'contents') {
      if (tocItems.length === 0) {
        listEl.innerHTML = `<div class="sidebar-card" style="color:var(--text-secondary);text-align:center;">추출된 목차(섹션 제목)가 없습니다.</div>`;
        return;
      }
      listEl.innerHTML = `
        <div class="toc-list-wrap">
          <div class="toc-active-indicator" aria-hidden="true"></div>
          ${tocItems
            .map(
              (t) => `
              <button class="toc-item ${t.isSub ? 'sub' : ''}" data-action="jump" data-page="${t.page}" data-block="${escapeHtml(t.block_id)}" title="${escapeHtml(t.title)}">
                <span class="toc-item-title">${escapeHtml(t.title)}</span>
              </button>`
            )
            .join('')}
        </div>`;
      requestAnimationFrame(syncTocActiveHighlight);
    } else if (tab === 'bookmarks') {
      const bms = (ann.bookmarks || []).slice().sort((a, b) => a.page - b.page);
      if (bms.length === 0) {
        listEl.innerHTML = `
          <div class="bm-empty-state">
            <div class="bm-empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div class="bm-empty-title">저장된 북마크가 없습니다</div>
            <div class="bm-empty-sub">상단 북마크 아이콘 또는 <code>Ctrl+D</code>로 추가하세요</div>
          </div>`;
        return;
      }
      const curPage = Number(state.reader.currentPage);
      listEl.innerHTML = bms
        .map((b) => {
          const isCur = Number(b.page) === curPage;
          const label = b.label || `Page ${b.page}`;
          return `
          <div class="bm-card ${isCur ? 'is-current' : ''}" data-action="jump" data-page="${b.page}" title="p.${b.page}로 이동">
            <div class="bm-ribbon-badge" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div class="bm-card-body">
              <div class="bm-card-top">
                <span class="bm-page-pill">p.${b.page}</span>
                ${isCur ? '<span class="bm-cur-dot" title="현재 페이지">현재</span>' : ''}
              </div>
              <div class="bm-card-label">${escapeHtml(label)}</div>
            </div>
            <button class="icon-btn-sm bm-del-btn" data-action="del-bm" data-id="${escapeHtml(b.id)}" title="북마크 삭제" aria-label="북마크 삭제">✕</button>
          </div>`;
        })
        .join('');
    } else if (tab === 'highlights') {
      const hls = (ann.highlights || []).slice().sort((a, b) => a.page - b.page);
      if (hls.length === 0) {
        listEl.innerHTML = `<div class="sidebar-card" style="color:var(--text-secondary);text-align:center;">형광펜 기록이 없습니다.<br>원문 또는 번역본 텍스트를 드래그하세요.</div>`;
        return;
      }
      listEl.innerHTML = hls
        .map(
          (h) => `
          <div class="sidebar-card" style="border-left: 3px solid var(--${h.color || 'amber'});">
            <div class="sidebar-card-head">
              <button class="page-badge" data-action="jump" data-page="${h.page}" data-block="${escapeHtml(h.block_id || '')}">p.${h.page} · ${h.target === 'translated' ? '번역' : '원문'}</button>
              <button class="icon-btn-sm" data-action="del-hl" data-id="${escapeHtml(h.id)}" title="삭제">✕</button>
            </div>
            <div class="sidebar-card-text">"${escapeHtml(h.text)}"</div>
            ${h.note ? `<div class="sidebar-card-note">${escapeHtml(h.note)}</div>` : ''}
          </div>`
        )
        .join('');
    } else {
      const cms = (ann.comments || []).slice().sort((a, b) => a.page - b.page);
      if (cms.length === 0) {
        listEl.innerHTML = `<div class="sidebar-card" style="color:var(--text-secondary);text-align:center;">저장된 질문·댓글이 없습니다.<br>텍스트 드래그 후 '댓글/질문'을 눌러보세요.</div>`;
        return;
      }
      listEl.innerHTML = cms
        .map(
          (c) => `
          <div class="sidebar-card" style="${c.resolved ? 'opacity:0.62;' : ''}">
            <div class="sidebar-card-head">
              <button class="page-badge" data-action="jump" data-page="${c.page}" data-block="${escapeHtml(c.block_id || '')}">p.${c.page}</button>
              <div style="display:flex;align-items:center;gap:6px;">
                <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;">
                  <input type="checkbox" data-action="toggle-resolve" data-id="${escapeHtml(c.id)}" ${c.resolved ? 'checked' : ''} /> 해결됨
                </label>
                <button class="icon-btn-sm" data-action="del-cm" data-id="${escapeHtml(c.id)}" title="삭제">✕</button>
              </div>
            </div>
            <div class="sidebar-card-text">${escapeHtml(c.question)}</div>
            ${c.original_excerpt ? `<div class="sidebar-card-note">"${escapeHtml(c.original_excerpt.slice(0, 110))}${c.original_excerpt.length > 110 ? '...' : ''}"</div>` : ''}
            <button class="btn-copy-prompt" data-action="copy-prompt" data-id="${escapeHtml(c.id)}">Copy AI Prompt</button>
          </div>`
        )
        .join('');
    }

    listEl.querySelectorAll('[data-action]').forEach((el) => {
      const act = el.dataset.action;
      if (act === 'toggle-resolve') {
        el.addEventListener('change', () => {
          const cm = (paper.annotations.comments || []).find((c) => c.id === el.dataset.id);
          if (cm) {
            cm.resolved = el.checked;
            persistAnnotations();
          }
        });
        return;
      }
      el.addEventListener('click', () => {
        if (act === 'jump') {
          const p = Number(el.dataset.page) || 1;
          state.reader.pendingJumpBlockId = el.dataset.block || null;
          if (state.reader.viewTab !== 'split') {
            $('.subtab-btn[data-subtab="split"]')?.click();
          }
          goToPage(p);
        } else if (act === 'del-bm') {
          e.stopPropagation();
          paper.annotations.bookmarks = (paper.annotations.bookmarks || []).filter((b) => b.id !== el.dataset.id);
          persistAnnotations();
        } else if (act === 'del-hl') {
          paper.annotations.highlights = (paper.annotations.highlights || []).filter((h) => h.id !== el.dataset.id);
          persistAnnotations();
        } else if (act === 'del-cm') {
          paper.annotations.comments = (paper.annotations.comments || []).filter((c) => c.id !== el.dataset.id);
          persistAnnotations();
        } else if (act === 'copy-prompt') {
          const cm = (paper.annotations.comments || []).find((c) => c.id === el.dataset.id);
          if (cm) {
            const prompt = formatAiPrompt({
              title: paper.meta?.title,
              page: cm.page,
              originalExcerpt: cm.original_excerpt,
              translatedExcerpt: cm.translated_excerpt,
              question: cm.question
            });
            copyToClipboard(prompt, el, 'Copy AI Prompt');
          }
        }
      });
    });
  }

  async function persistAnnotations() {
    if (!state.reader.pdfHash || !state.reader.paper) return;
    const res = await window.paperAPI.saveAnnotations({
      pdfHash: state.reader.pdfHash,
      annotations: state.reader.paper.annotations
    });
    if (res.ok) {
      state.reader.paper.annotations = res.annotations;
      state.recent = res.recent || state.recent;
      updateReaderHeaderControls();
      renderPdfHighlightLayer();
      renderTranslationPane();
      renderSidebar();
    }
  }

  async function toggleBookmarkCurrentPage() {
    const paper = state.reader.paper;
    if (!paper) return;
    if (!paper.annotations) paper.annotations = { highlights: [], bookmarks: [], comments: [] };
    const p = state.reader.currentPage;
    const existingIdx = paper.annotations.bookmarks.findIndex((b) => Number(b.page) === p);
    const bmBtn = $('#btn-bookmark-page');
    if (existingIdx >= 0) {
      paper.annotations.bookmarks.splice(existingIdx, 1);
      if (bmBtn) {
        bmBtn.classList.remove('bm-pop', 'bm-unpop');
        void bmBtn.offsetWidth;
        bmBtn.classList.add('bm-unpop');
        setTimeout(() => bmBtn.classList.remove('bm-unpop'), 280);
      }
      showToast(`p.${p} 북마크가 해제되었습니다.`);
    } else {
      const firstHeading = (paper.blocks?.[String(p)] || []).find((b) => b.type === 'heading');
      paper.annotations.bookmarks.push({
        id: `bm-${Date.now()}`,
        page: p,
        label: firstHeading ? firstHeading.text.slice(0, 48) : `Page ${p}`,
        created_at: Date.now()
      });
      if (bmBtn) {
        bmBtn.classList.remove('bm-pop', 'bm-unpop');
        void bmBtn.offsetWidth;
        bmBtn.classList.add('bm-pop');
        setTimeout(() => bmBtn.classList.remove('bm-pop'), 480);
      }
      showToast(`p.${p} 북마크가 추가되었습니다.`, 'success');
    }
    await persistAnnotations();
  }

  // Floating Toolbars (Selection Highlighting + Math Context Menu)
  function hideFloatingOverlays() {
    $('#selection-toolbar').classList.add('hidden');
    $('#math-context-menu').classList.add('hidden');
  }

  function findBlockIdForNormalizedPoint(xNorm, yNorm, pageNum = state.reader.currentPage) {
    const blocks = state.reader.paper?.blocks?.[String(pageNum)] || [];
    for (const blk of blocks) {
      const [bx, by, bw, bh] = blk.bbox || [0, 0, 0, 0];
      if (xNorm >= bx && xNorm <= bx + bw && yNorm >= by && yNorm <= by + bh) {
        return blk;
      }
    }
    let nearest = null;
    let bestDist = 0.025;
    for (const blk of blocks) {
      const [bx, by, bw, bh] = blk.bbox || [0, 0, 0, 0];
      const dx = Math.max(0, bx - xNorm, xNorm - (bx + bw));
      const dy = Math.max(0, by - yNorm, yNorm - (by + bh));
      const d = Math.hypot(dx, dy);
      if (d <= bestDist) {
        bestDist = d;
        nearest = blk;
      }
    }
    return nearest;
  }

  function handleSelectionMouseUp(e) {
    if (e.target.closest('#selection-toolbar') || e.target.closest('#math-context-menu')) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text || sel.rangeCount === 0) {
      $('#selection-toolbar').classList.add('hidden');
      return;
    }

    const range = sel.getRangeAt(0);
    const pdfStack = $('#pdf-pages-stack');
    const transContainer = $('#translation-blocks-container');

    let target = null;
    let blockId = '';
    let rects = [];
    let startOffset = null;
    let endOffset = null;
    let selPage = state.reader.currentPage;

    const anchorEl =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

    if (pdfStack && pdfStack.contains(range.commonAncestorContainer)) {
      target = 'original';
      const pageWrap = anchorEl?.closest('.pdf-page-wrap');
      if (!pageWrap) return;
      selPage = Number(pageWrap.dataset.page) || state.reader.currentPage;
      const wrapRect = pageWrap.getBoundingClientRect();
      const clientRects = Array.from(range.getClientRects());
      for (const r of clientRects) {
        if (r.width < 2 || r.height < 2) continue;
        rects.push([
          Number(((r.left - wrapRect.left) / wrapRect.width).toFixed(4)),
          Number(((r.top - wrapRect.top) / wrapRect.height).toFixed(4)),
          Number((r.width / wrapRect.width).toFixed(4)),
          Number((r.height / wrapRect.height).toFixed(4))
        ]);
      }
      if (rects.length > 0) {
        const hit = findBlockIdForNormalizedPoint(rects[0][0] + 0.01, rects[0][1] + 0.005, selPage);
        blockId = hit?.block_id || '';
      }
    } else if (transContainer && transContainer.contains(range.commonAncestorContainer)) {
      target = 'translated';
      const transBlk = anchorEl?.closest('.trans-block');
      blockId = transBlk?.dataset.blockId || '';
      selPage = Number(transBlk?.dataset.page || anchorEl?.closest('.trans-page-section')?.dataset.page) || state.reader.currentPage;
      if (transBlk) {
        const contentEl = transBlk.querySelector('.trans-block-content') || transBlk;
        try {
          const preRange = document.createRange();
          preRange.selectNodeContents(contentEl);
          preRange.setEnd(range.startContainer, range.startOffset);
          startOffset = preRange.toString().length;
          endOffset = startOffset + text.length;
        } catch {}
      }
    } else {
      $('#selection-toolbar').classList.add('hidden');
      return;
    }

    const box = range.getBoundingClientRect();
    state.reader.pendingSelection = {
      target,
      block_id: blockId,
      text,
      rects,
      startOffset,
      endOffset,
      page: selPage
    };

    const toolbar = $('#selection-toolbar');
    toolbar.classList.remove('hidden');
    const left = Math.max(12, Math.min(window.innerWidth - 230, box.left + box.width / 2 - 105));
    const top = Math.max(60, box.top - 42);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function savePendingHighlight(color, note = '') {
    const sel = state.reader.pendingSelection;
    const paper = state.reader.paper;
    if (!sel || !paper) return;
    if (!paper.annotations) paper.annotations = { highlights: [], bookmarks: [], comments: [] };

    const newHl = {
      id: `hl-${Date.now()}`,
      pdf_hash: state.reader.pdfHash,
      page: sel.page,
      block_id: sel.block_id,
      target: sel.target,
      text: sel.text,
      color: color || 'amber',
      note,
      created_at: Date.now()
    };
    if (sel.target === 'original') {
      newHl.rects = sel.rects || [];
    } else {
      if (typeof sel.startOffset === 'number') newHl.startOffset = sel.startOffset;
      if (typeof sel.endOffset === 'number') newHl.endOffset = sel.endOffset;
    }
    paper.annotations.highlights.push(newHl);

    window.getSelection()?.removeAllRanges();
    $('#selection-toolbar').classList.add('hidden');
    persistAnnotations();
    showToast('형광펜이 저장되었습니다.', 'success');
  }

  // Modals
  function openModal(id) {
    $(`#${id}`).classList.remove('hidden');
  }
  function closeModal(id) {
    $(`#${id}`).classList.add('hidden');
  }

  function openNoteModal(mode, context = {}) {
    state.reader.noteModalMode = mode;
    state.reader.noteModalContext = context;
    $('#note-modal-title').textContent = mode === 'highlight-note' ? '형광펜 메모 추가' : '질문 / 댓글 작성';

    const excerptEl = $('#note-modal-excerpt');
    const excerptText = context.original_excerpt || context.text || '';
    if (excerptText) {
      excerptEl.textContent = excerptText.slice(0, 260);
      excerptEl.classList.remove('hidden');
    } else {
      excerptEl.classList.add('hidden');
    }

    $('#note-modal-color-row').classList.toggle('hidden', mode !== 'highlight-note');
    $('#note-modal-textarea').value = '';
    openModal('note-modal');
    setTimeout(() => $('#note-modal-textarea').focus(), 40);
  }

  function openDeleteConfirmModal(pdfHash) {
    const item = (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!item) return;
    state.reader.deletingHash = pdfHash;
    $('#delete-confirm-msg').textContent = `"${item.title}" 논문을 정말 삭제할까요?`;
    openModal('delete-confirm-modal');
  }

  function openMetaModal(pdfHash) {
    const item = (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!item) return;
    state.reader.editingMetaHash = pdfHash;
    $('#meta-input-title').value = item.title || '';
    $('#meta-input-tags').value = (item.tags || []).join(', ');
    $('#meta-input-summary').value = item.one_line_summary || '';
    $('#meta-input-review').value = item.review || '';
    openModal('meta-modal');
  }

  function classifyAttachmentUrl(urlStr) {
    const u = String(urlStr || '').trim();
    if (/notion\.so|notion\.site|^notion:\/\//i.test(u)) return 'notion';
    if (/^https?:\/\//i.test(u)) return 'web';
    return 'file';
  }

  async function addPaperAttachment(pdfHash, att) {
    const item = (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!item || !att?.target) return;
    const current = Array.isArray(item.attachments) ? item.attachments.slice() : [];
    const entry = {
      id: `att-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: att.type || classifyAttachmentUrl(att.target),
      title: String(att.title || att.target).trim(),
      target: String(att.target).trim(),
      created_at: Date.now()
    };
    current.push(entry);
    const res = await window.paperAPI.updateMeta({
      pdfHash,
      updates: { attachments: current }
    });
    if (res.ok) {
      state.recent = res.recent;
      if (state.view === 'library') refreshLibrarySearch();
      if (state.reader.editingAttHash === pdfHash) renderAttachmentsModalList();
      showToast(`자료가 연결되었습니다: ${entry.title}`, 'success');
    }
  }

  async function removePaperAttachment(pdfHash, attId) {
    const item = (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!item) return;
    const next = (item.attachments || []).filter((a) => a.id !== attId);
    const res = await window.paperAPI.updateMeta({
      pdfHash,
      updates: { attachments: next }
    });
    if (res.ok) {
      state.recent = res.recent;
      if (state.view === 'library') refreshLibrarySearch();
      if (state.reader.editingAttHash === pdfHash) renderAttachmentsModalList();
    }
  }

  async function handleAttachmentDrop(pdfHash, dt) {
    if (!dt || !pdfHash) return;

    // 1. OS / Explorer files
    if (dt.files && dt.files.length > 0) {
      for (const f of Array.from(dt.files)) {
        const fp = window.paperAPI.getFilePath(f);
        if (fp) {
          await addPaperAttachment(pdfHash, {
            type: 'file',
            title: f.name || fp.split(/[\\/]/).pop(),
            target: fp
          });
        }
      }
      return;
    }

    // 2. Archive-Hub item ID or URL / file path text
    const uri = (dt.getData('text/uri-list') || '').trim();
    const txt = (dt.getData('text/plain') || '').trim();
    const candidate = uri || txt;
    if (!candidate) return;

    if (!/^(https?:|notion:|file:|[a-zA-Z]:\\|\\\\)/i.test(candidate)) {
      const resolved = await window.paperAPI.resolveArchiveHubItem(candidate);
      if (resolved?.ok && resolved.item) {
        await addPaperAttachment(pdfHash, resolved.item);
        return;
      }
    }

    let cleanTarget = candidate.split(/\r?\n/)[0].trim();
    if (/^file:\/\/\//i.test(cleanTarget)) {
      cleanTarget = decodeURIComponent(cleanTarget.replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
    }
    const type = classifyAttachmentUrl(cleanTarget);
    const defaultTitle = type === 'notion' ? 'Notion 페이지' : type === 'web' ? cleanTarget.replace(/^https?:\/\//i, '').slice(0, 36) : cleanTarget.split(/[\\/]/).pop();
    await addPaperAttachment(pdfHash, { type, title: defaultTitle, target: cleanTarget });
  }

  function renderAttachmentsModalList() {
    const hash = state.reader.editingAttHash;
    const item = (state.recent || []).find((p) => p.pdf_hash === hash);
    const listEl = $('#att-list');
    const atts = item?.attachments || [];
    if (atts.length === 0) {
      listEl.innerHTML = `<div class="form-note" style="text-align:center;padding:12px;">아직 연결된 노션 페이지, 링크 또는 파일이 없습니다.</div>`;
      return;
    }
    listEl.innerHTML = atts
      .map(
        (a) => `
        <div class="att-list-item">
          <button class="att-item-link" data-action="open" data-target="${escapeHtml(a.target)}" title="${escapeHtml(a.target)}">
            <span>${a.type === 'notion' ? '📝' : a.type === 'web' ? '🔗' : '📄'}</span>
            <span class="att-item-title">${escapeHtml(a.title)}</span>
          </button>
          <button class="icon-btn-sm" data-action="del" data-id="${escapeHtml(a.id)}" title="연결 해제">✕</button>
        </div>`
      )
      .join('');

    listEl.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'open') {
          window.paperAPI.openAttachment(btn.dataset.target);
        } else if (btn.dataset.action === 'del') {
          removePaperAttachment(hash, btn.dataset.id);
        }
      });
    });
  }

  function openAttachmentsModal(pdfHash) {
    const item = (state.recent || []).find((p) => p.pdf_hash === pdfHash);
    if (!item) return;
    state.reader.editingAttHash = pdfHash;
    $('#att-modal-title').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px;color:var(--accent)"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>${escapeHtml(item.short_title || item.title)}`;
    $('#att-input-title').value = '';
    $('#att-input-url').value = '';
    renderAttachmentsModalList();
    openModal('attachments-modal');
  }

  function openSettingsModal() {
    $('#settings-pdf-filter').value = state.config.pdfFilter || 'none';
    $('#settings-data-root').textContent = state.dataRoot || '%APPDATA%/PaperReader';
    openModal('settings-modal');
  }

  // Event Wiring
  function bindEvents() {
    // Top Home & Library tabs
    $('#tab-hub').addEventListener('click', () => switchView('home'));
    $('#tab-library').addEventListener('click', () => switchView('library'));
    $('#btn-go-home-from-reader').addEventListener('click', () => switchView('home'));

    // Global Window Drag & Drop anywhere to import PDF / .paperpkg
    let globalDragDepth = 0;
    const globalOverlay = $('#global-drop-overlay');
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      if (e.target.closest('.lib-card') || e.target.closest('#att-dropzone')) return;
      globalDragDepth += 1;
      globalOverlay.classList.remove('hidden');
    });
    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      if (e.target.closest('.lib-card') || e.target.closest('#att-dropzone')) {
        globalOverlay.classList.add('hidden');
        return;
      }
      e.preventDefault();
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      globalDragDepth = Math.max(0, globalDragDepth - 1);
      if (globalDragDepth === 0 || e.clientX <= 0 || e.clientY <= 0) {
        globalDragDepth = 0;
        globalOverlay.classList.add('hidden');
      }
    });
    document.addEventListener('drop', async (e) => {
      globalDragDepth = 0;
      globalOverlay.classList.add('hidden');
      if (e.target.closest('.lib-card') || e.target.closest('#att-dropzone') || e.target.closest('#home-dropzone')) return;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      const filePath = window.paperAPI.getFilePath(file);
      if (!filePath) return;
      const res = await window.paperAPI.importFile(filePath);
      if (res.ok && res.pdfHash) {
        state.recent = res.recent || state.recent;
        state.tags = res.tags || state.tags;
        showToast('논문을 불러왔습니다.', 'success');
        openPaperInReader(res.pdfHash);
      } else {
        showToast(res.error || '파일 불러오기 실패', 'error');
      }
    });
    $('#btn-snow-toggle').addEventListener('click', toggleSnowMode);
    $('#btn-theme-toggle').addEventListener('click', (e) => toggleTheme(e));

    // Home Knowledge Graph Orb & Controls
    $('#btn-knowledge-orb')?.addEventListener('click', () => {
      const sec = $('#home-knowledge-section');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#btn-kg-top')?.addEventListener('click', () => {
      const homeEl = $('#view-home');
      if (homeEl) homeEl.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#btn-kg-relayout')?.addEventListener('click', () => {
      renderKnowledgeGraph(true);
    });

    // Dynamic organic rotation + breathing scale on Home Knowledge Orb
    const orbBtn = $('#btn-knowledge-orb');
    const orbSvg = orbBtn?.querySelector('.knowledge-orb-svg');
    if (orbBtn && orbSvg) {
      let orbHovered = false;
      let angle = 0;
      let curVel = 0.45;
      let targetVel = 0.65;
      let curScale = 1.0;
      let targetScale = 1.06;
      let nextSwitchAt = performance.now() + 1400;
      let phase = 0;

      orbBtn.addEventListener('mouseenter', () => {
        orbHovered = true;
      });
      orbBtn.addEventListener('mouseleave', () => {
        orbHovered = false;
      });

      const tickOrb = (now) => {
        if (state.view === 'home') {
          if (now >= nextSwitchAt) {
            targetVel = 0.25 + Math.random() * 1.45;
            targetScale = 0.92 + Math.random() * 0.22;
            nextSwitchAt = now + 900 + Math.random() * 2100;
          }
          const mult = orbHovered ? 2.6 : 1.0;
          curVel += (targetVel * mult - curVel) * 0.035;
          phase += 0.045;
          const pulse = Math.sin(phase) * 0.045 + Math.sin(phase * 1.73) * 0.025;
          const desiredScale = (orbHovered ? 1.14 : targetScale) + pulse;
          curScale += (desiredScale - curScale) * 0.06;
          angle = (angle + curVel) % 36000;
          orbSvg.style.transform = `rotate(${angle.toFixed(2)}deg) scale(${curScale.toFixed(3)})`;
        }
        requestAnimationFrame(tickOrb);
      };
      requestAnimationFrame(tickOrb);
    }
    $('#btn-open-settings').addEventListener('click', openSettingsModal);
    $('#btn-win-min').addEventListener('click', () => window.paperAPI.minimizeWindow());
    $('#btn-win-max').addEventListener('click', () => window.paperAPI.toggleMaximizeWindow());
    $('#btn-win-close').addEventListener('click', () => window.paperAPI.closeWindow());

    // Home Dropzone & URL Import
    const dz = $('#home-dropzone');
    dz.addEventListener('click', async (e) => {
      if (e.target.closest('#url-import-bar')) return;
      const res = await window.paperAPI.openFileDialog();
      if (res.ok && !res.canceled && res.pdfHash) {
        state.recent = res.recent || state.recent;
        state.tags = res.tags || state.tags;
        openPaperInReader(res.pdfHash);
      } else if (!res.ok && res.error) {
        showToast(res.error, 'error');
      }
    });

    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag-over');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const filePath = window.paperAPI.getFilePath(file);
      if (!filePath) {
        showToast('파일 경로를 읽지 못했습니다.', 'error');
        return;
      }
      const res = await window.paperAPI.importFile(filePath);
      if (res.ok && res.pdfHash) {
        state.recent = res.recent || state.recent;
        state.tags = res.tags || state.tags;
        showToast('논문을 불러왔습니다.', 'success');
        openPaperInReader(res.pdfHash);
      } else {
        showToast(res.error || '파일 불러오기 실패', 'error');
      }
    });

    const triggerUrlImport = async () => {
      const url = $('#input-arxiv-url').value.trim();
      if (!url) return;
      const btn = $('#btn-import-url');
      btn.disabled = true;
      btn.textContent = '다운로드 중...';
      try {
        const res = await window.paperAPI.importUrl(url);
        if (res.ok && res.pdfHash) {
          state.recent = res.recent || state.recent;
          state.tags = res.tags || state.tags;
          $('#input-arxiv-url').value = '';
          showToast('논문 다운로드 완료', 'success');
          openPaperInReader(res.pdfHash);
        } else {
          showToast(res.error || 'URL 불러오기 실패', 'error');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = '불러오기';
      }
    };
    $('#btn-import-url').addEventListener('click', triggerUrlImport);
    $('#input-arxiv-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') triggerUrlImport();
    });

    // Library controls
    let searchTimer = null;
    $('#library-search-input').addEventListener('input', (e) => {
      state.library.query = e.target.value;
      $('#btn-clear-search').classList.toggle('hidden', !e.target.value);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshLibrarySearch, 180);
    });
    $('#btn-clear-search').addEventListener('click', () => {
      $('#library-search-input').value = '';
      state.library.query = '';
      $('#btn-clear-search').classList.add('hidden');
      refreshLibrarySearch();
    });
    $('#btn-library-notion')?.addEventListener('click', () => {
      window.paperAPI.openExternal('notion://www.notion.so/388a92946d8b80e2b0d9fc27be39567d');
    });
    $$('#library-status-filters .filter-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#library-status-filters .filter-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.library.statusFilter = btn.dataset.status;
        refreshLibrarySearch();
      });
    });
    const libViewToggleBtn = $('#library-view-toggle');
    if (libViewToggleBtn) {
      const syncLibToggle = () => {
        const isDetailed = state.library.viewMode !== 'compact';
        libViewToggleBtn.dataset.mode = isDetailed ? 'detailed' : 'compact';
        libViewToggleBtn.title = isDetailed ? '상세 보기 (클릭하여 간단히 보기로 전환)' : '간단히 보기 (클릭하여 상세 보기로 전환)';
      };
      syncLibToggle();
      libViewToggleBtn.addEventListener('click', () => {
        state.library.viewMode = state.library.viewMode === 'compact' ? 'detailed' : 'compact';
        syncLibToggle();
        renderLibraryList();
      });
    }
    const sortDropdown = $('#library-sort-dropdown');
    const sortBtn = $('#library-sort-btn');
    const sortMenu = $('#library-sort-menu');
    const sortLabel = $('#library-sort-label');
    if (sortDropdown && sortBtn && sortMenu) {
      const closeSortMenu = () => {
        sortMenu.classList.add('hidden');
        sortDropdown.classList.remove('open');
        sortBtn.setAttribute('aria-expanded', 'false');
      };
      sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !sortMenu.classList.contains('hidden');
        if (isOpen) closeSortMenu();
        else {
          sortMenu.classList.remove('hidden');
          sortDropdown.classList.add('open');
          sortBtn.setAttribute('aria-expanded', 'true');
        }
      });
      sortMenu.querySelectorAll('.sort-option').forEach((opt) => {
        opt.addEventListener('click', () => {
          const val = opt.dataset.sort;
          state.library.sortBy = val;
          sortMenu.querySelectorAll('.sort-option').forEach((o) => o.classList.toggle('active', o === opt));
          if (sortLabel) sortLabel.textContent = opt.textContent;
          closeSortMenu();
          refreshLibrarySearch();
        });
      });
      document.addEventListener('click', (e) => {
        if (!sortDropdown.contains(e.target)) closeSortMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSortMenu();
      });
    }

    // Reader toolbar controls
    $('#btn-prev-page').addEventListener('click', () => goToPage(state.reader.currentPage - 1));
    $('#btn-next-page').addEventListener('click', () => goToPage(state.reader.currentPage + 1));
    $('#input-current-page').addEventListener('change', (e) => goToPage(e.target.value));

    $('#btn-sync-toggle').addEventListener('click', () => {
      state.reader.syncOn = !state.reader.syncOn;
      const btn = $('#btn-sync-toggle');
      btn.classList.toggle('active', state.reader.syncOn);
      btn.querySelector('span:last-child').textContent = state.reader.syncOn ? 'Sync ON' : 'Sync OFF';
    });

    $('#btn-bookmark-page').addEventListener('click', toggleBookmarkCurrentPage);

    $('#btn-mark-done').addEventListener('click', async () => {
      if (!state.reader.pdfHash) return;
      const btn = $('#btn-mark-done');
      btn.classList.remove('bounce');
      void btn.offsetWidth;
      btn.classList.add('bounce');
      await togglePaperStatus(state.reader.pdfHash, 'reader-done');
    });

    $('#btn-export-md').addEventListener('click', async () => {
      if (!state.reader.pdfHash) return;
      const res = await window.paperAPI.exportMd({
        pdfHash: state.reader.pdfHash,
        defaultName: state.reader.paper?.meta?.short_title || 'paper_notes'
      });
      if (res.ok && !res.canceled) showToast('마크다운(.md) 노트를 내보냈습니다.', 'success');
      else if (!res.ok) showToast(res.error || '내보내기 실패', 'error');
    });

    $('#btn-toggle-pdf').addEventListener('click', () => {
      state.reader.pdfCollapsed = !state.reader.pdfCollapsed;
      $('#reader-left-panel').classList.toggle('collapsed', state.reader.pdfCollapsed);
      $('#btn-toggle-pdf').classList.toggle('active', !state.reader.pdfCollapsed);
      if (!state.reader.pdfCollapsed && state.reader.zoomMode === 'fit') {
        setTimeout(() => renderCurrentPdfPage(), 260);
      }
    });

    $('#btn-toggle-sidebar').addEventListener('click', () => {
      state.reader.sidebarCollapsed = !state.reader.sidebarCollapsed;
      $('#reader-sidebar').classList.toggle('collapsed', state.reader.sidebarCollapsed);
      $('#btn-toggle-sidebar').classList.toggle('active', !state.reader.sidebarCollapsed);
      if (!state.reader.sidebarCollapsed && state.reader.sidebarTab === 'contents') {
        setTimeout(syncTocActiveHighlight, 250);
      }
      if (state.reader.zoomMode === 'fit') {
        setTimeout(() => renderCurrentPdfPage(), 260);
      }
    });

    // Zoom & PDF eye-comfort filter
    $('#btn-zoom-in').addEventListener('click', () => {
      state.reader.zoomMode = 'manual';
      state.reader.scale = Math.min(2.6, (state.reader.scale || 1.0) + 0.15);
      renderCurrentPdfPage();
    });
    $('#btn-zoom-out').addEventListener('click', () => {
      state.reader.zoomMode = 'manual';
      state.reader.scale = Math.max(0.5, (state.reader.scale || 1.0) - 0.15);
      renderCurrentPdfPage();
    });
    $('#btn-zoom-fit').addEventListener('click', () => {
      state.reader.zoomMode = 'fit';
      renderCurrentPdfPage();
    });

    // Trackpad pinch & Ctrl+Wheel smooth zoom on PDF panel
    const pdfScrollEl = $('#pdf-scroll-container');
    if (pdfScrollEl) {
      let wheelZoomTimer = null;
      let wheelBaseScale = null;
      pdfScrollEl.addEventListener(
        'wheel',
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          if (state.view !== 'reader' || !state.reader?.paper) return;
          e.preventDefault();
          e.stopPropagation();

          const currentScale = state.reader.scale || 1.0;
          if (wheelBaseScale === null) wheelBaseScale = currentScale;

          const factor =
            Math.abs(e.deltaY) >= 40
              ? e.deltaY < 0
                ? 1.1
                : 1 / 1.1
              : Math.exp(-e.deltaY * 0.01);

          const nextScale = Math.min(3.0, Math.max(0.4, currentScale * factor));
          state.reader.zoomMode = 'manual';
          state.reader.scale = nextScale;

          const stack = $('#pdf-pages-stack');
          if (stack && wheelBaseScale > 0) {
            const ratio = nextScale / wheelBaseScale;
            stack.style.transformOrigin = 'top center';
            stack.style.transform = `scale(${ratio})`;
          }

          clearTimeout(wheelZoomTimer);
          wheelZoomTimer = setTimeout(() => {
            const scrollRatio =
              pdfScrollEl.scrollHeight > 0 ? pdfScrollEl.scrollTop / pdfScrollEl.scrollHeight : 0;
            if (stack) {
              stack.style.transform = '';
              stack.style.transformOrigin = '';
            }
            wheelBaseScale = null;
            renderCurrentPdfPage().then(() => {
              if (scrollRatio > 0) {
                pdfScrollEl.scrollTop = scrollRatio * pdfScrollEl.scrollHeight;
              }
            });
          }, 140);
        },
        { passive: false }
      );
    }
    $('#btn-pdf-filter').addEventListener('click', async () => {
      const order = ['none', 'dim', 'sepia', 'invert'];
      const curIdx = order.indexOf(state.config.pdfFilter || 'none');
      const next = order[(curIdx + 1) % order.length];
      state.config.pdfFilter = next;
      applyPdfFilter();
      await window.paperAPI.saveConfig({ pdfFilter: next });
    });

    // Middle Mode Toggle (Translation | Summary)
    $$('#middle-mode-toggle .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#middle-mode-toggle .seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.reader.middleMode = btn.dataset.mode;
        const isSum = btn.dataset.mode === 'summary';
        $('#translation-pane').classList.toggle('hidden', isSum);
        $('#summary-pane').classList.toggle('hidden', !isSum);
        updateMiddleStatusControls();
      });
    });

    // Sidebar tabs & actions
    $$('#sidebar-tabs .sidebar-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.reader.sidebarTab = btn.dataset.tab;
        renderSidebar();
      });
    });
    $('#btn-add-page-note').addEventListener('click', () => {
      openNoteModal('comment', {
        page: state.reader.currentPage,
        block_id: '',
        original_excerpt: '',
        translated_excerpt: ''
      });
    });
    $('#btn-copy-all-open-prompts').addEventListener('click', () => {
      const paper = state.reader.paper;
      const open = (paper?.annotations?.comments || []).filter((c) => !c.resolved);
      if (open.length === 0) return;
      const combined = open
        .map((c, idx) => `--- [질문 ${idx + 1}] ---\n` + formatAiPrompt({
          title: paper.meta?.title,
          page: c.page,
          originalExcerpt: c.original_excerpt,
          translatedExcerpt: c.translated_excerpt,
          question: c.question
        }))
        .join('\n\n');
      copyToClipboard(combined, $('#btn-copy-all-open-prompts'), '미해결 질문 전체 AI 복사');
    });

    // Left PDF bidirectional hover sync across all pages without blocking text selection
    const pdfStack = $('#pdf-pages-stack');
    pdfStack.addEventListener('mousemove', (e) => {
      const pdfWrap = e.target.closest('.pdf-page-wrap');
      if (!pdfWrap) {
        setHoveredBlock(null);
        return;
      }
      const rect = pdfWrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;
      const pNum = Number(pdfWrap.dataset.page) || state.reader.currentPage;
      const hit = findBlockIdForNormalizedPoint(xNorm, yNorm, pNum);
      setHoveredBlock(hit ? hit.block_id : null);
    });
    pdfStack.addEventListener('mouseleave', () => setHoveredBlock(null));
    pdfStack.addEventListener('click', (e) => {
      const selText = window.getSelection()?.toString()?.trim();
      if (selText) return;
      const pdfWrap = e.target.closest('.pdf-page-wrap');
      if (!pdfWrap) return;
      const rect = pdfWrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;
      const pNum = Number(pdfWrap.dataset.page) || state.reader.currentPage;
      const hit = findBlockIdForNormalizedPoint(xNorm, yNorm, pNum);
      if (hit) {
        setHoveredBlock(hit.block_id, { force: true, scrollRight: true });
      }
    });

    // Page-Anchor Scroll Sync + Scroll Spy for currentPage
    let syncingSource = null;
    let syncClearTimer = null;
    let spyTimer = null;
    const leftScroll = $('#pdf-scroll-container');
    const midScroll = $('#translation-pane');

    const getRelTop = (el, container) =>
      el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;

    const findAnchorInContainer = (container, selector) => {
      const items = [...container.querySelectorAll(selector)];
      if (items.length === 0) return null;
      const anchorY = container.scrollTop + 28;
      let target = items[0];
      for (const item of items) {
        const top = getRelTop(item, container);
        if (top <= anchorY) {
          target = item;
        } else {
          break;
        }
      }
      const top = getRelTop(target, container);
      const h = Math.max(1, target.offsetHeight);
      const frac = Math.max(0, Math.min(1, (anchorY - top) / h));
      return { page: Number(target.dataset.page) || 1, frac };
    };

    const syncScrollByPage = (direction) => {
      if (!state.reader.syncOn) return;
      if (Date.now() < suppressScrollSyncUntil) return;
      if (syncingSource && syncingSource !== direction) return;

      const isLeftToMid = direction === 'left';
      const src = isLeftToMid ? leftScroll : midScroll;
      const dst = isLeftToMid ? midScroll : leftScroll;
      const srcSel = isLeftToMid ? '.pdf-page-wrap[data-page]' : '.trans-page-section[data-page]';
      const dstSel = isLeftToMid ? '.trans-page-section' : '.pdf-page-wrap';

      const anchor = findAnchorInContainer(src, srcSel);
      if (!anchor) return;
      const dstEl = dst.querySelector(`${dstSel}[data-page="${anchor.page}"]`);
      if (!dstEl) return;

      syncingSource = direction;
      const dstTop = getRelTop(dstEl, dst);
      const dstH = Math.max(1, dstEl.offsetHeight);
      const targetScrollTop = Math.max(0, dstTop + anchor.frac * dstH - 28);
      dst.scrollTop = targetScrollTop;

      clearTimeout(syncClearTimer);
      syncClearTimer = setTimeout(() => {
        syncingSource = null;
      }, 60);
    };
    const updateCurrentPageFromScroll = () => {
      const wraps = $$('#pdf-pages-stack .pdf-page-wrap');
      if (wraps.length === 0) return;
      const containerRect = leftScroll.getBoundingClientRect();
      const midY = containerRect.top + containerRect.height * 0.35;
      let bestPage = state.reader.currentPage;
      let bestDist = Infinity;
      for (const w of wraps) {
        const r = w.getBoundingClientRect();
        const center = (r.top + r.bottom) / 2;
        const d = Math.abs(center - midY);
        if (d < bestDist) {
          bestDist = d;
          bestPage = Number(w.dataset.page) || bestPage;
        }
      }
      if (bestPage !== state.reader.currentPage) {
        state.reader.currentPage = bestPage;
        updateReaderHeaderControls();
        updateMiddleStatusControls();
        if (state.reader.paper?.meta) {
          state.reader.paper.meta.last_page = bestPage;
          window.paperAPI.updateMeta({
            pdfHash: state.reader.pdfHash,
            updates: { last_page: bestPage }
          });
        }
      }
      syncTocActiveHighlight();
    };
    leftScroll.addEventListener('scroll', () => {
      syncScrollByPage('left');
      clearTimeout(spyTimer);
      spyTimer = setTimeout(updateCurrentPageFromScroll, 120);
    });
    midScroll.addEventListener('scroll', () => {
      syncScrollByPage('mid');
      clearTimeout(spyTimer);
      spyTimer = setTimeout(updateCurrentPageFromScroll, 120);
    });

    // Split Resizer
    const resizer = $('#split-resizer');
    const leftPanel = $('#reader-left-panel');
    let resizing = false;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      resizer.classList.add('dragging');
      leftPanel.classList.add('resizing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const ws = $('#reader-workspace').getBoundingClientRect();
      const px = Math.max(260, Math.min(ws.width * 0.65, e.clientX - ws.left));
      leftPanel.style.width = `${px}px`;
    });
    window.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        resizer.classList.remove('dragging');
        leftPanel.classList.remove('resizing');
        if (state.reader.zoomMode === 'fit') {
          renderCurrentPdfPage();
        }
      }
    });

    // Selection Floating Toolbar
    document.addEventListener('mouseup', (e) => {
      setTimeout(() => handleSelectionMouseUp(e), 10);
    });

    $$('#selection-toolbar .hl-swatch').forEach((btn) => {
      btn.addEventListener('click', () => savePendingHighlight(btn.dataset.color));
    });
    $('#btn-sel-note').addEventListener('click', () => {
      if (!state.reader.pendingSelection) return;
      openNoteModal('highlight-note', state.reader.pendingSelection);
    });
    $('#btn-sel-question').addEventListener('click', () => {
      const sel = state.reader.pendingSelection;
      if (!sel) return;
      const pageKey = String(sel.page);
      const blocks = state.reader.paper?.blocks?.[pageKey] || [];
      const trans = state.reader.paper?.translations?.[pageKey] || [];
      const origBlk = blocks.find((b) => b.block_id === sel.block_id);
      const transBlk = trans.find((b) => b.block_id === sel.block_id);

      openNoteModal('comment', {
        page: sel.page,
        block_id: sel.block_id,
        original_excerpt: sel.target === 'original' ? sel.text : origBlk?.text || '',
        translated_excerpt: sel.target === 'translated' ? sel.text : transBlk?.translated_md || transBlk?.translated_text || ''
      });
    });

    // Math Right-Click Context Menu
    document.addEventListener('contextmenu', (e) => {
      const mathEl = e.target.closest('.katex-wrap');
      const pdfEqEl = e.target.closest('.pdf-block-overlay.eq-block');
      let latex = '';
      let blockId = '';

      if (mathEl) {
        latex = mathEl.dataset.latex || '';
        blockId = mathEl.dataset.blockId || '';
      } else if (pdfEqEl) {
        blockId = pdfEqEl.dataset.blockId || '';
        const blk = (state.reader.paper?.blocks?.[String(state.reader.currentPage)] || []).find(
          (b) => b.block_id === blockId
        );
        latex = (blk?.text || '').replace(/^\$\$|\$\$$/g, '').trim();
      } else {
        $('#math-context-menu').classList.add('hidden');
        return;
      }

      if (!latex) return;
      e.preventDefault();
      state.reader.pendingMathContext = { latex, blockId };

      const menu = $('#math-context-menu');
      menu.classList.remove('hidden');
      const left = Math.min(window.innerWidth - 200, e.clientX);
      const top = Math.min(window.innerHeight - 130, e.clientY);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#math-context-menu')) {
        $('#math-context-menu').classList.add('hidden');
      }
    });

    $$('#math-context-menu .ctx-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ctx = state.reader.pendingMathContext;
        $('#math-context-menu').classList.add('hidden');
        if (!ctx) return;
        const act = btn.dataset.action;
        if (act === 'copy-latex') {
          copyToClipboard(`$$${ctx.latex}$$`);
        } else if (act === 'copy-pure') {
          copyToClipboard(ctx.latex);
        } else if (act === 'copy-ai') {
          const paper = state.reader.paper;
          const pKey = String(state.reader.currentPage);
          const origBlk = (paper?.blocks?.[pKey] || []).find((b) => b.block_id === ctx.blockId);
          const prompt = formatAiPrompt({
            title: paper?.meta?.title,
            page: state.reader.currentPage,
            originalExcerpt: origBlk?.text || `$$${ctx.latex}$$`,
            translatedExcerpt: `$$${ctx.latex}$$`,
            question: '이 수식의 각 기호 의미와 직관적 원리를 단계별로 알기 쉽게 설명해줘.'
          });
          copyToClipboard(prompt);
        }
      });
    });

    // Note Modal
    let selectedNoteColor = 'amber';
    $$('#note-modal-color-row .hl-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#note-modal-color-row .hl-swatch').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedNoteColor = btn.dataset.color;
      });
    });

    $('#btn-save-note-modal').addEventListener('click', async () => {
      const val = $('#note-modal-textarea').value.trim();
      const mode = state.reader.noteModalMode;
      const ctx = state.reader.noteModalContext || {};

      if (mode === 'highlight-note') {
        savePendingHighlight(selectedNoteColor, val);
        closeModal('note-modal');
        return;
      }

      if (!val) {
        showToast('질문 또는 메모 내용을 입력해 주세요.', 'error');
        return;
      }
      const paper = state.reader.paper;
      if (!paper) return;
      if (!paper.annotations) paper.annotations = { highlights: [], bookmarks: [], comments: [] };

      paper.annotations.comments.push({
        id: `cm-${Date.now()}`,
        page: ctx.page || state.reader.currentPage,
        block_id: ctx.block_id || '',
        original_excerpt: ctx.original_excerpt || '',
        translated_excerpt: ctx.translated_excerpt || '',
        question: val,
        resolved: false,
        created_at: Date.now()
      });

      closeModal('note-modal');
      $('#selection-toolbar').classList.add('hidden');
      window.getSelection()?.removeAllRanges();
      state.reader.sidebarTab = 'notes';
      await persistAnnotations();
      showToast('질문/댓글이 저장되었습니다.', 'success');
    });

    // Delete Confirm Modal
    $('#btn-confirm-delete-paper').addEventListener('click', async () => {
      const hash = state.reader.deletingHash;
      if (!hash) return;
      state.reader.deletingHash = null;
      closeModal('delete-confirm-modal');

      const res = await window.paperAPI.deletePaper(hash);
      if (res.ok) {
        state.recent = res.recent || [];
        state.tags = res.tags || [];
        if (state.openTabs.some((t) => t.pdfHash === hash)) {
          await closePaperTab(hash);
        }
        refreshLibrarySearch();
        showToast('논문이 삭제되었습니다.', 'success');
      } else {
        showToast(res.error || '삭제 실패', 'error');
      }
    });

    // Meta Edit Modal
    const submitMetaModal = async () => {
      const hash = state.reader.editingMetaHash;
      if (!hash) return;
      const tags = $('#meta-input-tags')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.startsWith('#') ? s : `#${s}`));

      const res = await window.paperAPI.updateMeta({
        pdfHash: hash,
        updates: {
          title: $('#meta-input-title').value.trim(),
          short_title: $('#meta-input-title').value.trim().slice(0, 42),
          tags,
          one_line_summary: $('#meta-input-summary').value.trim(),
          review: $('#meta-input-review').value.trim()
        }
      });
      if (res.ok) {
        state.recent = res.recent;
        state.tags = res.tags;
        closeModal('meta-modal');
        refreshLibrarySearch();
        showToast('메타데이터가 저장되었습니다.', 'success');
      }
    };
    $('#btn-save-meta-modal').addEventListener('click', submitMetaModal);
    ['#meta-input-title', '#meta-input-tags', '#meta-input-summary'].forEach((sel) => {
      $(sel)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          submitMetaModal();
        }
      });
    });
    $('#meta-input-review')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        submitMetaModal();
      }
    });

    // Attachments Modal Events
    const attDz = $('#att-dropzone');
    attDz.addEventListener('click', async () => {
      if (!state.reader.editingAttHash) return;
      const res = await window.paperAPI.pickAttachmentFile();
      if (res.ok && !res.canceled && res.filePath) {
        await addPaperAttachment(state.reader.editingAttHash, {
          type: 'file',
          title: res.name,
          target: res.filePath
        });
      }
    });
    attDz.addEventListener('dragover', (e) => {
      e.preventDefault();
      attDz.classList.add('drag-over');
    });
    attDz.addEventListener('dragleave', () => attDz.classList.remove('drag-over'));
    attDz.addEventListener('drop', async (e) => {
      e.preventDefault();
      attDz.classList.remove('drag-over');
      if (state.reader.editingAttHash) {
        await handleAttachmentDrop(state.reader.editingAttHash, e.dataTransfer);
      }
    });

    const submitAttUrl = async () => {
      const hash = state.reader.editingAttHash;
      const urlVal = $('#att-input-url').value.trim();
      if (!hash || !urlVal) return;
      const titleVal = $('#att-input-title').value.trim();
      const type = classifyAttachmentUrl(urlVal);
      const fallbackTitle = type === 'notion' ? 'Notion 페이지' : urlVal.replace(/^https?:\/\//i, '').slice(0, 36);
      await addPaperAttachment(hash, {
        type,
        title: titleVal || fallbackTitle,
        target: urlVal
      });
      $('#att-input-title').value = '';
      $('#att-input-url').value = '';
    };
    $('#btn-add-att-url').addEventListener('click', submitAttUrl);
    $('#att-input-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submitAttUrl();
      }
    });
    $('#att-input-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if ($('#att-input-url').value.trim()) submitAttUrl();
        else $('#att-input-url').focus();
      }
    });

    // Settings Modal
    $('#btn-open-data-dir').addEventListener('click', () => {
      window.paperAPI.openDataDir();
    });

    $('#btn-save-settings').addEventListener('click', async () => {
      const payload = {
        pdfFilter: $('#settings-pdf-filter').value
      };
      const res = await window.paperAPI.saveConfig(payload);
      if (res.ok) {
        state.config = res.config;
        applyPdfFilter();
        closeModal('settings-modal');
        showToast('설정이 저장되었습니다.', 'success');
      } else {
        showToast(res.error || '설정 저장 실패', 'error');
      }
    });

    // Generic modal close
    $$('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    $$('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModals = $$('.modal-backdrop:not(.hidden)');
        if (openModals.length > 0) {
          e.preventDefault();
          openModals.forEach((m) => closeModal(m.id));
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const num = Number(e.key);
        e.preventDefault();
        if (num === 1) {
          switchView('home');
        } else if (num === 2) {
          switchView('library');
        } else {
          const targetTab = state.openTabs[num - 3];
          if (targetTab) {
            activatePaperTab(targetTab.pdfHash);
          }
        }
        return;
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const anyModalOpen = Boolean(document.querySelector('.modal-backdrop:not(.hidden)'));
        if (!anyModalOpen) {
          e.preventDefault();
          const cycle = ['home', 'library', ...state.openTabs.map((t) => t.pdfHash)];
          const currentKey = state.view === 'reader' ? state.activeTabHash : state.view;
          const idx = Math.max(0, cycle.indexOf(currentKey));
          const step = e.shiftKey ? -1 : 1;
          const nextKey = cycle[(idx + step + cycle.length) % cycle.length];
          if (nextKey === 'home' || nextKey === 'library') switchView(nextKey);
          else activatePaperTab(nextKey);
          return;
        }
      }
      if (state.view === 'reader' && state.reader.paper) {
        if (e.key === 'ArrowLeft') goToPage(state.reader.currentPage - 1);
        else if (e.key === 'ArrowRight') goToPage(state.reader.currentPage + 1);
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          toggleBookmarkCurrentPage();
        }
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (state.view === 'reader' && state.reader.paper && state.reader.zoomMode === 'fit') {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => renderCurrentPdfPage(), 120);
      }
    });
  }

  async function refreshOpenTabFromDisk(pdfHash) {
    const tab = state.openTabs.find((t) => t.pdfHash === pdfHash);
    if (!tab) return;
    const res = await window.paperAPI.loadPaper(pdfHash);
    if (!res.ok || !res.paper) return;
    const fresh = res.paper;
    tab.paper.meta = fresh.meta || tab.paper.meta;
    if (fresh.blocks && Object.keys(fresh.blocks).length > 0) {
      tab.paper.blocks = fresh.blocks;
    }
    if (fresh.translations) {
      tab.paper.translations = fresh.translations;
    }
    if (typeof fresh.summaryMd === 'string') {
      tab.paper.summaryMd = fresh.summaryMd;
    }
    renderOpenPaperTabs();
    if (state.reader === tab && state.view === 'reader') {
      updateReaderHeaderControls();
      renderPdfBlockOverlays();
      renderTranslationPane();
      renderSummaryPane();
    }
  }

  async function init() {
    bindEvents();
    if (window.paperAPI.onAgyStatus) {
      window.paperAPI.onAgyStatus(({ pdfHash, status, mode, error }) => {
        state.agyJobs.set(pdfHash, { status, mode, error });
        if (status === 'running') {
          showToast(
            mode === 'summary'
              ? 'Antigravity가 review-paper 요약을 생성 중입니다...'
              : 'Antigravity가 백그라운드에서 번역을 생성 중입니다...',
            'info'
          );
        } else if (status === 'done') {
          showToast(
            mode === 'summary'
              ? 'review-paper 요약이 완료되어 반영되었습니다!'
              : 'Antigravity 번역이 완료되어 반영되었습니다!',
            'success'
          );
        } else if (status === 'error') {
          showToast(`Antigravity 실행 오류: ${error || '배지를 눌러 재개할 수 있습니다.'}`, 'error');
        }
        if (state.reader?.pdfHash === pdfHash && state.view === 'reader') {
          updateMiddleStatusControls();
        }
      });
    }
    if (window.paperAPI.onPaperExternalUpdate) {
      window.paperAPI.onPaperExternalUpdate(async ({ pdfHash }) => {
        const appRes = await window.paperAPI.initApp();
        if (appRes.ok) {
          state.recent = appRes.recent || [];
          state.tags = appRes.tags || [];
          if (state.view === 'home') renderHomeRecentList();
          if (state.view === 'library') refreshLibrarySearch();
        }
        if (pdfHash) {
          await refreshOpenTabFromDisk(pdfHash);
        }
      });
    }

    if (window.paperAPI.onCloseTabShortcut) {
      window.paperAPI.onCloseTabShortcut(() => {
        if (state.view === 'reader' && state.activeTabHash) {
          closePaperTab(state.activeTabHash);
        }
      });
    }

    if (window.paperAPI.onPaperDeepLink) {
      window.paperAPI.onPaperDeepLink((link) => {
        if (link?.pdfHash) {
          openPaperInReader(link.pdfHash, link.page || 1);
        }
      });
    }

    const res = await window.paperAPI.initApp();
    if (res.ok) {
      state.config = res.config;
      state.recent = res.recent || [];
      state.tags = res.tags || [];
      state.dataRoot = res.dataRoot || '';
      applyTheme(state.config.theme);
      syncSnowEffect();
      renderOpenPaperTabs();
      renderHomeRecentList();
    }

    if (window.paperAPI.consumeDeepLink) {
      const pendingLink = await window.paperAPI.consumeDeepLink();
      if (pendingLink?.pdfHash) {
        openPaperInReader(pendingLink.pdfHash, pendingLink.page || 1);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
