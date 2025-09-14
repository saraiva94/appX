// renderer.js — captura via hotkeys → OCR → LLM (Ollama) → PATCH JSON → render

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const modelEl = $("model");
const langEl = $("language");
const feedEl = $("feed");

let lastText = "";
let lastOcrStruct = null;

// === Preferências de debug/visual ===
const SHOW_OCR_DEFAULT = false;
const SHOW_IMAGE_DEFAULT = false;

let showOCR = (() => {
  try { return JSON.parse(localStorage.getItem('showOCR') || String(SHOW_OCR_DEFAULT)); }
  catch { return SHOW_OCR_DEFAULT; }
})();
let showImage = (() => {
  try { return JSON.parse(localStorage.getItem('showImage') || String(SHOW_IMAGE_DEFAULT)); }
  catch { return SHOW_IMAGE_DEFAULT; }
})();

function setShowOCR(v) {
  showOCR = !!v;
  try { localStorage.setItem('showOCR', JSON.stringify(showOCR)); } catch {}
  status(`OCR: ${showOCR ? 'visível' : 'oculto'} • Imagem: ${showImage ? 'visível' : 'oculta'}`);
}
function setShowImage(v) {
  showImage = !!v;
  try { localStorage.setItem('showImage', JSON.stringify(showImage)); } catch {}
  status(`OCR: ${showOCR ? 'visível' : 'oculto'} • Imagem: ${showImage ? 'visível' : 'oculta'}`);
}

function status(t) { statusEl.textContent = t; }

/* ===== Wheel fallback ===== */
window.addEventListener('wheel', (e) => {
  if (e.target.closest('select, input, textarea')) return;
  window.scrollBy({ top: e.deltaY, behavior: 'auto' });
}, { passive: true });

/* ===== Overlay OCR (apenas se imagem estiver habilitada) ===== */
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
  img.setAttribute('draggable', 'false');
  img.tabIndex = -1;

  const canvas = document.createElement('canvas');
  canvas.className = 'thumb-overlay';
  const ctx = canvas.getContext('2d');

  wrap.appendChild(img);
  wrap.appendChild(canvas);
  card.insertBefore(wrap, card.children[1]); // após meta
  return { wrap, img, canvas, ctx };
}

function drawBlocks({ img, canvas, ctx }, ocrData) {
  if (!ocrData?.blocks) return;

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

/* ===== Limpeza agressiva do OCR ===== */
function normalizeOcr(raw) {
  if (!raw) return '';
  let s = raw;

  s = s.replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\u00A0/g, ' ');
  s = s.replace(/\bparselnt\b/gi, 'parseInt');
  s = s.replace(/\bconsole[,\.]\s*log\b/gi, 'console.log');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const drop = [
    /^\s*https?:\/\/\S+/i,
    /^\s*(SKIP\s+TUTORIAL|PREVIOUS\s+STEP|Time to code!|game loop)\s*$/i,
    /^\s*[<>\[\]\(\)\{\}\|\-=_~*•·•]+$/i,
    /^\s*Copy\/Paste.*$/i,
    /^\s*Codingame.*$/i,
    /^\s*CodinGame.*$/i,
    /^\s*Pergunta:\s*$/i,
    /^\s*Linguagem:\s*$/i
  ];

  const lines = s.split('\n')
    .map(l => l.replace(/[^\S\n]+/g, ' ').trimRight())
    .filter(l => {
      if (!l.trim()) return true;
      if (drop.some(rx => rx.test(l))) return false;
      const alnum = (l.match(/[0-9A-Za-z]/g) || []).length;
      return alnum >= Math.ceil(l.length * 0.2);
    });

  s = lines.join('\n').replace(/[^\S\r\n]+\|[^\S\r\n]+/g, ' ');
  s = s.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ')).join('\n');

  return s.trim();
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

/* ===== Prompt (JSON only) ===== */
function buildPrompt(cleanText, language) {
  const langHint = (language && language !== 'auto')
    ? `A linguagem alvo é **${language}**.`
    : `Detecte a linguagem apropriada; em caso de dúvida, **use JavaScript**.`;

  return `
Responda **somente** em **JSON válido** (sem markdown, sem comentários, sem texto fora do JSON).

Esquema:
{
  "descricao": "string (1–2 frases explicando a questão)",
  "questao": "string (frase objetiva da tarefa)",
  "linguagem": "string (ex.: JavaScript, Python, ...)",
  "codigo": "string (APENAS o código final, pronto para colar; sem cercas de markdown)"
}

${langHint}

Texto OCR:
"""
${cleanText}
"""
`.trim();
}

/* ===== UI ===== */
function pushItem({ ocr, answer, metaText }){
  const wrap = document.createElement("div");
  wrap.className = "item";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = metaText || "";
  wrap.appendChild(meta);

  let preOCR = null;
  if (showOCR) {
    preOCR = document.createElement("pre");
    preOCR.textContent = ocr ?? "OCR pendente…";
    wrap.appendChild(preOCR);
  }

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
    let rawText = "";
    try {
      rawText = await ocrBase64Png(b64);
    } catch (e) {
      const msg = e?.message || e;
      if (preOCR) preOCR.textContent = "Falha no OCR: " + msg;
      status("OCR falhou — seguindo sem abortar.");
      // NÃO retorna: prossegue com rawText vazio
      lastOcrStruct = null;
    }

    // (Imagem/overlay) — só se estiver habilitado
    if (showImage) {
      const refs = ensureOverlay(wrap, b64);
      await new Promise((r) => {
        if (refs.img.complete && refs.img.naturalWidth > 0) return r();
        refs.img.onload = () => r();
        refs.img.onerror = () => r();
      });
      if (lastOcrStruct?.blocks?.length) drawBlocks(refs, lastOcrStruct);
    }

    const normalized = normalizeOcr(rawText || '');
    lastText = normalized;
    if (preOCR) preOCR.textContent = normalized || "(vazio)";

    // Prompt → PATCH JSON (Ollama)
    const prompt = buildPrompt(lastText, langEl.value);
    status('Perguntando ao LLM (Ollama)…');
    const res = await window.bridge.generatePatch({ prompt, model: modelEl.value, ocrClean: lastText });
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

/* ===== Reprocessar último OCR ===== */
window.bridge.onSolve(async () => {
  if (!lastText || !lastText.trim()) { status("Sem conteúdo do OCR para resolver. Capture a tela primeiro."); return; }
  const { ans } = pushItem({ ocr: showOCR ? "Usando OCR do último item." : undefined, answer: "Gerando resposta…", metaText: `Resposta manual • Modelo: ${modelEl.value}` });
  const prompt = buildPrompt(lastText, langEl.value);
  const res = await window.bridge.generatePatch({ prompt, model: modelEl.value, ocrClean: lastText });
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

/* ===== Toggles: OCR e IMAGEM ===== */
window.addEventListener('keydown', (ev) => {
  const key = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && key === 'o') {
    setShowOCR(!showOCR);
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && key === 'i') {
    setShowImage(!showImage);
  }
});

window.bridge.onReset(() => { lastText = ""; lastOcrStruct = null; status("Contexto limpo. Capture com Ctrl+1/2/H."); });

status(`Pronto • OCR ${showOCR ? 'visível' : 'oculto'} • Imagem ${showImage ? 'visível' : 'oculta'} • Captura: Ctrl+1/2/H • Resolver: Ctrl+Enter • Toggles: Ctrl+Shift+O / Ctrl+Shift+I`);
window.bridge?.sendStatus?.("RENDERER: pronto");
