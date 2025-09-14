// @ts-nocheck
const { parentPort } = require('node:worker_threads');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const inflight = new Map(); // id -> { cancelled: bool }

parentPort.on('message', async (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'cancel') {
      const it = inflight.get(msg.id);
      if (it) it.cancelled = true;
      return;
    }

    if (msg.type === 'ocr') {
      const { id, payload } = msg;
      inflight.set(id, { cancelled: false });

      const { b64, langs = 'eng+por', tessDir } = payload || {};
      if (!b64) return done(id, false, null, 'b64 vazio');

      const original = Buffer.from(b64, 'base64');

      try {
        const variants = await buildVariants(original);
        let best = { text: '', conf: 0, name: '' };

        for (const { name, buf } of variants) {
          const { text, confidence } = await recognize(buf, langs, tessDir);
          if ((confidence || 0) > best.conf) best = { text, conf: confidence || 0, name };
          const it = inflight.get(id); if (it?.cancelled) return done(id, false, null, 'cancelado');
        }

        const highlights = (best.text.match(/(Error|Exception|Trace|^\s*at\s+.+)/gim) || []).slice(0, 12).join('\n');
        done(id, true, { text: best.text, highlights }, null);
      } catch (e) {
        done(id, false, null, e?.message || String(e));
      } finally {
        inflight.delete(id);
      }
    }
  } catch (e) {
    try { done(msg?.id || '0', false, null, e?.message || String(e)); } catch {}
  }
});

async function buildVariants(buf) {
  // limita tamanho e melhora contraste
  const meta = await sharp(buf).metadata().catch(()=>({}));
  const w = Math.max(1200, Math.min(2200, (meta.width || 1200) * 1.6));
  const base = await sharp(buf).resize({ width: Math.round(w) }).grayscale().normalize().toBuffer();

  // v0: base nítida
  const v0 = await sharp(base).sharpen({ sigma: 1.0 }).png({ compressionLevel: 9 }).toBuffer();

  // v1: limiarização leve
  const v1 = await sharp(base).threshold(165).png({ compressionLevel: 9 }).toBuffer();

  return [
    { name: 'sharp', buf: v0 },
    { name: 'th165', buf: v1 }
  ];
}

async function recognize(imageBuf, langs, tessDir) {
  const res = await Tesseract.recognize(imageBuf, langs, { langPath: tessDir, logger: () => {} });
  return { text: res?.data?.text || '', confidence: res?.data?.confidence || 0 };
}

function done(id, ok, data, error) { parentPort.postMessage({ id, ok, data, error }); }
