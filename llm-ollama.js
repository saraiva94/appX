// llm-ollama.js — usa IPC (window.bridge.askOllama) para falar com o Ollama

(() => {
  const $ = (id) => document.getElementById(id);

  const btn      = $('btn-patch');       // botão "Gerar patch (LLM)"
  const promptEl = $('prompt');          // textarea de prompt
  const expEl    = $('explicacao');      // div onde mostramos a resposta (markdown)
  const codeEl   = $('codeOut');         // opcional: onde extrairíamos só o código
  const copyBtn  = $('copyBtn');         // botão "Copiar"

  if (!btn || !promptEl || !expEl) return; // página sem o painel -> sai quieto

  function setStatus(t){ const s = $('status'); if (s) s.textContent = t; }

  // Renderiza markdown (se marked + hljs estiverem no index.html)
  function renderMarkdownInto(el, text){
    const md = text || '*(vazio)*';
    const html = (window.marked ? window.marked.parse(md) : md);
    el.innerHTML = html;
    if (window.hljs) el.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
  }

  // Extrai o primeiro bloco de código do markdown para codeEl (se existir)
  function extractFirstCodeBlock(md){
    const m = /```([a-zA-Z0-9+-]*)\s*([\s\S]*?)```/m.exec(md);
    return m ? m[2].trim() : '';
  }

  async function runPatch(){
    const model = (document.getElementById('model')?.value) || 'deepseek-coder:latest';
    const prompt = (promptEl.value || '').trim();
    if (!prompt) {
      renderMarkdownInto(expEl, '> Forneça um prompt no campo acima para gerar o patch.');
      return;
    }

    setStatus('Consultando modelo local (Ollama)…');
    renderMarkdownInto(expEl, '_Gerando…_');
    if (codeEl) codeEl.textContent = '';

    try {
      const { chunks } = await window.bridge.askOllama({ model, prompt });

      let acc = '';
      for await (const piece of chunks) {
        acc += piece;
        renderMarkdownInto(expEl, acc);
      }

      // se tivermos um contêiner de código, tenta extrair
      if (codeEl) {
        const code = extractFirstCodeBlock(acc);
        if (code) codeEl.textContent = code;
      }

      setStatus('Resposta concluída.');
    } catch (e){
      const msg = e?.message || String(e);
      renderMarkdownInto(expEl, `**Falha ao gerar patch:** ${msg}`);
      setStatus('Falha ao consultar o modelo.');
    }
  }

  btn.addEventListener('click', runPatch);

  // Hotkey: Ctrl+Enter já é propagado do main via 'solve:run'
  if (window.bridge?.onSolve) window.bridge.onSolve(runPatch);

  // Copiar código (se existir esse botão e o codeEl)
  if (copyBtn && codeEl) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeEl.textContent || '');
        setStatus('Código copiado.');
      } catch {
        setStatus('Não consegui copiar.');
      }
    });
  }
})();
