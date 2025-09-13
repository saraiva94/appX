// renderer.js — PT-BR + Markdown + highlight + geração progressiva via JSONL

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const modelEl = $("model");
const langEl = $("language");
const feedEl = $("feed");

let lastText = "";

function status(t) { statusEl.textContent = t; }

/* ===================== OCR ===================== */
async function ocrBase64Png(b64) {
  status("OCR local…");
  window.bridge.sendStatus(`OCR: iniciando len=${b64?.length || 0}`);
  const res = await window.bridge.ocrPng(b64, "eng+por");
  window.bridge.sendStatus(`OCR: resposta ok=${res?.ok} err=${res?.error || "n/a"} len=${res?.text?.length || 0}`);
  if (!res?.ok) throw new Error(res?.error || "Falha no OCR");
  return res.text || "";
}

/* ======== Normalizações de OCR (foco no Codingame Onboarding) ======== */
function normalizeOcr(text) {
  if (!text) return '';
  let s = text;

  // Simbolos e pontuação
  s = s.replace(/[“”]/g, '"').replace(/[’‘]/g, "'");
  s = s.replace(/\u00A0/g, ' '); // NBSP

  // Trocas comuns (vírgula/ponto; l/1; O/0 etc.)
  s = s.replace(/\bparselnt\b/gi, 'parseInt');
  s = s.replace(/\bconsole[,\.]\s*log\b/gi, 'console.log');
  s = s.replace(/\breadline\s*\(\s*\)\s*/gi, 'readline()');
  s = s.replace(/\benemyl\b/gi, 'enemy1');
  s = s.replace(/\benemy\?\b/gi, 'enemy2');
  s = s.replace(/\bdistl\b/gi, 'dist1');
  s = s.replace(/\bdist\?\b/gi, 'dist2');

  // Lixo visual de colunas/separadores
  s = s.replace(/[^\S\r\n]+\|[^\S\r\n]+/g, ' ');

  return s;
}

function isCodingameOnboarding(t) {
  const L = (t || '').toLowerCase();
  const hits = [
    'codingame.com/ide/puzzle/onboarding',
    'time to code',
    'closest alien',
    'var enemy1',
    'var dist1',
    'console.log'
  ];
  return hits.some(h => L.includes(h));
}

function langToFence(language) {
  switch ((language || 'auto').toLowerCase()) {
    case 'javascript': return 'javascript';
    case 'typescript': return 'typescript';
    case 'python':     return 'python';
    case 'java':       return 'java';
    case 'cpp':        return 'cpp';
    default:           return 'javascript'; // fallback
  }
}

/* ===================== Prompt estruturado (PT-BR) ===================== */
function buildPrompt(rawText, language) {
  const text = normalizeOcr(rawText);
  const fence = langToFence(language);

  const langHint = (language && language !== 'auto')
    ? `A linguagem alvo é **${language}**.`
    : `Detecte a linguagem apropriada; em caso de dúvida, **use JavaScript**.`;

  let bonusContext = '';
  if (isCodingameOnboarding(text)) {
    bonusContext =
`Contexto (CodinGame - Onboarding “shoot the closest alien”):
- Entrada por turno: enemy1 (string), dist1 (int), enemy2 (string), dist2 (int).
- Objetivo: imprimir **apenas** o nome do inimigo mais próximo com \`console.log\`.`;
  }

  return `
Responda **SEMPRE** em português do Brasil (pt-BR). Corrija silenciosamente ruídos típicos de OCR (parselnt→parseInt, console, log→console.log, etc).

${langHint}
${bonusContext ? '\n' + bonusContext + '\n' : ''}

FORMATO OBRIGATÓRIO (Markdown):
# Enunciado (corrigido)
(1–3 frases, sem delírios)

# Análise
- O que é pedido
- Pontos de atenção e casos de borda
- Estratégia

# Solução (código)
\`\`\`${fence}
// coloque apenas o código final, pronto para colar
\`\`\`

# Explicação
- Como o código resolve o problema
- Complexidade (se fizer sentido)

# Como testar
- Passos e exemplos

=== Texto OCR bruto (anexo) ===
\`\`\`text
${text}
\`\`\`
`.trim();
}

/* ===================== UI helpers ===================== */
function pushItem({ thumb, ocr, answer, metaText }){
  const wrap = document.createElement("div");
  wrap.className = "item";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = metaText || "";
  wrap.appendChild(meta);

  if (thumb) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = `data:image/png;base64,${thumb}`;
    wrap.appendChild(img);
  }

  const preOCR = document.createElement("pre");
  preOCR.textContent = ocr ?? "OCR pendente…";
  wrap.appendChild(preOCR);

  const ans = document.createElement("div");
  ans.className = "answer markdown-body";
  ans.textContent = answer ?? "Gerando resposta estruturada…";
  wrap.appendChild(ans);

  feedEl.prepend(wrap);
  return { preOCR, ans };
}

/* ===================== renderização Markdown ===================== */
function renderMarkdownInto(el, markdownText){
  const text = markdownText || '*(vazio)*';
  const html = (window.marked ? window.marked.parse(text) : text);
  el.innerHTML = html;
  if (window.hljs) {
    el.querySelectorAll('pre code').forEach((block) => window.hljs.highlightElement(block));
  }
}

/* ===================== chamada ao modelo (progressiva) ===================== */
async function askModelInto(containerEl, prompt, modelName) {
  let acc = '';
  containerEl.classList.add('markdown-body');
  try {
    status('Consultando modelo local…');
    const { chunks } = await window.bridge.askOllama({ model: modelName, prompt });
    for await (const piece of chunks) {
      acc += piece;
      containerEl.innerHTML = (window.marked ? window.marked.parse(acc) : acc);
      if (window.hljs) containerEl.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
    }
    status('Resposta concluída.');
  } catch (e) {
    const msg = e?.message || String(e);
    window.bridge.sendStatus('Modelo: erro ' + msg);
    containerEl.textContent = 'Falha ao consultar o modelo: ' + msg;
    status('Falha ao consultar o modelo.');
  }
}

/* ===================== fluxo: screenshot -> OCR -> modelo ===================== */
window.bridge.onStatus((msg) => status(msg));

window.bridge.onShot(async (payload) => {
  try {
    const { id, b64, file } = payload || {};
    window.bridge.sendStatus(`renderer: got shot id=${id} len=${b64 ? b64.length : 0} file=${file || "n/a"}`);
    if (!b64) { status("Erro: screenshot vazio"); return; }

    const metaText = `Capturado às ${new Date().toLocaleTimeString()} • Modelo: ${modelEl.value} • Linguagem: ${langEl.value} • id=${id}`;
    const { preOCR, ans } = pushItem({
      thumb: b64,
      ocr: "OCR pendente…",
      answer: "Gerando resposta estruturada…",
      metaText,
    });

    // 1) OCR
    let rawText;
    try {
      rawText = await ocrBase64Png(b64);
      const normalized = normalizeOcr(rawText || '');
      lastText = normalized;
      preOCR.textContent = normalized || "(vazio)";
      window.bridge.sendStatus(
        `renderer: OCR ok id=${id} rawLen=${rawText ? rawText.length : 0} normLen=${normalized.length}`
      );
      if ((normalized || '').length < 40) {
        window.bridge.sendStatus('OCR com baixa confiança: texto curto após normalização');
      }
      status("OCR concluído. Gerando solução…");
    } catch (e) {
      const msg = e?.message || e;
      preOCR.textContent = "Falha no OCR: " + msg;
      ans.textContent = "Abortado porque o OCR falhou.";
      window.bridge.sendStatus(`renderer: OCR FAIL id=${id} err=${msg}`);
      status("Falha no OCR.");
      return;
    }

    // 2) Modelo — sempre PT-BR, seções fixas e code fence de acordo com seleção
    const prompt = buildPrompt(lastText, langEl.value);
    await askModelInto(ans, prompt, modelEl.value);
  } catch (e) {
    const msg = e?.message || e;
    window.bridge.sendStatus("renderer: erro no onShot " + msg);
    status("Falha ao processar screenshot: " + msg);
  }
});

/* ===================== atalhos mantidos ===================== */
window.bridge.onSolve(async () => {
  if (!lastText || !lastText.trim()) {
    status("Sem conteúdo do OCR para resolver. Capture a tela primeiro.");
    return;
  }
  const { ans } = pushItem({
    thumb: null,
    ocr: "Usando OCR do último item.",
    answer: "Gerando resposta…",
    metaText: `Resposta manual • Modelo: ${modelEl.value}`,
  });
  const prompt = buildPrompt(lastText, langEl.value);
  await askModelInto(ans, prompt, modelEl.value);
});

window.bridge.onReset(() => {
  lastText = "";
  status("Contexto limpo. Capture com Ctrl+1/2/H.");
});

// boot
status("Pronto • Capture com Ctrl+1/2/H");
window.bridge?.sendStatus?.("RENDERER: pronto");
