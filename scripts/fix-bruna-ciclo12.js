// Corrige a atribuicao das metas do CICLO 12 entre as duas Brunas.
//
// A planilha de comissao identifica todo mundo pelo primeiro nome, e existem duas
// Brunas: BRUNA RAYANE (Coruripe, 24670) e BRUNA SOARES SIQUEIRA (Palmeira, 24668).
// O parser indexa pelo nome curto "BRUNA", e a chave "BRUNA" do cadastro aponta
// para Coruripe — entao tudo que a planilha escreve como "BRUNA" cai na Rayane e a
// BRUNA SOARES fica sem meta nenhuma.
//
// No ciclo 12 os DOIS blocos "BRUNA" da planilha sao de PALMEIRA:
//   - aba "Consultor de loja": o bloco esta entre YASMIN e CECILIA (as duas de
//     Palmeira) e vem com receita/skin/servicos em branco.
//   - aba "Consultora de servicos": receita 25.789,942, que e exatamente METADE da
//     receita de Palmeira na aba de loja (51.579,884). Essa razao de 1/2 vale para
//     todas as consultoras de servico (Ana Paula/Coruripe, Joana/Penedo,
//     Shayane/Teotonio), e e o que identifica a loja do bloco.
// A Rayane (Coruripe) nao aparece em lugar nenhum da planilha do ciclo 12.
//
// Portanto: tudo que o parser devolve em "BRUNA" para o ciclo 12 pertence a
// BRUNA SOARES, e a BRUNA (Coruripe) fica sem meta neste ciclo.
//
// Uso:
//   node scripts/fix-bruna-ciclo12.js "COMISSAO CICLO 12.xlsx"            -> simula
//   node scripts/fix-bruna-ciclo12.js "COMISSAO CICLO 12.xlsx" --gravar   -> grava
//
// ATENCAO: o .env local aponta pro Supabase de PRODUCAO. O servidor do Render so
// enxerga o cadastro novo apos reiniciar (ele cacheia em memoria no boot).
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
if (!arquivo) {
  console.error('uso: node scripts/fix-bruna-ciclo12.js <planilha.xlsx> [--gravar]');
  process.exit(1);
}

const CORURIPE = 'BRUNA';          // chave do cadastro -> pdv 24670
const PALMEIRA = 'BRUNA SOARES';   // chave do cadastro -> pdv 24668
// Campos de meta que saem da comissao. O que nao vier na planilha do ciclo tem que
// ser APAGADO, nao preservado: e assim que a meta de skin da loja inteira (2.993,97,
// de quando a Rayane era Consultora Responsavel no ciclo 11) sobreviveu ate aqui.
// `nps` fica DE FORA de proposito: no cadastro da consultora ele e o realizado que
// o admin digita a mao, nao meta de comissao.
const CAMPOS_META = ['receita', 'skin', 'boletoMedio', 'itensBoleto', 'servicos',
                     'resgate', 'idCliente', 'auditoria', 'prm', 'turbinado',
                     'conversao', 'papel'];

const fmt = (v) => v == null ? '—' : (typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : String(v));

(async () => {
  const wb = XLSX.readFile(arquivo);

  // Guarda: se a planilha tiver aba de Consultora Responsavel, a premissa de que os
  // dois blocos "BRUNA" sao de Palmeira nao vale mais (no ciclo 11 o bloco daquela
  // aba era o da Rayane). Melhor parar do que gravar meta na pessoa errada de novo.
  const respSheet = wb.SheetNames.find(s => /RESPOS[ÁA]VEL|RESPONS[ÁA]VEL/i.test(s));
  if (respSheet) {
    console.error(`ABORTADO: "${arquivo}" tem a aba "${respSheet}".`);
    console.error('Este script so vale para o ciclo 12, que nao tem consultora responsavel.');
    process.exit(1);
  }

  const { metas } = P.parseComissaoWorkbook(XLSX, wb);
  const doCiclo = metas[CORURIPE];
  if (!doCiclo) {
    console.error(`ABORTADO: a planilha nao tem bloco "${CORURIPE}".`);
    process.exit(1);
  }

  const cadastro = await supa.getSellerMetas();
  const antesCor = cadastro[CORURIPE] || {};
  const antesPal = cadastro[PALMEIRA] || {};

  // --- BRUNA SOARES (Palmeira): recebe as metas do ciclo 12 ---
  // Preserva pdv, nps, slackId e paused — sao cadastro, nao meta.
  const novoPal = { ...antesPal };
  for (const c of CAMPOS_META) delete novoPal[c];
  for (const [k, v] of Object.entries(doCiclo)) novoPal[k] = v;
  novoPal.pdv = antesPal.pdv || '24668';

  // --- BRUNA (Coruripe): sem bloco no ciclo 12, entao sem meta ---
  // storeLead:false fica EXPLICITO de proposito: chave ausente e chave preservada no
  // merge do servidor, e sem o false quem deixou de ser responsavel continuaria
  // marcada e a DM compararia o faturamento da loja inteira com a meta individual.
  // iafSegment fica: e o resultado dela no ciclo 11 (0,747 / Bronze), nao uma meta.
  const novoCor = { ...antesCor };
  for (const c of CAMPOS_META) delete novoCor[c];
  novoCor.storeLead = false;

  const linha = (rot, a, b) => console.log(`  ${rot.padEnd(14)}${fmt(a).padStart(14)}  ->  ${fmt(b)}`);
  const campos = [...new Set([...CAMPOS_META, 'storeLead', 'iafSegment', 'pdv', 'nps', 'paused'])];

  console.log(`planilha: ${arquivo}`);
  console.log(`bloco "BRUNA" do ciclo 12: ${JSON.stringify(doCiclo)}\n`);

  console.log(`${PALMEIRA}  (Palmeira dos Indios, ${novoPal.pdv})`);
  for (const c of campos) {
    if (antesPal[c] === undefined && novoPal[c] === undefined) continue;
    linha(c, antesPal[c], novoPal[c]);
  }

  console.log(`\n${CORURIPE}  (Coruripe, ${novoCor.pdv}) — fora da comissao do ciclo 12`);
  for (const c of campos) {
    if (antesCor[c] === undefined && novoCor[c] === undefined) continue;
    linha(c, antesCor[c], novoCor[c]);
  }

  if (!GRAVAR) {
    console.log('\n[simulacao] nada foi gravado — rode com --gravar para aplicar');
    return;
  }

  // Sobrescreve as duas chaves por inteiro (o POST /api/seller-metas so faz merge e
  // nao consegue apagar campo — por isso a gravacao aqui e direta no Supabase).
  const cadNovo = { ...cadastro, [PALMEIRA]: novoPal, [CORURIPE]: novoCor };
  await supa.saveSellerMetas(cadNovo);

  console.log('\nGRAVADO no Supabase.');
  console.log('O servidor do Render so enxerga isto apos reiniciar (cacheia no boot).');
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
