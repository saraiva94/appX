// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron');

// Ping
try { ipcRenderer.send('status', 'PRELOAD: carregou (sandbox=false)'); } catch {}

/* Buffer de screenshots até o renderer assinar */
const pendingShots = [];
let shotSubscriber = null;

/* Recebe screenshot do main e responde ACK */
ipcRenderer.on('shot:image', (_e, payloadIn) => {
  const payload = (typeof payloadIn === 'string')
    ? { id: undefined, b64: payloadIn, file: null }
    : (payloadIn || {});
  const len = payload?.b64 ? payload.b64.length : 0;

  try { ipcRenderer.send('shot:ack', { id: payload.id, info: `len=${len}` }); } catch {}
  try { ipcRenderer.send('status', `PRELOAD: shot recebido id=${payload.id} len=${len}`); } catch {}

  if (shotSubscriber) {
    try { shotSubscriber(payload); } catch (e) {
      try { ipcRenderer.send('status', 'PRELOAD: erro ao chamar subscriber: ' + (e?.message || e)); } catch {}
    }
  } else {
    pendingShots.push(payload);
    try { ipcRenderer.send('status', `PRELOAD: sem subscriber, bufferizando id=${payload.id}`); } catch {}
  }
});

// carrega adaptador Ollama (CommonJS) e expõe via bridge
let _generatePatch = null;
try {
  _generatePatch = require('./llm-ollama.js').generatePatch;
} catch (e) {
  try { ipcRenderer.send('status', 'PRELOAD: erro ao carregar llm-ollama.js: ' + (e?.message || e)); } catch {}
}

contextBridge.exposeInMainWorld('bridge', {
  onShot: (cb) => {
    try {
      shotSubscriber = cb;
      ipcRenderer.send('status', 'PRELOAD: subscriber registrado');
      while (pendingShots.length) {
        const p = pendingShots.shift();
        try { cb(p); } catch {}
      }
    } catch (e) {
      try { ipcRenderer.send('status', 'PRELOAD: erro no onShot: ' + (e?.message || e)); } catch {}
    }
  },

  onReset:  (cb) => ipcRenderer.on('ctx:reset', cb),
  onSolve:  (cb) => ipcRenderer.on('solve:run', cb),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  sendStatus: (msg) => ipcRenderer.send('status', msg),

  // Ollama (stream bruto). Ainda exposto se quiser usar preview.
  askOllama: async ({ prompt, model }) => {
    const res = await ipcRenderer.invoke('ask:ollama', { prompt, model });
    if (!res?.ok) throw new Error(res?.error || 'Falha no Ollama');

    async function* chunks() {
      const lines = (res.jsonl || '').split('\n');
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          const j = JSON.parse(s);
          if (j?.response) yield j.response;
        } catch {}
      }
    }
    return { chunks: chunks() };
  },

  // OCR em base64
  ocrPng: (b64, langs = 'eng+por') => ipcRenderer.invoke('ocr:png', { b64, langs }),

  // Tessdata path (sync)
  getTessdataPath: () => ipcRenderer.sendSync('tessdataPath'),

  // Diálogos/ocr arquivo (opcional)
  pickImage: async () => ipcRenderer.invoke('pickImage'),
  recognizeImage: async ({ imagePath, whitelist = '' }) => ipcRenderer.invoke('recognizeImage', { imagePath, whitelist }),

  // === NOVO: gera PATCH (JSON) usando o adaptador do Ollama ===
  generatePatch: async ({ prompt, model }) => {
    if (!_generatePatch) throw new Error('llm-ollama.js não foi carregado');
    try {
      const patch = await _generatePatch({ prompt, model });
      return { ok: true, patch };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
});
