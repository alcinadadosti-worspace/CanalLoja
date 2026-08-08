// Import retroativo do historico, ciclo a ciclo.
//
// Abre o painel num navegador headless e chama importarCicloRetroativo() com as
// planilhas de cada ciclo. O calculo e feito pelo MESMO codigo do index.html que
// o Eduardo ve na tela — nada de reimplementar extracao aqui e os dois divergirem.
//
// Uso:
//   node scripts/import-historico.js                 -> dry-run de todos os ciclos (nao grava)
//   node scripts/import-historico.js --gravar        -> grava de verdade
//   node scripts/import-historico.js --ciclo 10      -> so um ciclo
//
// Pre-requisitos:
//   1. npm i --no-save playwright && npx playwright install chromium
//      (fica fora do package.json de proposito: e ferramenta de import, nao do app)
//   2. servidor local no ar, com uma senha que voce conheca:
//      PORT=3100 USER_EQUIPE_HASH='<hash bcrypt>' node server.js
//      e a mesma senha em IMPORT_SENHA aqui.
//   3. ATENCAO: o .env local aponta pro Supabase de PRODUCAO. --gravar escreve
//      no historico de producao. Rode o dry-run e confira .import-historico/ antes.
//
// Cuidado ao editar public/index.html: o server le o arquivo UMA VEZ no boot
// (INDEX_TEMPLATE). Sem reiniciar, o navegador continua recebendo a versao velha.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HIST_DIR = path.join(ROOT, 'historico');
const CICLOS_DIR = path.join(ROOT, 'ciclos');
const BASE = process.env.IMPORT_BASE_URL || 'http://localhost:3100';
const SENHA = process.env.IMPORT_SENHA || 'importhist2026';
const OUT_DIR = process.env.IMPORT_OUT_DIR || path.join(ROOT, '.import-historico');

const args = process.argv.slice(2);
const GRAVAR = args.includes('--gravar');
const soCiclo = (() => {
  const i = args.indexOf('--ciclo');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : null;
})();

// Pastas do historico: "Ciclo 01" .. "Ciclo 11"
function pastasDeCiclo() {
  if (!fs.existsSync(HIST_DIR)) throw new Error(`pasta nao encontrada: ${HIST_DIR}`);
  return fs.readdirSync(HIST_DIR)
    .map(nome => ({ nome, num: parseInt(String(nome).match(/(\d+)/)?.[1] || '0', 10) }))
    .filter(x => x.num > 0)
    .sort((a, b) => a.num - b.num);
}

// A comissao nao fica junto do relatorio: vive em ciclos/ciclo-NN/. Sem ela o
// ciclo entra so com realizado (sem % e sem IAF) — e o esperado dos ciclos 1-7.
function comissaoDoCiclo(num) {
  const dir = path.join(CICLOS_DIR, `ciclo-${String(num).padStart(2, '0')}`);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find(n => /\.xlsx$/i.test(n) && !n.startsWith('~') && /comiss|metas/i.test(n));
  return f ? path.join(dir, f) : null;
}

function arquivosDoCiclo(pasta, num) {
  const dir = path.join(HIST_DIR, pasta);
  const files = fs.readdirSync(dir)
    .filter(n => /\.xlsx$/i.test(n) && !n.startsWith('~') && !n.startsWith('.'))
    .map(n => path.join(dir, n));
  const com = comissaoDoCiclo(num);
  if (com) files.push(com);
  return { files, temComissao: !!com };
}

(async () => {
  const pastas = soCiclo ? pastasDeCiclo().filter(p => p.num === soCiclo) : pastasDeCiclo();
  if (!pastas.length) throw new Error(soCiclo ? `ciclo ${soCiclo} nao encontrado` : 'nenhuma pasta de ciclo');

  console.log(`${GRAVAR ? 'GRAVANDO' : 'DRY-RUN (nao grava)'} · ${pastas.length} ciclo(s) · ${BASE}\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push(String(e.message)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const login = await page.evaluate(async (senha) => {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: senha }),
    });
    return { status: r.status, body: await r.text() };
  }, SENHA);
  if (login.status !== 200) throw new Error(`login falhou (${login.status}): ${login.body}`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.importarCicloRetroativo === 'function', { timeout: 30000 });
  // O painel dispara o snapshot 'auto' do ciclo corrente 1,2s depois de carregar as
  // planilhas do servidor. Espera passar, senao os dois mexem em loadedWorkbooks juntos.
  await page.waitForTimeout(5000);

  await page.evaluate(() => {
    if (document.getElementById('__histInput')) return;
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.id = '__histInput'; i.style.display = 'none';
    document.body.appendChild(i);
  });

  const resultados = [];
  for (const { nome, num } of pastas) {
    const { files, temComissao } = arquivosDoCiclo(nome, num);
    process.stdout.write(`Ciclo ${String(num).padStart(2, '0')} · ${files.length} arquivo(s)${temComissao ? ' +comissao' : ' SEM comissao'} ... `);

    await page.setInputFiles('#__histInput', files);
    let res;
    try {
      res = await page.evaluate(async (dry) => {
        const inp = document.getElementById('__histInput');
        return await window.importarCicloRetroativo(Array.from(inp.files), { dryRun: dry });
      }, !GRAVAR);
    } catch (e) {
      res = { ok: false, motivo: 'excecao: ' + e.message };
    }

    if (!res || !res.ok) {
      console.log(`FALHOU — ${res ? (res.motivo || res.message) : 'sem resposta'}`);
      resultados.push({ num, ok: false, motivo: res && (res.motivo || res.message) });
      continue;
    }

    // snapshot completo em arquivo; no console so o resumo
    if (res.snapshot) {
      fs.writeFileSync(path.join(OUT_DIR, `ciclo-${String(num).padStart(2, '0')}.json`),
        JSON.stringify(res.snapshot, null, 2));
      delete res.snapshot;
    }
    const avisos = [];
    if (res.semMetas) avisos.push('SEM METAS (so realizado)');
    if (res.faltando?.length) avisos.push(`faltam planilhas: ${res.faltando.join(',')}`);
    if (res.ambiguas?.length) avisos.push(`consultora sem PDV: ${res.ambiguas.join(', ')}`);
    console.log(`ok · ciclo ${res.ciclo} · ${res.periodo} · ${res.lojas} lojas · ${res.consultoras} consultoras`
      + (avisos.length ? `\n         ! ${avisos.join(' | ')}` : ''));
    resultados.push({ num, ...res });
  }

  await browser.close();

  const falhas = resultados.filter(r => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} ciclo(s) ${GRAVAR ? 'gravados' : 'calculados'}`);
  if (falhas.length) console.log(`FALHAS: ${falhas.map(f => `ciclo ${f.num} (${f.motivo})`).join(' · ')}`);
  if (!GRAVAR) console.log(`Snapshots em ${OUT_DIR} — confira antes de rodar com --gravar`);
  if (erros.length) console.log(`\nErros de JS na pagina:\n  ${[...new Set(erros)].join('\n  ')}`);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
