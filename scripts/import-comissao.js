// Importa a planilha de COMISSAO de um ciclo para o cadastro (Supabase), fazendo o
// mesmo que o botao "Confirmar import" do admin.html — mas com duas vantagens:
//
//  1. O carry-over do segmento IAF sai do SNAPSHOT FECHADO do ciclo anterior, que e
//     o resultado final. O admin usa o realizado das planilhas carregadas no
//     servidor, que podem estar defasadas (foi o caso: producao tinha o export de
//     07/08 de um ciclo que terminou em 09/08).
//  2. Nao existe o select de PDV que, em branco, cai no primeiro item da lista e
//     move a consultora de loja sem ninguem perceber. Aqui, sem PDV no cadastro, a
//     pessoa fica SEM pdv e e reportada.
//
// Uso (o xlsx nao esta no package.json — e dependencia so deste script, o servidor
// nao usa; instale sem sujar o manifesto se o require falhar):
//   npm install xlsx --no-save
//   node scripts/import-comissao.js "COMISSAO CICLO 12.xlsx"            -> simula
//   node scripts/import-comissao.js "COMISSAO CICLO 12.xlsx" --gravar   -> grava
//
// ATENCAO: o .env local aponta pro Supabase de PRODUCAO. Depois de gravar, o
// servidor do Render so enxerga as metas novas apos reiniciar (ele cacheia em
// memoria no boot) — qualquer deploy serve.
require('dotenv').config({ override: true });
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const supa = require(path.join(ROOT, 'lib/supabase.js'));

global.window = {};
eval(fs.readFileSync(path.join(ROOT, 'public/comissao-parser.js'), 'utf8'));
const P = global.window.ComissaoParser;

const arquivo = process.argv[2];
const GRAVAR = process.argv.includes('--gravar');
if (!arquivo) { console.error('uso: node scripts/import-comissao.js <planilha.xlsx> [--gravar]'); process.exit(1); }

const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Metas que, se o bloco da pessoa NESTE ciclo nao trouxer, sao APAGADAS em vez de
// preservadas. O merge do cadastro guarda a chave ausente, entao a meta do ciclo
// anterior sobrevive e o painel compara a venda de hoje com um alvo velho, calado —
// foi o que aconteceu no ciclo 13: as consultoras de servico perderam a linha
// RECEITA (passaram a comissionar por servicos/conversao/P.M.C) e continuariam com a
// receita do 12, que ainda entraria na soma da meta da loja.
//
// A lista e curta DE PROPOSITO. `boletoMedio` e `itensBoleto` ficam de fora porque a
// planilha some com essas linhas o tempo todo sem que a meta deixe de valer (o ciclo
// 12 tirou BOLETO MEDIO de quase todo bloco); apaga-las zerava a meta de 4 lojas.
// `nps` tambem fica de fora: no cadastro da consultora ele e o realizado que o admin
// digita a mao. `iafSegment`, `pdv`, `paused` e `slackId` sao cadastro, nao meta.
const CAMPOS_META = ['receita', 'skin'];

// Casa o nome curto da comissao ("CECÍLIA") com o nome canonico do snapshot
// ("MARIA CICILIA BRITO VEIGA"): todos os tokens do curto tem que aparecer no
// completo. So aceita resposta unica — homonimo fica de fora e e reportado.
const ALIAS = { CECILIA: 'CICILIA', JOANA: 'JOANNA', CAROL: 'CAROLINE', TAINA: 'TAYNA', ALEXIA: 'ALEXIA', TACIANE: 'TACIANE' };
// pdvEsperado desempata homonimo: existem duas BRUNA (Palmeira e Coruripe) e o
// nome curto sozinho casa com as duas. O PDV vem do cadastro.
function casaCanonico(nomeCurto, canonicos, consultoras, pdvEsperado) {
  const base = norm(nomeCurto);
  const alvo = ALIAS[base] || base;
  const toks = alvo.split(/\s+/).filter(Boolean);
  const daLoja = (lista) => {
    if (lista.length <= 1 || !pdvEsperado) return lista;
    const f = lista.filter(c => consultoras[c]?.pdv === pdvEsperado);
    return f.length ? f : lista;
  };
  let hits = daLoja(canonicos.filter(c => {
    const ct = c.split(/\s+/).filter(Boolean);
    return toks.every((t, i) => ct[i] === t) || toks.every(t => ct.includes(t));
  }));
  if (hits.length === 1) return hits[0];
  hits = daLoja(canonicos.filter(c => c.split(/\s+/)[0] === toks[0]));
  return hits.length === 1 ? hits[0] : null;
}

(async () => {
  const cadastro = await supa.getSellerMetas();
  const storeMetas = await supa.getStoreMetas();
  const historico = await supa.getHistorico();

  const { metas, globais, leads, abasVazias } = P.parseComissaoWorkbook(XLSX, XLSX.readFile(arquivo));
  console.log(`comissao: ${arquivo}`);
  console.log(`  ${Object.keys(metas).length} pessoas · responsaveis: ${leads.length ? leads.join(', ') : 'nenhuma'}`);
  console.log(`  globais: ${JSON.stringify(globais)}\n`);

  // Aba existe e nao devolveu ninguem = layout mudou nela. Gravar assim monta um
  // cadastro pela metade e derruba a meta das lojas de quem ficou de fora — para
  // aqui, porque a diferenca nao aparece em nenhum outro lugar.
  if (abasVazias && abasVazias.length) {
    console.error(`ABORTADO: nenhuma pessoa saiu da(s) aba(s) ${abasVazias.join(', ')} — o layout mudou.`);
    process.exit(1);
  }

  // --- carry-over do IAF: usa o ultimo ciclo FECHADO do historico ---
  const fechados = Object.values(historico).filter(s => s.fechado).sort((a, b) => a.ciclo - b.ciclo);
  const ultimo = fechados[fechados.length - 1];
  const canonicos = ultimo ? Object.keys(ultimo.consultoras || {}) : [];
  console.log(`carry-over do segmento IAF: ciclo ${ultimo ? ultimo.ciclo : '?'} (fechado, ${canonicos.length} consultoras)`);

  const carry = {}, semCarry = [];
  for (const nome of Object.keys(metas)) {
    if (P.NAO_E_PESSOA.test(nome)) continue;
    const can = casaCanonico(nome, canonicos, ultimo ? ultimo.consultoras : {}, cadastro[nome]?.pdv);
    const pct = can ? ultimo.consultoras[can]?.iafPct : null;
    if (pct == null) { semCarry.push(nome); continue; }
    carry[nome] = pct;
  }
  console.log(`  casaram: ${Object.keys(carry).length} · sem segmento do ciclo anterior: ${semCarry.join(', ') || 'nenhuma'}\n`);

  // --- monta o cadastro novo ---
  const sellerMetas = {}, semPdv = [];
  for (const [nome, m] of Object.entries(metas)) {
    if (P.NAO_E_PESSOA.test(nome)) continue;          // rotulo de papel, nao e pessoa
    const pdv = (cadastro[nome] && cadastro[nome].pdv) || '';
    if (!pdv) semPdv.push(nome);
    sellerMetas[nome] = { ...m, pdv };
    if (carry[nome] != null) sellerMetas[nome].iafSegment = carry[nome];
  }
  if (semPdv.length) console.log(`SEM PDV no cadastro (ficam sem loja ate voce ajustar): ${semPdv.join(', ')}\n`);

  // Campo que a pessoa tinha no cadastro e que o bloco DELA neste ciclo nao traz:
  // some. Ver CAMPOS_META — so vale para quem esta nesta comissao; quem ficou de
  // fora dela nao e tocado.
  const limpar = {};
  for (const nome of Object.keys(sellerMetas)) {
    const fora = CAMPOS_META.filter(c => cadastro[nome]?.[c] != null && sellerMetas[nome][c] == null);
    if (fora.length) limpar[nome] = fora;
  }
  if (Object.keys(limpar).length) {
    console.log('METAS APAGADAS (a comissao deste ciclo nao traz mais o indicador):');
    for (const [n, campos] of Object.entries(limpar)) {
      console.log(`  ${n.padEnd(16)}${campos.map(c => `${c}=${typeof cadastro[n][c] === 'number' ? Math.round(cadastro[n][c]).toLocaleString('pt-BR') : cadastro[n][c]}`).join(' · ')}`);
    }
    console.log('');
  }

  // Metas que a planilha ja traz e o app ainda nao mede (ver METAS_FUTURAS).
  const futuras = Object.entries(sellerMetas)
    .filter(([, m]) => P.METAS_FUTURAS.some(k => m[k] != null) && m.papel !== 'digital')
    .map(([n, m]) => `${n}: ${P.METAS_FUTURAS.filter(k => m[k] != null).map(k => `${k}=${m[k]}`).join(' ')}`);
  if (futuras.length) {
    console.log(`METAS FUTURAS gravadas, mas SEM realizado em nenhum relatorio (nao pontuam):\n  ${futuras.join('\n  ')}\n`);
  }

  // --- metas de loja derivadas, respeitando a trava ---
  const derivadas = P.derivarMetasDeLoja(sellerMetas);
  const NOMES = { '24303': 'Sao Sebastiao', '24617': 'Sustentavel', '24668': 'Palmeira',
                  '24669': 'Penedo', '24670': 'Coruripe', '24671': 'Teotonio' };
  const novasLojas = {}, travadas = [], zeradas = [];
  for (const [pdv, m] of Object.entries(derivadas)) {
    if (storeMetas[pdv]?.metaTravada === 'sim') { travadas.push(pdv); continue; }
    // Derivada ZERO nao e meta zero, e "ninguem daquela loja trouxe o indicador":
    // uma loja so com consultora de servico (que desde o ciclo 13 nao tem receita),
    // ou uma aba que mudou de layout e escondeu as consultoras. Gravar "0" apagaria a
    // meta da loja em silencio — preserva e reporta. Mesma regra do boleto medio.
    if (!m.receitaLoja || !m.skinLoja) zeradas.push(`${NOMES[pdv] || pdv} (${!m.receitaLoja ? 'receita' : 'skin'})`);
    novasLojas[pdv] = m;
  }
  if (zeradas.length) console.log(`\nDERIVADA ZERO — o valor anterior fica de pe: ${zeradas.join(', ')}`);

  console.log('META DE LOJA        atual      nova   variacao');
  for (const pdv of Object.keys(NOMES)) {
    const atual = Number(storeMetas[pdv]?.receitaLoja) || 0;
    if (travadas.includes(pdv)) { console.log(`  ${NOMES[pdv].padEnd(15)}${String(atual.toLocaleString('pt-BR')).padStart(9)}    TRAVADA (preservada)`); continue; }
    const nova = novasLojas[pdv] ? Math.round(novasLojas[pdv].receitaLoja) : 0;
    const v = atual ? Math.round((nova - atual) / atual * 100) : 0;
    console.log(`  ${NOMES[pdv].padEnd(15)}${String(atual.toLocaleString('pt-BR')).padStart(9)}${String(nova.toLocaleString('pt-BR')).padStart(10)}${String((v > 0 ? '+' : '') + v + '%').padStart(11)}`);
  }

  const preservados = Object.keys(cadastro).filter(n => !sellerMetas[n]);
  console.log(`\nno cadastro e fora desta comissao (mantidos como estao): ${preservados.join(', ') || 'ninguem'}`);
  const virouFalse = Object.entries(cadastro).filter(([n, d]) => d.storeLead && sellerMetas[n] && !sellerMetas[n].storeLead).map(([n]) => n);
  console.log(`deixam de ser responsaveis pela loja: ${virouFalse.join(', ') || 'ninguem'}`);

  if (!GRAVAR) { console.log('\n[simulacao] nada foi gravado — rode com --gravar para aplicar'); return; }

  // --- grava ---
  // Merge como o servidor faz (chave ausente = chave preservada) e, DEPOIS, apaga os
  // campos de CAMPOS_META que a comissao deste ciclo nao trouxe. A gravacao e direta
  // no Supabase de proposito: o POST /api/seller-metas so faz merge e nao consegue
  // apagar campo.
  const cadNovo = { ...cadastro };
  for (const [n, m] of Object.entries(sellerMetas)) {
    cadNovo[n] = { ...(cadNovo[n] || {}), ...m };
    for (const c of (limpar[n] || [])) delete cadNovo[n][c];
  }
  await supa.saveSellerMetas(cadNovo);

  const stoNovo = { ...storeMetas };
  for (const [pdv, m] of Object.entries(novasLojas)) {
    // O spread preserva npsLoja/auditoriaLoja/metaTravada. Cada indicador so e
    // sobrescrito quando a comissao REALMENTE o trouxe (valor > 0) — ver "DERIVADA
    // ZERO" acima e o caso do boleto medio no ciclo 12, que removeu a linha BOLETO
    // MEDIO de quase todos os blocos e teria zerado a meta de 4 lojas.
    stoNovo[pdv] = { ...(stoNovo[pdv] || {}) };
    if (m.receitaLoja) stoNovo[pdv].receitaLoja = String(Math.round(m.receitaLoja));
    if (m.skinLoja) stoNovo[pdv].skinLoja = String(Math.round(m.skinLoja));
    if (m.boletoMedio) stoNovo[pdv].boletoMedio = String(m.boletoMedio);
  }
  await supa.saveStoreMetas(stoNovo);

  const MAP_GLOBAL = { prm: 'metaPRM', turbinado: 'metaTurbinado', idCliente: 'metaID',
                       resgate: 'metaResgate', nps: 'metaNPS', auditoria: 'metaAuditoria',
                       itensBoleto: 'metaItensBoleto' };
  const gAtual = await supa.getMetas({});
  const gNovo = { ...gAtual };
  for (const [k, id] of Object.entries(MAP_GLOBAL)) if (globais[k] != null) gNovo[id] = String(globais[k]);
  await supa.saveMetas(gNovo);

  console.log(`\nGRAVADO: ${Object.keys(sellerMetas).length} consultoras · ${Object.keys(novasLojas).length} lojas · metas globais`);
  console.log('O servidor do Render so enxerga isto apos reiniciar (cacheia no boot).');
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
