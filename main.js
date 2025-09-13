// @ts-nocheck
const {
  app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, nativeImage, screen, desktopCapturer
} = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => globalThis.fetch(...args);

// OCR no processo principal
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

let win, tray;
const STEP = 20;
let translucent = false;

/* =========================
 *  PASTAS / LOG
 * ========================= */
const ASSETS = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, 'assets');

const appData = app.getPath('appData');
const userDir = path.join(appData, 'appx');
app.setName('appx');
app.setPath('userData', userDir);
fs.mkdirSync(userDir, { recursive: true });

const LOG = path.join(app.getPath('userData'), 'copiloto.log');
function writeLog(line) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {}
}
function sendStatus(msg) { writeLog(`STATUS ${msg}`); if (win) win.webContents.send('status', msg); }

function dumpFile(buf, hint = 'x') {
  try {
    const fname = path.join(app.getPath('userData'), `${hint}-${Date.now()}.png`);
    fs.writeFileSync(fname, buf);
    writeLog(`DUMP wrote ${fname} size=${buf.length}`);
    return fname;
  } catch (e) {
    writeLog(`DUMP failed: ${e?.message || e}`);
    return null;
  }
}

function bringToFront() {
  if (!win) return;
  win.setAlwaysOnTop(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.moveTop(); win.show(); win.focus();
}

/* =========================
 *  JANELA
 * ========================= */
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  // Oculta a janela em screen-share
  win.setContentProtection(true);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { bringToFront(); setTimeout(bringToFront, 300); });
  win.on('focus', bringToFront);
  win.on('blur',  bringToFront);
}

/* =========================
 *  CAPTURA
 * ========================= */
async function captureDisplayPNGByDisplayId(displayId) {
  try {
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

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: target
    });
    const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) throw new Error('Nenhuma fonte de tela encontrada');

    const png = source.thumbnail.toPNG();
    writeLog(`CAPTURE ok bytes=${png.length}`);
    return png;
  } catch (e) {
    writeLog(`CAPTURE ERROR ${e?.stack || e}`);
    throw e;
  }
}

async function captureDisplayByIndex(idx) {
  try {
    const displays = screen.getAllDisplays();
    if (!displays[idx]) return sendStatus(`Monitor ${idx + 1} não encontrado.`);
    const png = await captureDisplayPNGByDisplayId(displays[idx].id);
    emitShot(png, `monitor-${idx + 1}`);
  } catch (err) {
    sendStatus(`Erro ao capturar monitor ${idx + 1}: ${err?.message || err}`);
  }
}

async function captureDisplayUnderCursor() {
  try {
    const cursor = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(cursor);
    const png = await captureDisplayPNGByDisplayId(disp.id);
    emitShot(png, `cursor-${disp.id}`);
  } catch (err) {
    sendStatus(`Erro ao capturar tela do cursor: ${err?.message || err}`);
  }
}

/* =========================
 *  ENVIO / ACK
 * ========================= */
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
    writeLog(`ACK TIMEOUT id=${id} (renderer não confirmou recebimento)`);
    sendStatus(`Falha ao entregar screenshot (id=${id}) — veja logs.`);
    pendingAcks.delete(id);
  }, 5000);
  pendingAcks.set(id, t);
}

/* =========================
 *  APP READY / ATALHOS
 * ========================= */
app.whenReady().then(() => {
  app.setAppUserModelId('meu.copiloto.local');
  createWindow();

  const reg = (combo, fn) => {
    const variants = [combo];
    if (combo.startsWith('Ctrl+')) variants.push(
      combo.replace('Ctrl+','Control+'),
      combo.replace('Ctrl+','CommandOrControl+')
    );
    let okOne = false;
    for (const acc of variants) {
      try {
        const ok = globalShortcut.register(acc, async () => {
          sendStatus(`Atalho: ${acc}`); writeLog(`TRIGGER ${acc}`);
          try { await fn(); } catch (err) {
            sendStatus(`Erro no handler ${acc}: ${err?.message || err}`);
            writeLog(`HANDLER ERROR ${acc}: ${err?.stack || err}`);
          }
        });
        writeLog(`REGISTER ${acc}: ${ok}`);
        if (ok) { okOne = true; break; }
      } catch (err) { writeLog(`REGISTER EXC ${acc}: ${err?.message}`); }
    }
    if (!okOne) { sendStatus(`Atalho não registrado: ${combo}`); writeLog(`REGISTER FAIL base=${combo}`); }
  };

  const THROTTLE_MS = 600, last = {};
  const once = (k, fn) => () => {
    const now = Date.now();
    if (last[k] && now - last[k] < THROTTLE_MS) { writeLog(`THROTTLED ${k}`); return; }
    last[k] = now; fn();
  };

  reg('Ctrl+Q', () => bringToFront());
  reg('Ctrl+1',  once('Ctrl+1',  () => captureDisplayByIndex(0)));
  reg('Ctrl+2',  once('Ctrl+2',  () => captureDisplayByIndex(1)));
  reg('Ctrl+H',  once('Ctrl+H',  () => captureDisplayUnderCursor()));
  reg('Ctrl+F1', once('Ctrl+F1', () => captureDisplayByIndex(0)));
  reg('Ctrl+F2', once('Ctrl+F2', () => captureDisplayByIndex(1)));
  reg('PrintScreen', once('PrintScreen', () => captureDisplayUnderCursor()));
  reg('Alt+H', once('Alt+H', () => captureDisplayUnderCursor()));

  reg('Ctrl+Enter', () => { if (win) win.webContents.send('solve:run'); });
  reg('Ctrl+G',     () => { if (win) win.webContents.send('ctx:reset'); });

  const nudge = (dx,dy)=>{ if(!win) return; const [x,y]=win.getPosition(); win.setPosition(x+dx,y+dy); };
  const regMove = (c,dx,dy)=>{ const ok=globalShortcut.register(c, ()=>nudge(dx,dy)); if(!ok){ sendStatus(`Atalho não registrado: ${c}`); writeLog(`MOVE FAIL ${c}`);} };
  regMove('Ctrl+Up',0,-STEP); regMove('Ctrl+Down',0,STEP); regMove('Ctrl+Left',-STEP,0); regMove('Ctrl+Right',STEP,0);
  regMove('Ctrl+Alt+Up',0,-STEP); regMove('Ctrl+Alt+Down',0,STEP); regMove('Ctrl+Alt+Left',-STEP,0); regMove('Ctrl+Alt+Right',STEP,0);
  regMove('Ctrl+Alt+W',0,-STEP); regMove('Ctrl+Alt+S',0,STEP); regMove('Ctrl+Alt+A',-STEP,0); regMove('Ctrl+Alt+D',STEP,0);

  reg('Ctrl+3', () => { if(!win) return; translucent=!translucent; win.setOpacity(translucent?0.6:1.0); sendStatus(translucent? 'Transparente ON':'Transparente OFF'); });
  reg('Ctrl+4', () => app.quit());

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
        }
      },
      { label: 'Abrir DevTools', click: () => { if (win) win.webContents.openDevTools({ mode: 'detach' }); } },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ]));
  } catch (e) { writeLog(`TRAY error: ${e?.message || e}`); }

  reg('Ctrl+Shift+I', () => { if (win) win.webContents.openDevTools({ mode: 'detach' }); });

  writeLog('App started');
  sendStatus(`Logs em: ${LOG}`);
});

/* =========================
 *  ACK / STATUS
 * ========================= */
ipcMain.on('shot:ack', (_e, { id, info }) => {
  writeLog(`ACK id=${id} info=${info || ''}`);
  const t = pendingAcks.get(id);
  if (t){ clearTimeout(t); pendingAcks.delete(id); }
});
ipcMain.on('status', (_e, msg) => writeLog(`RENDERER ${msg}`));

// ---------- OLLAMA (retorno em JSONL texto, sem stream pelo IPC) ----------
ipcMain.handle('ask:ollama', async (_evt, { prompt, model }) => {
  const t0 = Date.now();
  try {
    const url = 'http://127.0.0.1:11434/api/generate';
    const body = JSON.stringify({ model, prompt, stream: true }); // Ollama manda JSONL
    writeLog(`OLLAMA request model=${model} len=${prompt?.length || 0}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    // >>> AQUI É O PULO DO GATO: pegar TUDO como texto, nada de res.body no IPC <<<
    const text = await res.text(); // linhas JSON (JSONL)
    writeLog(`OLLAMA ok bytes=${text.length} ms=${Date.now() - t0}`);
    return { ok: true, jsonl: text };
  } catch (e) {
    writeLog(`OLLAMA error: ${e?.stack || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
});

/* =========================
 *  OCR: 1 tentativa + multi-variante
 * ========================= */
ipcMain.handle('ocr:png', async (_evt, { b64, langs = 'eng+por' }) => {
  const t0 = Date.now();
  try {
    if (!b64) throw new Error('Base64 vazio');
    writeLog(`OCR start langs=${langs} b64len=${b64.length}`);

    const original = Buffer.from(b64, 'base64');

    // meta
    let width=0, height=0, mean=128;
    try {
      const meta = await sharp(original).metadata();
      width = meta.width || 0; height = meta.height || 0;
      const st = await sharp(original).stats();
      const r = st.channels?.[0]?.mean ?? 128;
      const g = st.channels?.[1]?.mean ?? 128;
      const b = st.channels?.[2]?.mean ?? 128;
      mean = Math.round((r + g + b) / 3);
      writeLog(`OCR img meta ${width}x${height} mean=${mean}`);
    } catch (e) {
      writeLog(`OCR stats FAIL: ${e?.message || e}`);
    }

    const targetW = Math.min(4096, Math.max(1800, Math.round((width || 1200) * 2)));
    writeLog(`OCR upscale targetW=${targetW}`);

    // variantes
    const variants = [];

    // v0: sem limiar
    const v0 = await sharp(original)
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale().normalize().median(1).sharpen({ sigma: 1.2 })
      .png({ compressionLevel: 9 }).toBuffer();
    dumpFile(v0, 'preproc-v0-no-threshold');
    writeLog(`OCR variant v0-no-threshold ok bytes=${v0.length}`);
    variants.push({ name:'v0-no-threshold', buf:v0 });

    // v1: claro
    const v1 = await sharp(original)
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale().normalize().median(1).gamma(1.1).threshold(160)
      .png({ compressionLevel: 9 }).toBuffer();
    dumpFile(v1, 'preproc-v1-light-th160');
    writeLog(`OCR variant v1-light-th160 ok bytes=${v1.length}`);
    variants.push({ name:'v1-light-th160', buf:v1 });

    // v2: escuro
    const v2 = await sharp(original)
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale().normalize().median(1).negate().gamma(1.1).threshold(200)
      .png({ compressionLevel: 9 }).toBuffer();
    dumpFile(v2, 'preproc-v2-dark-neg-th200');
    writeLog(`OCR variant v2-dark-neg-th200 ok bytes=${v2.length}`);
    variants.push({ name:'v2-dark-neg-th200', buf:v2 });

    // v3: sharp
    const v3 = await sharp(original)
      .resize({ width: targetW, withoutEnlargement: false })
      .grayscale().normalize().median(1).sharpen({ sigma: 1.2 })
      .png({ compressionLevel: 9 }).toBuffer();
    dumpFile(v3, 'preproc-v3-sharp12');
    writeLog(`OCR variant v3-sharp12 ok bytes=${v3.length}`);
    variants.push({ name:'v3-sharp12', buf:v3 });

    // roda tesseract nas variantes (psm6 e psm13) e escolhe melhor
    let best = { name:'', text:'', conf:0, ms:0 };
    for (const { name, buf } of variants) {
      for (const psm of [6, 13]) {
        const t1 = Date.now();
        const worker = await Tesseract.createWorker();
        await worker.loadLanguage(langs);
        await worker.initialize(langs);
        await worker.setParameters({
          tessedit_ocr_engine_mode: '1',
          tessedit_pageseg_mode: String(psm),
          user_defined_dpi: '300',
          preserve_interword_spaces: '1',
          tessedit_char_whitelist:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÂÃÀÉÊÍÎÓÔÕÚÜÇáâãàéêíîóôõúüç' +
            '0123456789_+-*/=<>(){}[];:,.!?"\'|\\&%#@ \n\t'
        });
        const { data: { text, confidence } } = await worker.recognize(buf);
        await worker.terminate();
        const ms = Date.now() - t1;
        writeLog(`OCR ${name}+psm${psm}: len=${(text||'').length} conf=${Math.round(confidence||0)} ms=${ms}`);
        if ((confidence || 0) > best.conf) best = { name:`${name}+psm${psm}`, text:text||'', conf:confidence||0, ms };
      }
    }

    writeLog(`OCR best=${best.name} len=${best.text.length} conf=${Math.round(best.conf)} totalMs=${Date.now()-t0}`);
    return { ok: true, text: best.text };
  } catch (e) {
    const dur = Date.now() - t0;
    const msg = e?.message || String(e);
    writeLog(`OCR error (${dur}ms): ${e?.stack || msg}`);
    return { ok: false, error: msg };
  }c
});

/* =========================
 *  TESTE RÁPIDO
 * ========================= */
app.whenReady().then(() => {
  globalShortcut.register('Ctrl+T', async () => {
    try {
      writeLog('TEST Ctrl+T start');
      const png = await captureDisplayPNGByDisplayId(screen.getPrimaryDisplay().id);
      emitShot(png, 'ctrlT');
    } catch (e) {
      sendStatus('Teste falhou: ' + (e?.message || e));
    }
  });
  writeLog('Hotkey Ctrl+T ready');
});

app.on('will-quit', () => globalShortcut.unregisterAll());
