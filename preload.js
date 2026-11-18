const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('paperAPI', {
  getFilePath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {}
    return file?.path || '';
  },
  initApp: () => ipcRenderer.invoke('app:init'),
  saveConfig: (updates) => ipcRenderer.invoke('config:save', updates),
  openFileDialog: () => ipcRenderer.invoke('pdf:open-dialog'),
  importFile: (filePath) => ipcRenderer.invoke('pdf:import-file', filePath),
  importUrl: (url) => ipcRenderer.invoke('pdf:import-url', url),
  loadPaper: (pdfHash) => ipcRenderer.invoke('paper:load', pdfHash),
  saveBlocks: (payload) => ipcRenderer.invoke('paper:save-blocks', payload),
  updateMeta: (payload) => ipcRenderer.invoke('paper:update-meta', payload),
  saveAnnotations: (payload) => ipcRenderer.invoke('paper:save-annotations', payload),
  deletePaper: (pdfHash) => ipcRenderer.invoke('paper:delete', pdfHash),
  exportPkg: (payload) => ipcRenderer.invoke('paper:export-pkg', payload),
  exportMd: (payload) => ipcRenderer.invoke('paper:export-md', payload),
  searchLibrary: (filters) => ipcRenderer.invoke('library:search', filters),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDataDir: () => ipcRenderer.invoke('shell:open-data-dir'),
  pickAttachmentFile: () => ipcRenderer.invoke('attachment:pick-file'),
  openAttachment: (target) => ipcRenderer.invoke('attachment:open', target),
  resolveArchiveHubItem: (itemId) => ipcRenderer.invoke('attachment:resolve-archive-hub', itemId),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  runAgyForPaper: (pdfHash, mode = 'translate') => ipcRenderer.invoke('agy:run', { pdfHash, mode }),
  getAgyStatus: (pdfHash) => ipcRenderer.invoke('agy:status', pdfHash),
  onAgyStatus: (cb) => ipcRenderer.on('agy:status', (_ev, data) => cb(data)),
  onPaperExternalUpdate: (cb) => ipcRenderer.on('paper:external-update', (_ev, data) => cb(data)),
  onCloseTabShortcut: (cb) => ipcRenderer.on('shortcut:close-tab', () => cb()),
  consumeDeepLink: () => ipcRenderer.invoke('app:consume-deep-link'),
  onPaperDeepLink: (cb) => ipcRenderer.on('paper:open-deep-link', (_ev, data) => cb(data)),
  startPaperDrag: (payload) => ipcRenderer.send('paper:start-drag', payload)
});
