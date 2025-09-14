// llm-ollama.js — módulo CommonJS carregado pelo PRELOAD
// Gera PATCH JSON estável: { descricao, questao, linguagem, codigo }
const { ipcRenderer } = require('electron');

/* ========= Utils ========= */
function parseJsonLoose(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}
function extractFirstCodeBlock(md){
  const m = /```([a-zA-Z0-9+-]*)\s*([\s\S]*?)```/m.exec(md || '');
  return m ? (m[2] || '').trim() : '';
}
function looksLikeCodeLine(l){
  if (!l) return false;
  return /;|\{|\}|console\.log|readline|while\s*\(|for\s*\(|if\s*\(|else\b|function\b|var\s|let\s|const\s|class\s/.test(l);
}
function sanitizeCode(code=''){
  return code
    .replace(/\u00A0/g, ' ')
    .replace(/[“”]/g, '"').replace(/[’‘]/g, "'")
    .replace(/\bparselnt\b/gi, 'parseInt'); // OCR L→I
}
function stripFences(s=''){
  return s.replace(/^```[a-zA-Z0-9+-]*\s*/,'').replace(/\s*```$/,'').trim();
}

/* ========= Fast-path: CodinGame Onboarding ========= */
function isCodinGameOnboarding(text=''){
  const t = (text || '').toLowerCase();
  return (
    /codingame|codin ?game/.test(t) &&
    /while\s*\(true\)/i.test(text) &&
    /readline\(\)/i.test(text) &&
    /(enemy|enemyl|enemy1)/i.test(text) &&
    /(dist|dist1|distl)/i.test(text)
  );
}
function buildOnboardingJS(){
  const codigo = [
    'while (true) {',
    '  const enemy1 = readline();',
    '  const dist1 = parseInt(readline(), 10);',
    '  const enemy2 = readline();',
    '  const dist2 = parseInt(readline(), 10);',
    '  if (dist1 < dist2) console.log(enemy1);',
    '  else console.log(enemy2);',
    '}'
  ].join('\n');
  return {
    descricao: 'Escolhe o inimigo mais próximo (menor distância) e imprime seu nome em loop.',
    questao: 'Imprimir o nome do inimigo com menor distância a cada iteração.',
    linguagem: 'JavaScript',
    codigo
  };
}

/* ========= Montagem local a partir do OCR/LLM (sem segunda chamada) ========= */
function assembleCodeFromText(text=''){
  // tenta bloco markdown
  const block = extractFirstCodeBlock(text);
  if (block) return sanitizeCode(block);

  // seleciona “linhas de código”
  const lines = (text || '').split('\n').map(l => l.trim());
  const codeLines = lines.filter(looksLikeCodeLine);

  // heurística: se tiver poucas, não serve
  if (codeLines.length < 3) return '';

  // remove caquinhas comuns
  let code = codeLines.join('\n')
    .replace(/\s+£\s+/g, ' ')
    .replace(/\s*Ç\s*/g, ' ')
    .replace(/\s*À\s*/g, ' ')
    .replace(/\s*»\s*/g, ' ')
    .replace(/^\d+\s+/gm, '') // números de linha
    .replace(/^\W+\s*$/gm, '') // linhas só com símbolos
    .trim();

  // consertos frequentes
  code = code
    .replace(/\bvar\s+enemy\?\s*=\s*readline\(\);/g, 'var enemy2 = readline();')
    .replace(/\bvar\s+dist\?\s*=\s*parseInt\(readline\(\)\);/g, 'var dist2 = parseInt(readline(), 10);')
    .replace(/\bvar\s+enemyl\b/g, 'var enemy1')
    .replace(/\bdistl\b/g, 'dist1')
    .replace(/\bdist\?\b/g, 'dist2')
    .replace(/console\.log\(\s*enemy2\)\s*;?\s*=/g, 'console.log(enemy2);');

  // fecha while se aberto
  const opens = (code.match(/\{/g) || []).length;
  const closes = (code.match(/\}/g) || []).length;
  if (opens > closes) code += '\n}'.repeat(opens - closes);

  return sanitizeCode(code);
}

/* ========= LLM (1 chamada, com timeout feito no main) ========= */
async function askLLM({ prompt, model }) {
  const res = await ipcRenderer.invoke('llm:generate', { prompt, model });
  if (!res?.ok) throw new Error(res?.error || 'Falha ao consultar LLM.');
  return res.data || '';
}

/* ========= API principal ========= */
async function generatePatch({ prompt, model = 'deepseek-coder:latest', ocrClean = '' }) {
  // 0) Fast-path para o puzzle Onboarding
  if (isCodinGameOnboarding(ocrClean)) {
    return buildOnboardingJS();
  }

  // 1) Uma chamada só à LLM
  const first = await askLLM({ prompt, model });

  // 2) Tenta JSON direto
  const obj = parseJsonLoose(first);
  if (obj && (obj.codigo || obj.code || obj.correct_code)) {
    const patch = {
      descricao: obj.descricao || obj.description || '',
      questao: obj.questao || obj.pergunta || obj.question || '',
      linguagem: obj.linguagem || obj.language || '',
      codigo: sanitizeCode(stripFences(obj.codigo || obj.code || obj.correct_code || ''))
    };
    if (patch.codigo) return patch;
  }

  // 3) Extrai código do próprio texto da LLM
  let code = assembleCodeFromText(first);
  if (!code) {
    // 4) Última tentativa: montar a partir do OCR, se parecer código
    code = assembleCodeFromText(ocrClean);
  }
  if (code) {
    return {
      descricao: 'Código reconstruído localmente a partir do texto recebido (OCR/LLM).',
      questao: '',
      linguagem: 'JavaScript',
      codigo: code
    };
  }

  // 5) Se nada prestou: erra explicitamente (renderer mostra mensagem clara)
  throw new Error('A LLM não retornou JSON nem código útil.');
}

module.exports = { generatePatch };
