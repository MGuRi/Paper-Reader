const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const storage = require('./services/storage');

const APP_USER_MODEL_ID = 'com.paperreader.app';
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
const activeDirWatchers = new Map();

function parseDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const raw = argv.find((a) => typeof a === 'string' && a.startsWith('paperreader://'));
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const segments = [u.hostname, ...u.pathname.split('/').filter(Boolean)].filter(Boolean);
    // Support paperreader://open/<pdfHash> or paperreader://<pdfHash>
    const pdfHash = segments[0] === 'open' ? segments[1] : segments[0];
    if (!pdfHash) return null;
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
    return { pdfHash, page };
  } catch {
    return null;
  }
}

let pendingDeepLink = parseDeepLinkFromArgv(process.argv);

function resolveAntigravityExe() {
  if (process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function watchPaperDir(pdfHash, paperDir) {
  if (activeDirWatchers.has(pdfHash)) return;
  let watchTimer = null;
  try {
    const watcher = fs.watch(paperDir, (_ev, fname) => {
      if (fname && !/^(translations\.json|summary\.md|meta\.json|blocks\.json)$/i.test(fname)) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try { storage.getRecentList(); } catch {}
        sendToRenderer('paper:external-update', { pdfHash });
      }, 250);
    });
    activeDirWatchers.set(pdfHash, watcher);
  } catch {}
}

function openAntigravityGuiWithPrompt(pdfHash, mode = 'full') {
  if (!pdfHash) return { ok: false, error: 'pdfHash가 없습니다.' };

  const paperDir = path.join(storage.getDataRoot(), 'papers', pdfHash);
  const pdfPath = path.join(paperDir, 'paper.pdf');
  const specPath = path.join(__dirname, 'ANTIGRAVITY_SPEC.md');
  const reviewSkillPath = path.join(app.getPath('home'), '.gemini', 'config', 'skills', 'review-paper', 'SKILL.md');

  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: 'paper.pdf를 찾을 수 없습니다.' };
  }

  const taskMode = mode || 'full';
  const prompt = [
    `/PostPaper [PaperReader 전체 등록 요청 | pdf_hash: ${pdfHash}]`,
    `규격 문서 "${specPath}" 와 요약 스킬 "${reviewSkillPath}" 를 참고해 아래 작업을 한 번에 진행해 주세요:`,
    `1. "${pdfPath}" 를 분석해 review-paper 스킬 규격에 맞춘 전체 논문 구조화 요약을 "${path.join(paperDir, 'summary.md')}" 에 저장`,
    `2. "${path.join(paperDir, 'meta.json')}" 의 title, short_title, authors, venue, tags, one_line_summary, total_pages, body_end_page를 채워주세요.`,
    `3. "${pdfPath}" 의 텍스트만 읽지 말고 PDF 페이지 전체 레이아웃(단 구성·그림/표 영역·들여쓰기)을 함께 확인해 실제 원문의 문단 구분과 2단 읽기 순서를 그대로 유지한 블록과 정규화 좌표(bbox)를 "${path.join(paperDir, 'blocks.json')}" 에 저장 (Figure 내부에 속한 다이어그램·축·눈금·범례·서브피규어 라벨 텍스트는 전부 걸러내어 별도 블록으로 남기지 말고, 실제 그림 전체 외곽을 감싸는 "[Figure N]" 단일 블록으로만 처리하며 페이지 번호·arXiv 워터마크·저작권 고지 등 불필요한 잡음 제외)`,
    `4. "${path.join(paperDir, 'translations.json')}" 에 block_id와 1:1 매핑된 한국어 학술 번역을 원문과 동일한 문단 구분으로 "translated_md" 필드에 1페이지부터 순서대로 저장 (Figure 내부 도표/라벨은 "[Figure N]"으로만 표기하고, 저장 전 불필요한 조각·누락이 없는지 1회 검수 후 반영).`
  ].join('\n');

  clipboard.writeText(prompt);
  watchPaperDir(pdfHash, paperDir);

  const agyGuiExe = resolveAntigravityExe();
  if (agyGuiExe) {
    try {
      const child = spawn(agyGuiExe, [__dirname], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return { ok: true, mode: taskMode, copied: true };
    } catch {}
  }

  shell.openExternal('antigravity://').catch(() => {});
  return { ok: true, mode: taskMode, copied: true };
}

function openExternalIfSafe(targetUrl) {
  try {
    const raw = String(targetUrl || '').trim();
    if (!raw) return { ok: false, error: 'URL이 비어 있습니다.' };
    if (/^notion:\/\//i.test(raw)) {
      shell.openExternal(raw).catch(() => {});
      return { ok: true };
    }
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      shell.openExternal(u.toString()).catch(() => {});
      return { ok: true };
    }
  } catch {}
  return { ok: false, error: '허용되지 않은 URL 형식입니다.' };
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const { width: waW, height: waH } = screen.getPrimaryDisplay().workAreaSize;
  const initWidth = Math.max(480, Math.round(waW * 0.8));
  const initHeight = Math.max(420, Math.round(waH * 0.8));
  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    center: true,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#1C1C1B',
    title: 'PaperReader',
    frame: false,
    hasShadow: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const indexFileUrl = new URL(`file://${path.join(__dirname, 'src', 'index.html').replace(/\\/g, '/')}`).href;

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Prevent any in-app navigation or popup window from trapping the user on an external webpage.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const baseTarget = String(url || '').split('#')[0];
    if (baseTarget && baseTarget.toLowerCase() !== indexFileUrl.toLowerCase()) {
      event.preventDefault();
      openExternalIfSafe(url);
    }
  });

  if (process.platform === 'win32' && typeof mainWindow.setAppDetails === 'function') {
    mainWindow.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: fs.existsSync(iconPath) ? iconPath : undefined,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${__dirname}"`,
      relaunchDisplayName: 'PaperReader'
    });
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.control || input.meta) &&
      !input.alt &&
      String(input.key || '').toLowerCase() === 'w'
    ) {
      event.preventDefault();
      sendToRenderer('shortcut:close-tab');
    }
  });

  const watchers = [];
  if (!app.isPackaged) {
    let reloadTimer = null;
    const srcDir = path.join(__dirname, 'src');
    try {
      watchers.push(
        fs.watch(srcDir, (_ev, filename) => {
          if (filename && !/\.(html|css|js)$/i.test(filename)) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.reloadIgnoringCache();
            }
          }, 120);
        })
      );
    } catch {}

    let relaunchTimer = null;
    const triggerRelaunch = () => {
      clearTimeout(relaunchTimer);
      relaunchTimer = setTimeout(() => {
        isQuitting = true;
        app.relaunch();
        app.exit(0);
      }, 220);
    };
    for (const target of [
      path.join(__dirname, 'main.js'),
      path.join(__dirname, 'preload.js'),
      path.join(__dirname, 'services')
    ]) {
      try {
        watchers.push(fs.watch(target, triggerRelaunch));
      } catch {}
    }
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:init', () => {
    return {
      ok: true,
      config: storage.getPublicConfig(),
      recent: storage.getRecentList(),
      tags: storage.getAllTags(),
      dataRoot: storage.getDataRoot()
    };
  });

  ipcMain.handle('app:consume-deep-link', () => {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return link;
  });

  ipcMain.handle('config:save', (_event, updates) => {
    try {
      const config = storage.saveConfig(updates);
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pdf:open-dialog', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'PDF 또는 .paperpkg 파일 선택',
        properties: ['openFile'],
        filters: [
          { name: 'Academic Papers & Packages', extensions: ['pdf', 'paperpkg', 'zip'] },
          { name: 'PDF Files', extensions: ['pdf'] },
          { name: 'PaperReader Packages', extensions: ['paperpkg', 'zip'] }
        ]
      });
      if (result.canceled || !result.filePaths?.[0]) {
        return { ok: true, canceled: true };
      }
      const imported = storage.importPdfFile(result.filePaths[0]);
      if (!imported.alreadyExists && !imported.importedPackage) {
        openAntigravityGuiWithPrompt(imported.pdfHash, 'full');
      }
      return {
        ok: true,
        canceled: false,
        pdfHash: imported.pdfHash,
        agyTriggered: !imported.alreadyExists && !imported.importedPackage,
        recent: storage.getRecentList(),
        tags: storage.getAllTags()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pdf:import-file', (_event, filePath) => {
    try {
      const imported = storage.importPdfFile(filePath);
      if (!imported.alreadyExists && !imported.importedPackage) {
        openAntigravityGuiWithPrompt(imported.pdfHash, 'full');
      }
      return {
        ok: true,
        pdfHash: imported.pdfHash,
        agyTriggered: !imported.alreadyExists && !imported.importedPackage,
        recent: storage.getRecentList(),
        tags: storage.getAllTags()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pdf:import-url', async (_event, urlStr) => {
    try {
      const imported = await storage.importFromUrl(urlStr);
      if (!imported.alreadyExists && !imported.importedPackage) {
        openAntigravityGuiWithPrompt(imported.pdfHash, 'full');
      }
      return {
        ok: true,
        pdfHash: imported.pdfHash,
        agyTriggered: !imported.alreadyExists && !imported.importedPackage,
        recent: storage.getRecentList(),
        tags: storage.getAllTags()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('agy:run', (_event, payload) => {
    if (typeof payload === 'string') return openAntigravityGuiWithPrompt(payload, 'translate');
    return openAntigravityGuiWithPrompt(payload?.pdfHash, payload?.mode || 'translate');
  });

  ipcMain.handle('agy:status', () => {
    return { status: 'idle' };
  });

  ipcMain.handle('paper:load', (_event, pdfHash) => {
    try {
      const paper = storage.loadPaper(pdfHash);
      return { ok: true, paper };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:save-blocks', (_event, { pdfHash, page, blocks, totalPages, bodyEndPage, detectedTitle }) => {
    try {
      storage.saveBlocks(pdfHash, { page, blocks, totalPages, bodyEndPage, detectedTitle });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:open-data-dir', async () => {
    try {
      const root = storage.getDataRoot();
      await shell.openPath(root);
      return { ok: true, path: root };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:update-meta', (_event, { pdfHash, updates }) => {
    try {
      const meta = storage.updateMeta(pdfHash, updates);
      return {
        ok: true,
        meta,
        recent: storage.getRecentList(),
        tags: storage.getAllTags()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:save-annotations', (_event, { pdfHash, annotations }) => {
    try {
      const saved = storage.saveAnnotations(pdfHash, annotations);
      return {
        ok: true,
        annotations: saved,
        recent: storage.getRecentList()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:delete', (_event, pdfHash) => {
    try {
      const recent = storage.deletePaper(pdfHash);
      return { ok: true, recent, tags: storage.getAllTags() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:export-pkg', async (_event, { pdfHash, defaultName }) => {
    try {
      const safeName = String(defaultName || 'paper').replace(/[\\/:*?"<>|]/g, '_');
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '.paperpkg 패키지 내보내기',
        defaultPath: `${safeName}.paperpkg`,
        filters: [{ name: 'PaperReader Package', extensions: ['paperpkg'] }]
      });
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      const out = storage.exportPaperPkg(pdfHash, res.filePath);
      return { ok: true, canceled: false, path: out.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:export-md', async (_event, { pdfHash, defaultName }) => {
    try {
      const safeName = String(defaultName || 'paper_notes').replace(/[\\/:*?"<>|]/g, '_');
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '마크다운(.md) 노트 내보내기',
        defaultPath: `${safeName}.md`,
        filters: [{ name: 'Markdown Note', extensions: ['md'] }]
      });
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      const out = storage.exportMarkdownNote(pdfHash, res.filePath);
      return { ok: true, canceled: false, path: out.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('library:search', (_event, filters) => {
    try {
      const results = storage.searchLibrary(filters || {});
      return {
        ok: true,
        results,
        tags: storage.getAllTags()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('paper:start-drag', (event, { pdfHash, title } = {}) => {
    if (!pdfHash) return;
    try {
      const linksDir = path.join(storage.getDataRoot(), 'links');
      fs.mkdirSync(linksDir, { recursive: true });
      const linkPath = path.join(linksDir, `${pdfHash}.paperlink`);
      const payload = {
        type: 'paperreader-link',
        pdfHash,
        title: String(title || 'PaperReader 논문').trim(),
        url: `paperreader://open/${pdfHash}`
      };
      fs.writeFileSync(linkPath, JSON.stringify(payload, null, 2), 'utf-8');

      const pngPath = path.join(__dirname, 'assets', 'icon.png');
      const dragIcon = fs.existsSync(pngPath)
        ? nativeImage.createFromPath(pngPath).resize({ width: 36, height: 36 })
        : nativeImage.createEmpty();
      event.sender.startDrag({
        file: linkPath,
        icon: dragIcon
      });
    } catch {}
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('shell:open-external', (_event, targetUrl) => {
    return openExternalIfSafe(targetUrl);
  });

  ipcMain.handle('attachment:pick-file', async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '첨부할 파일 선택',
        properties: ['openFile']
      });
      if (res.canceled || !res.filePaths?.[0]) return { ok: true, canceled: true };
      const filePath = res.filePaths[0];
      return { ok: true, canceled: false, filePath, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('attachment:open', async (_event, target) => {
    try {
      const raw = String(target || '').trim();
      if (!raw) return { ok: false, error: '경로가 비어 있습니다.' };
      if (/^(https?:|notion:)/i.test(raw)) {
        await shell.openExternal(raw);
        return { ok: true };
      }
      const errMsg = await shell.openPath(raw);
      if (errMsg) return { ok: false, error: errMsg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('attachment:resolve-archive-hub', (_event, itemId) => {
    const resolved = storage.resolveArchiveHubItem(itemId);
    return resolved ? { ok: true, item: resolved } : { ok: false };
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    isQuitting = true;
    app.quit();
  });
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  if (tray) return;
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const iconPath = fs.existsSync(pngPath) ? pngPath : icoPath;
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('PaperReader (Alt+Shift+Q)');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '열기 / 숨기기 (Alt+Shift+Q)',
        click: () => toggleWindowVisibility()
      },
      { type: 'separator' },
      {
        label: '완전 종료',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', () => toggleWindowVisibility());
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = parseDeepLinkFromArgv(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    if (link) {
      pendingDeepLink = link;
      sendToRenderer('paper:open-deep-link', link);
    }
  });

  app.whenReady().then(() => {
    try {
      if (process.defaultApp) {
        app.setAsDefaultProtocolClient('paperreader', process.execPath, [path.resolve(__dirname)]);
      } else {
        app.setAsDefaultProtocolClient('paperreader');
      }
    } catch {}

    registerIpcHandlers();
    createWindow();
    createTray();

    globalShortcut.register('Alt+Shift+Q', () => {
      toggleWindowVisibility();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
