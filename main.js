// @ts-nocheck
const {
  app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, nativeImage, screen, desktopCapturer, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => globalThis.fetch(...args);
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

let win, tray;
const STEP = 20;
let translucent = false;

/* ====== LOG GUARDS ====== */
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'copiloto.log'), `${new Date().toISOString()} UNCAUGHT ${err.stack || err}\n`); } catch {}
  if (win) win.webContents.send('status', 'Erro não tratado (continuando). Veja o log.');
});
process.on('unhandledRejection', (err) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'copiloto.log'), `${new Date().toISOString()} UNHANDLED ${err.stack || err}\n`); } catch {}
  if (win) win.webContents.send('status', 'Promise rejeitada sem catch (continuando). Veja o log.');
});

/* ====== SINGLE INSTANCE ====== */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else { app.on('second-instance', () => { if (win) { win.show(); win.focus(); } }); }

/* ====== PASTAS / LOG ====== */
const ASSETS = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, 'assets');

const userDir = path.join(app.getPath('appData'), 'appx');
app.setName('appx');
app.setPath('userData', userDir);
fs.mkdirSync(userDir, { recursive: true });

const LOG = path.join(app.getPath('userData'), 'copiloto.log');
function writeLog(line) { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} }
function sendStatus(msg) { writeLog(`STATUS ${msg}`); if (win) win.webContents.send('status', msg); }

function dumpFile(buf, hint = 'x') {
  try {
    const fname = path.join(app.getPath('userData'), `${hint}-${Date.now()}.png`);
    fs.writeFileSync(fname, buf);
    writeLog(`DUMP wrote ${fname} size=${buf.length}`);
    return fname;
  } catch (e) { writeLog(`DUMP failed: ${e?.message || e}`); return null; }
}

/* ====== HELPERS ====== */
function withTimeout(promise, ms, label = 'operação') {
  let ctrl;
  return Promise.race([
    promise,
    new Promise((_, rej) => { ctrl = setTimeout(() => rej(new Error(`${label} excedeu ${ms}ms`)), ms); })
  ]).finally(() => clearTimeout(ctrl));
}
function fileExists(p) { try { return !!fs.statSync(p); } catch { return false; } }

function resolveTesseractPaths() {
  let workerPath = null, corePath = null;
  try { workerPath = require.resolve('tesseract.js/dist/worker.min.js'); } catch {}
  try { corePath   = require.resolve('tesseract.js-core/tesseract-core.wasm.js'); } catch {}
  const tessdataDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'tessdata')
    : path.join(__dirname, 'assets', 'tessdata');
  return { workerPath, corePath, tessdataDir };
}

/* ====== JANELA ====== */
function bringToFront() {
  if (!win) return;
  win.setAlwaysOnTop(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.moveTop(); win.show(); win.focus();
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const W = Math.max(520, Math.floor(area.width * 0.5));
  const H = Math.max(320, Math.floor(area.height * 0.5));
  const X = area.x + Math.floor((area.width - W) / 2);
  const Y = area.y + Math.floor((area.height - H) / 6);

  win = new BrowserWindow({
    x: X, y: Y, width: W, height: H,
    minWidth: 520, minHeight: 320,
    show: false, frame: false, transparent: false,
    alwaysOnTop: true, focusable: true, resizable: true, skipTaskbar: true,
    icon: path.join(ASSETS, 'icon.ico'),
    useContentSize: true,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setContentProtection(true);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { bringToFront(); setTimeout(bringToFront, 300); });
  win.on('focus', bringToFront);
  win.on('blur',  bringToFront);
}

/* ====== CAPTURA ====== */
async function captureDisplayPNGByDisplayId(displayId) {
  const displays = screen.getAllDisplays();
  const display = displays.find(d => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sf = display.scaleFactor || 1;
  const mult = 1.5;
  const target = {
    width:  Math.min(4096, Math.floor(width  * sf * mult)),
    height: Math.min(4096, Math.floor(height * sf * mult)),
  };
  writeLog(`CAPTURE displayId=${display.id} size=${width}x${height} scale=${sf} => thumb=${target.width}x${target.height}`);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: target });
  const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw new Error('Nenhuma fonte de tela encontrada');
  const png = source.thumbnail.toPNG();
  writeLog(`CAPTURE ok bytes=${png.length}`);
  return png;
}
async function captureDisplayByIndex(idx) {
  try {
    const displays = screen.getAllDisplays();
    if (!displays[idx]) return sendStatus(`Monitor ${idx + 1} não encontrado.`);
    const png = await captureDisplayPNGByDisplayId(displays[idx].id);
    emitShot(png, `monitor-${idx + 1}`);
  } catch (err) { sendStatus(`Erro ao capturar monitor ${idx + 1}: ${err?.message || err}`); }
}
async function captureDisplayUnderCursor() {
  try {
    const cursor = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(cursor);
    const png = await captureDisplayPNGByDisplayId(disp.id);
    emitShot(png, `cursor-${disp.id}`);
  } catch (err) { sendStatus(`Erro ao capturar tela do cursor: ${err?.message || err}`); }
}

/* ====== EMISSÃO / ACK ====== */
let lastShotId = 0;
const pendingAcks = new Map();

function emitShot(pngBuf, hint) {
  const file = dumpFile(pngBuf, `shot-${hint}`);
  const id = ++lastShotId;
  const b64 = pngBuf.toString('base64');
  writeLog(`EMIT id=${id} len=${pngBuf.length} file=${file || 'n/a'}`);
  if (!win) { writeLog('EMIT abortado: win nulo'); return; }
  win.webContents.send('shot:image', { id, b64, file });
  const t = setTimeout(() => {
    writeLog(`ACK TIMEOUT id=${id}`);
    sendStatus(`Falha ao entregar screenshot (id=${id}) — veja logs.`);
    pendingAcks.delete(id);
  }, 5000);
  pendingAcks.set(id, t);
}

/* ====== QUIT ====== */
const hardQuit = () => { try { app.quit(); } catch {} setTimeout(()=>{ try{app.exit(0);}catch{} }, 400); };

/* ====== HOTKEYS ====== */
const HOTKEY_GROUPS = {
  bringToFront: ['Ctrl+Q','Control+Q','CommandOrControl+Q'],
  capMon1: ['Ctrl+1','Control+1','CommandOrControl+1','Ctrl+F1','Control+F1','CommandOrControl+F1','Alt+1','Ctrl+Shift+1','Ctrl+Alt+1'],
  capMon2: ['Ctrl+2','Control+2','CommandOrControl+2','Ctrl+F2','Control+F2','CommandOrControl+F2','Alt+2','Ctrl+Shift+2','Ctrl+Alt+2'],
  capCursor: ['PrintScreen','Ctrl+PrintScreen','Shift+PrintScreen','Alt+PrintScreen','Ctrl+Alt+P','Ctrl+Shift+P','Alt+H','Ctrl+H','Ctrl+Shift+H'],
  solve: ['Ctrl+Enter','Control+Enter','CommandOrControl+Enter'],
  ctxReset: ['Ctrl+G','Control+G','CommandOrControl+G'],
  moveUp: ['Ctrl+Up','Ctrl+Alt+Up','Ctrl+Alt+W'],
  moveDown: ['Ctrl+Down','Ctrl+Alt+Down','Ctrl+Alt+S'],
  moveLeft: ['Ctrl+Left','Ctrl+Alt+Left','Ctrl+Alt+A'],
  moveRight: ['Ctrl+Right','Ctrl+Alt+Right','Ctrl+Alt+D'],
  opacity: ['Ctrl+3','Control+3','CommandOrControl+3'],
  quit: ['Ctrl+4','Control+4','CommandOrControl+4','Ctrl+Shift+4','Control+Shift+4','CommandOrControl+Shift+4','Ctrl+Alt+X','Control+Alt+X','CommandOrControl+Alt+X'],
  devtools: ['Ctrl+Shift+I','Control+Shift+I','CommandOrControl+Shift+I'],
  testShot: ['Ctrl+T','Control+T','CommandOrControl+T']
};
const HANDLERS = {
  bringToFront: () => bringToFront(),
  capMon1: () => captureDisplayByIndex(0),
  capMon2: () => captureDisplayByIndex(1),
  capCursor: () => captureDisplayUnderCursor(),
  solve: () => { if (win) win.webContents.send('solve:run'); },
  ctxReset: () => { if (win) win.webContents.send('ctx:reset'); },
  moveUp: () => nudge(0,-STEP),
  moveDown: () => nudge(0,STEP),
  moveLeft: () => nudge(-STEP,0),
  moveRight: () => nudge(STEP,0),
  opacity: () => { if(!win) return; translucent=!translucent; win.setOpacity(translucent?0.6:1.0); sendStatus(translucent? 'Transparente ON':'Transparente OFF'); },
  quit: () => hardQuit(),
  devtools: () => { if (win) win.webContents.openDevTools({ mode: 'detach' }); },
  testShot: async () => {
    try {
      writeLog('TEST Ctrl+T start');
      const png = await captureDisplayPNGByDisplayId(screen.getPrimaryDisplay().id);
      emitShot(png, 'ctrlT');
    } catch (e) { sendStatus('Teste falhou: ' + (e?.message || e)); }
  }
};
function nudge(dx,dy){ if(!win) return; const b=win.getBounds(); win.setBounds({x:b.x+dx,y:b.y+dy,width:b.width,height:b.height}, false); }
function registerAllHotkeys() {
  globalShortcut.unregisterAll();
  const successes = [], failures = [];
  for (const [name, combos] of Object.entries(HOTKEY_GROUPS)) {
    let okAny = false;
    for (const acc of combos) {
      try {
        const ok = globalShortcut.register(acc, async () => {
          sendStatus(`Atalho: ${acc}`); writeLog(`TRIGGER ${name} ${acc}`);
          try { await HANDLERS[name](); } catch (err) {
            sendStatus(`Erro no handler ${acc}: ${err?.message || err}`);
            writeLog(`HANDLER ERROR ${acc}: ${err?.stack || err}`);
          }
        });
        writeLog(`REGISTER ${name} ${acc}: ${ok}`);
        if (ok) { okAny = true; successes.push(acc); }
        else { failures.push(`${name}:${acc}`); }
      } catch (err) {
        failures.push(`${name}:${acc} (${err?.message||'exc'})`);
        writeLog(`REGISTER EXC ${name} ${acc}: ${err?.message}`);
      }
    }
    if (!okAny) sendStatus(`Nenhum atalho registrado para: ${name}`);
  }
  sendStatus(`Hotkeys ativos: ${successes.join(', ') || '(nenhum)'} • Logs: ${LOG}`);
  if (failures.length) writeLog(`HOTKEY FAILURES: ${failures.join(', ')}`);
  return { successes, failures };
}
function startHotkeyWatchdog() {
  setInterval(() => {
    const essentials = [...HOTKEY_GROUPS.capMon1, ...HOTKEY_GROUPS.capCursor, ...HOTKEY_GROUPS.solve];
    let missing = 0;
    for (const acc of essentials) {
      if (globalShortcut.isRegistered(acc)) { missing = 0; break; }
      missing++;
    }
    if (missing === essentials.length) {
      writeLog('HOTKEY WATCHDOG: re-registrando hotkeys…');
      registerAllHotkeys();
    }
  }, 15000);
}

/* ====== APP READY (consolidado) ====== */
app.whenReady().then(() => {
  app.setAppUserModelId('meu.copiloto.local');
  createWindow();
  registerAllHotkeys();
  startHotkeyWatchdog();

  // Bandeja
  try {
    const trayImg = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
    tray = new Tray(trayImg);
    tray.setToolTip('Privacy Meeting Assistant');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Trazer para frente', click: () => bringToFront() },
      { label: 'Testar captura (primário)', click: async () => {
          try { const png = await captureDisplayPNGByDisplayId(screen.getPrimaryDisplay().id); emitShot(png, 'tray-primary'); }
          catch(e){ sendStatus('Erro no teste de captura: '+(e?.message||e)); }
        }},
      { label: 'Re-registrar hotkeys', click: () => registerAllHotkeys() },
      { label: 'Abrir DevTools', click: () => { if (win) win.webContents.openDevTools({ mode: 'detach' }); } },
      { type: 'separator' },
      { label: 'Sair', click: () => { try { app.quit(); } catch {} } }
    ]));
  } catch (e) { writeLog(`TRAY error: ${e?.message || e}`); }

  sendStatus(`Logs em: ${LOG}`);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ====== ACK / STATUS ====== */
ipcMain.on('shot:ack', (_e, { id, info }) => {
  writeLog(`ACK id=${id} info=${info || ''}`);
  const t = pendingAcks.get(id); if (t){ clearTimeout(t); pendingAcks.delete(id); }
});
ipcMain.on('status', (_e, msg) => writeLog(`RENDERER ${msg}`));

/* ====== Tessdata path sync ====== */
ipcMain.on('tessdataPath', (event) => {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'tessdata')
      : path.join(__dirname, 'assets', 'tessdata');
    event.returnValue = p;
  } catch (e) {
    event.returnValue = path.join(__dirname, 'assets', 'tessdata');
  }
});

/* ====== Dialogs ====== */
ipcMain.handle('pickImage', async () => {
  try {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp'] }] });
    if (res.canceled || !res.filePaths?.length) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  } catch (e) { writeLog(`pickImage error: ${e?.stack || e}`); return { ok: false, error: e?.message || String(e) }; }
});

/* ====== OCR via Tesseract.recognize (AGORA respeita langs) ====== */
async function runRecognize(inputBufferOrPath, label, langs = 'eng') {
  const { corePath, tessdataDir } = resolveTesseractPaths();

  // ajuda o engine a achar os dados (Windows/OneDrive com acentos)
  process.env.TESSDATA_PREFIX = tessdataDir;

  const langList = (langs || 'eng').split('+').map(s => s.trim()).filter(Boolean);
  const primary = langList[0] || 'eng';

  // sanity check básico (primary)
  const havePrimary = fileExists(path.join(tessdataDir, `${primary}.traineddata`)) ||
                      fileExists(path.join(tessdataDir, `${primary}.traineddata.gz`));
  if (!havePrimary) {
    throw new Error(
      `Arquivo de idioma não encontrado: ${primary}\n` +
      `Em: ${path.join(tessdataDir, `${primary}.traineddata`)}`
    );
  }

  writeLog(`TESSERACT recognize start label=${label} tessdata=${tessdataDir} core=${!!corePath} langs=${langs}`);
  const opts = {
    lang: langs,             // <- respeita os idiomas vindos do renderer
    corePath: corePath || undefined,
    // logger: m => writeLog(`TESS ${label}: ${m?.status || ''} ${m?.progress || ''}`)
  };

  // Assinatura: (image, lang, options) — lang pode ser "eng+por"
  const res = await Tesseract.recognize(inputBufferOrPath, langs, opts);
  const { data } = res || {};
  if (!data) throw new Error('Tesseract retornou vazio.');
  return data;
}

ipcMain.handle('recognizeImage', async (_evt, { imagePath, whitelist = '', langs = 'eng' }) => {
  const t0 = Date.now();
  try {
    writeLog(`OCR recognizeImage start path=${imagePath} langs=${langs}`);
    const data = await withTimeout(runRecognize(imagePath, 'file', langs), 30000, 'OCR (arquivo)');
    writeLog(`OCR recognizeImage ok textLen=${(data.text||'').length} ms=${Date.now()-t0}`);
    return { ok: true, text: data.text || '' };
  } catch (e) {
    writeLog(`recognizeImage error: ${e?.stack || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('ocr:png', async (_evt, { b64, langs = 'eng' }) => {
  const t0 = Date.now();
  try {
    if (!b64) throw new Error('Base64 vazio');
    writeLog(`OCR start langs=${langs} b64len=${b64.length}`);
    const original = Buffer.from(b64, 'base64');

    // meta + preproc leve
    let width=0, height=0, mean=128;
    try {
      const meta = await sharp(original).metadata(); width = meta.width||0; height = meta.height||0;
      const st = await sharp(original).stats();
      const r = st.channels?.[0]?.mean ?? 128, g = st.channels?.[1]?.mean ?? 128, b = st.channels?.[2]?.mean ?? 128;
      mean = Math.round((r+g+b)/3);
      writeLog(`OCR img meta ${width}x${height} mean=${mean}`);
    } catch (e) { writeLog(`OCR stats FAIL: ${e?.message || e}`); }

    const targetW = Math.min(4096, Math.max(1600, Math.round((width || 1200) * 1.75)));
    const preproc = await sharp(original)
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale().normalize().median(1).sharpen({ sigma: 1.0 })
      .png({ compressionLevel: 9 }).toBuffer();
    dumpFile(preproc, 'preproc-main');

    const data = await withTimeout(runRecognize(preproc, 'buffer', langs), 30000, `OCR (${langs})`);
    const slim = {
      text: (data.text || ''),
      blocks: (data.blocks || []).map(b => ({
        bbox: b.bbox, confidence: Math.round(b.confidence || 0),
        paragraphs: (b.paragraphs || []).map(p => ({
          bbox: p.bbox, confidence: Math.round(p.confidence || 0),
          lines: (p.lines || []).map(l => ({
            bbox: l.bbox, confidence: Math.round(l.confidence || 0), text: (l.text || '').trim()
          }))
        }))
      })),
      meta: { width, height, mean, langsUsed: langs }
    };

    writeLog(`OCR structured ok langs=${langs} blocks=${slim.blocks.length} totalMs=${Date.now()-t0} textLen=${slim.text.length}`);
    return { ok: true, data: slim };
  } catch (e) {
    const msg = e?.message || String(e); writeLog(`OCR error: ${e?.stack || msg}`);
    return { ok: false, error: msg };
  }
});

/* ====== OLLAMA ====== */
ipcMain.handle('ask:ollama', async (_evt, { prompt, model }) => {
  const t0 = Date.now(); const url = 'http://127.0.0.1:11434/api/generate';
  try {
    const ac = new AbortController(); const abortIn = setTimeout(()=>ac.abort(), 30000);
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model, prompt, stream:true }), signal: ac.signal });
    clearTimeout(abortIn);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const text = await res.text();
    return { ok: true, jsonl: text };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
});

ipcMain.handle('llm:generate', async (_evt, { prompt, model }) => {
  const url = 'http://127.0.0.1:11434/api/generate';
  try {
    const ac = new AbortController();
    const abortIn = setTimeout(() => ac.abort(), 12000); // <<< timeout curto
    const res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model, prompt, stream:false }),
      signal: ac.signal
    });
    clearTimeout(abortIn);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const json = await res.json();
    return { ok: true, data: json.response || '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
