// renderer.js — captura via hotkeys → OCR → LLM (Ollama) → JSON patch → render

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const modelEl = $("model");
const langEl = $("language");
const feedEl = $("feed");

let lastText = "";
let lastOcrStruct = null;

function status(t) { statusEl.textContent = t; }

/* ===== Wheel fallback ===== */
window.addEventListener('wheel', (e) => {
  if (e.target.closest('select, input, textarea')) return;
  window.scrollBy({ top: e.deltaY, behavior: 'auto' });
}, { passive: true });

/* ===== Overlay OCR ===== */
const BLOCK_HUES = [200, 140, 60, 0, 280, 320, 100, 20];
const blockColor = (i, a=0.35) => `hsla(${BLOCK_HUES[i % BLOCK_HUES.length]},85%,55%,${a})`;

function ensureOverlay(card, b64) {
  const olds = card.querySelectorAll('.overlay-wrap');
  olds.forEach(n => n.remove());

  const wrap = document.createElement('div');
  wrap.className = 'overlay-wrap';

  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = `data:image/png;base64,${b64}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'thumb-overlay';
  const ctx = canvas.getContext('2d');

  wrap.appendChild(img);
  wrap.appendChild(canvas);
  card.insertBefore(wrap, card.children[1]); // fica no lugar do antigo thumb
  return { wrap, img, canvas, ctx };
}

function drawBlocks({ img, canvas, ctx }, ocrData) {
  if (!ocrData?.blocks) return;

  // garante medidas do IMG renderizado
  const r = img.getBoundingClientRect();
  const dispW = Math.max(1, Math.floor(r.width || img.clientWidth || img.naturalWidth));
  const dispH = Math.max(1, Math.floor(r.height || (img.naturalHeight * (dispW / img.naturalWidth))));

  canvas.width = dispW;
  canvas.height = dispH;
  ctx.clearRect(0,0,dispW,dispH);

  const natW = img.naturalWidth || dispW;
  const natH = img.naturalHeight || dispH;
  const ratioX = dispW / natW;
  const ratioY = dispH / natH;

  ocrData.blocks.forEach((b,i)=>{
    const { x0,y0,x1,y1 } = b.bbox || {};
    if ([x0,y0,x1,y1].some(v=>typeof v!=='number')) return;
    const x = x0*ratioX, y = y0*ratioY, w = (x1-x0)*ratioX, h=(y1-y0)*ratioY;
    ctx.fillStyle = blockColor(i, .32); ctx.fillRect(x,y,w,h);
    ctx.lineWidth = 1; ctx.strokeStyle='rgba(255,255,255,.6)'; ctx.strokeRect(x,y,w,h);
  });
}

/* ===== OCR ===== */
async function ocrBase64Png(b64) {
  status("OCR local…");
  const res = await window.bridge.ocrPng(b64, "eng+por");
  if (!res?.ok) throw new Error(res?.error || "Falha no OCR");
  lastOcrStruct = res.data || null;
  return res.data?.text || "";
}

/* ===== Normalizações ===== */
function normalizeOcr(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/[“”]/g, '"').replace(/[’‘]/g, "'");
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/\bparselnt\b/gi, 'parseInt');
  s = s.replace(/\bconsole[,\.]\s*log\b/gi, 'console.log');
  s = s.replace(/\breadline\s*\(\s*\)\s*/gi, 'readline()');
  s = s.replace(/[^\S\r\n]+\|[^\S\r\n]+/g, ' ');
  return s;
}
function langToFence(language) {
  switch ((language || 'auto').toLowerCase()) {
    case 'javascript': return 'javascript';
    case 'typescript': return 'typescript';
    case 'python':     return 'python';
    case 'java':       return 'java';
    case 'cpp':        return 'cpp';
    default:           return 'javascript';
  }
}

/* ===== Prompt ===== */
function buildPrompt(rawText, language) {
  const text = normalizeOcr(rawText);
  const langHint = (language && language !== 'auto')
    ? `A linguagem alvo é **${language}**.`
    : `Detecte a linguagem apropriada; em caso de dúvida, **use JavaScript**.`;

  return `
Responda **SEMPRE** em português do Brasil (pt-BR). Corrija silenciosamente ruídos de OCR (parselnt→parseInt, console, log→console.log, etc).

${langHint}

Retorne um JSON com:
- descricao (1–2 frases explicando a questão),
- questao (frase objetiva),
- linguagem (ex.: JavaScript, Python…),
- codigo (apenas o código final, pronto para colar; sem comentários).

Texto OCR (para contexto):
\`\`\`text
${text}
\`\`\`
`.trim();
}

/* ===== UI ===== */
function pushItem({ thumb, ocr, answer, metaText }){
  const wrap = document.createElement("div");
  wrap.className = "item";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = metaText || "";
  wrap.appendChild(meta);

  // espaço para overlay vir aqui (ensureOverlay insere)

  const preOCR = document.createElement("pre");
  preOCR.textContent = ocr ?? "OCR pendente…";
  wrap.appendChild(preOCR);

  const ans = document.createElement("div");
  ans.className = "answer markdown-body";
  ans.textContent = answer ?? "Gerando resposta estruturada…";
  wrap.appendChild(ans);

  feedEl.prepend(wrap);
  requestAnimationFrame(()=>{ try{ wrap.scrollIntoView({behavior:'smooth',block:'start'});}catch{} });
  return { preOCR, ans, wrap };
}

function renderMarkdownInto(el, markdownText){
  const html = (window.marked ? window.marked.parse(markdownText || '*vazio*') : (markdownText || '*vazio*'));
  el.innerHTML = html;
  if (window.hljs) el.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
}

/* ===== Fluxo principal ===== */
window.bridge.onStatus((msg) => status(msg));

window.bridge.onShot(async (payload) => {
  try {
    const { id, b64 } = payload || {};
    if (!b64) { status("Erro: screenshot vazio"); return; }

    const metaText = `Capturado às ${new Date().toLocaleTimeString()} • Modelo: ${modelEl.value} • Linguagem: ${langEl.value} • id=${id}`;
    const { preOCR, ans, wrap } = pushItem({
      ocr: "OCR pendente…",
      answer: "Gerando resposta estruturada…",
      metaText,
    });

    // OCR
    let rawText;
    try {
      rawText = await ocrBase64Png(b64);
    } catch (e) {
      const msg = e?.message || e;
      preOCR.textContent = "Falha no OCR: " + msg;
      ans.textContent = "Abortado porque o OCR falhou.";
      status("Falha no OCR.");
      return;
    }

    // Overlay responsivo
    const refs = ensureOverlay(wrap, b64);
    await new Promise((r) => {
      if (refs.img.complete && refs.img.naturalWidth > 0) return r();
      refs.img.onload = () => r();
      refs.img.onerror = () => r();
    });

    const normalized = normalizeOcr(rawText || '');
    lastText = normalized;
    preOCR.textContent = normalized || "(vazio)";

    if (lastOcrStruct?.blocks?.length) drawBlocks(refs, lastOcrStruct);

    // Prompt → PATCH JSON (Ollama)
    const prompt = buildPrompt(lastText, langEl.value);
    status('Perguntando ao LLM (Ollama)…');
    const res = await window.bridge.generatePatch({ prompt, model: modelEl.value });
    if (!res?.ok) {
      ans.textContent = 'Falha ao gerar patch: ' + (res?.error || 'erro desconhecido');
      status('Falha ao gerar patch.');
      return;
    }
    const patch = res.patch || {};
    const fence = langToFence(patch.linguagem || langEl.value);

    const md = [
      `## Explicação`,
      `${patch.descricao || '_sem descrição_'}`,
      ``,
      `**Pergunta:** ${patch.questao || '_?_'}  `,
      `**Linguagem:** ${patch.linguagem || (langEl.value || 'auto')}`,
      ``,
      `## Código gerado`,
      '```' + fence,
      patch.codigo || '',
      '```'
    ].join('\n');

    renderMarkdownInto(ans, md);
    status('Resposta concluída.');
  } catch (e) {
    const msg = e?.message || e;
    window.bridge.sendStatus("renderer: erro no onShot " + msg);
    status("Falha ao processar screenshot: " + msg);
  }
});

/* ===== Ctrl+Enter: reprocessa ===== */
window.bridge.onSolve(async () => {
  if (!lastText || !lastText.trim()) { status("Sem conteúdo do OCR para resolver. Capture a tela primeiro."); return; }
  const { ans } = pushItem({ ocr: "Usando OCR do último item.", answer: "Gerando resposta…", metaText: `Resposta manual • Modelo: ${modelEl.value}` });
  const prompt = buildPrompt(lastText, langEl.value);
  const res = await window.bridge.generatePatch({ prompt, model: modelEl.value });
  if (!res?.ok) { ans.textContent = 'Falha ao gerar patch: ' + (res?.error || 'erro desconhecido'); status('Falha ao gerar patch.'); return; }
  const p = res.patch || {};
  const fence = langToFence(p.linguagem || langEl.value);
  const md = [
    `## Explicação`,
    `${p.descricao || '_sem descrição_'}`,
    ``,
    `**Pergunta:** ${p.questao || '_?_'}  `,
    `**Linguagem:** ${p.linguagem || (langEl.value || 'auto')}`,
    ``,
    `## Código gerado`,
    '```' + fence,
    p.codigo || '',
    '```'
  ].join('\n');
  renderMarkdownInto(ans, md);
  status('Resposta concluída.');
});

window.bridge.onReset(() => { lastText = ""; lastOcrStruct = null; status("Contexto limpo. Capture com Ctrl+1/2/H."); });

status("Pronto • Capture com Ctrl+1/2/H • Ctrl+Enter reprocessa");
window.bridge?.sendStatus?.("RENDERER: pronto");
