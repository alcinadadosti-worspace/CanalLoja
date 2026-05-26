#!/usr/bin/env node
// Importa metas do Ciclo 8 a partir da planilha COMISSÃO CICLO 8.xlsx
// Uso: node scripts/seed-cycle8.js [porta]
// Requer o servidor rodando.

const XLSX = require('xlsx');
const path = require('path');

const PORT = process.argv[2] || 3000;
const BASE = `http://localhost:${PORT}`;
const FILE = path.join(__dirname, '..', 'COMISSÃO CICLO 8.xlsx');

const PDV_MAP = {
  'YASMIN':         '24668',
  'VALESCA':        '24668',
  'CECÍLIA':        '24668',
  'CECILIA':        '24668',
  'MARYANNA':       '24303',
  'NAYARA':         '24303',
  'EDUARDA':        '24617',
  'ALEXIA':         '24617',
  'ANA PAULA':      '24671',
  'BRUNA':          '24671',
  'DEISE':          '24669',
  'JOANA':          '24669',
  'MARIA FERNANDA': '24669',
  'CAMILLE':        '24670',
  'JÚNIOR':         '24670',
  'JUNIOR':         '24670',
  'JOSENILDO':      '24670',
  'ELIENE':         '24670',
  'SHAYANE':        '24670',
  'ANNY':           'digital',
  'KEMILLY':        'gerente_norte',
  'TACIANE':        'gerente_sul',
  'MARIANE':        'gerente_digital',
};

const VAR_MAP = {
  'RECEITA':                    'receita',
  'BOLETO MÉDIO':               'boletoMedio',
  'BOLETO MEDIO':               'boletoMedio',
  'CRESCIMENTO DE BOLETO MÉDIO':'boletoMedio',
  'SKIN':                       'skin',
  'CATEGORIA (SKIN)':           'skin',
  'SERVIÇOS':                   'servicos',
  'SERVICOS':                   'servicos',
  'QUANTIDADE DE SERVIÇOS':     'servicos',
  'ITENS/BOLETO':               'itensBoleto',
  'ITENS POR BOLETO':           'itensBoleto',
  'AUDITORIA':                  'auditoria',
  'NPS':                        'nps',
  'PRM':                        'prm',
  'TURBINADO':                  'turbinado',
  'RESGATE':                    'resgate',
  'ID CLIENTE':                 'idCliente',
  'ID  CLIENTE':                'idCliente',
  'ID DO CLIENTE':              'idCliente',
  'CONVERSÃO':                  'conversao',
  'CONVERSAO':                  'conversao',
  'RECEITA CABELOS':            'receitaCabelos',
  'RECEITA SKIN':               'receitaSkin',
  'RECEITA MAKE':               'receitaMake',
  'CALÇADA PERFUMADA':          'calcadaPerfumada',
};

function parseSheet(wb, sheetName, nameCol, varCol, metaCol) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return {};
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const result = {};
  let currentPerson = null;

  for (const row of data) {
    const c1 = String(row[nameCol] || '').trim();
    const c2 = String(row[varCol] || '').trim();
    const c3 = row[metaCol];

    if (c2 === 'PREENCHIMENTO' && c1 !== '') {
      currentPerson = c1.toUpperCase();
      if (!result[currentPerson]) result[currentPerson] = {};
      continue;
    }
    if (c1 === 'VARIÁVEL') continue;
    if (currentPerson && c1 && !c1.startsWith('Saldo')) {
      const varKey = VAR_MAP[c1.toUpperCase().trim()];
      if (varKey && c3 !== '' && c3 != null) {
        const val = typeof c3 === 'number' ? c3 : parseFloat(String(c3).replace(',', '.'));
        if (!isNaN(val)) result[currentPerson][varKey] = val;
      }
    }
    if (c1 && c1.startsWith('Saldo')) currentPerson = null;
  }
  return result;
}

async function main() {
  console.log('Lendo planilha...');
  const wb = XLSX.readFile(FILE);

  const gerentes = parseSheet(wb, 'Gerente de unidade loja', 1, 2, 2);
  const consultores = parseSheet(wb, 'Consultor de loja', 1, 2, 2);
  const servicos = parseSheet(wb, 'Consultora de serviços', 0, 1, 1);
  const digital = parseSheet(wb, 'Consultor Loja digital', 0, 1, 1);

  const all = {};
  for (const src of [gerentes, consultores, servicos, digital]) {
    for (const [name, metas] of Object.entries(src)) {
      if (!all[name]) all[name] = {};
      Object.assign(all[name], metas);
    }
  }

  // Juntar JÚNIOR = JOSENILDO
  if (all['JÚNIOR']) {
    all['JOSENILDO'] = { ...(all['JOSENILDO'] || {}), ...all['JÚNIOR'] };
    delete all['JÚNIOR'];
  }
  if (all['JUNIOR']) {
    all['JOSENILDO'] = { ...(all['JOSENILDO'] || {}), ...all['JUNIOR'] };
    delete all['JUNIOR'];
  }

  // Adicionar PDV a cada seller
  const sellerMetas = {};
  for (const [name, metas] of Object.entries(all)) {
    const pdv = PDV_MAP[name];
    if (!pdv) { console.log(`  AVISO: ${name} sem PDV mapeado, ignorando`); continue; }
    sellerMetas[name] = { ...metas, pdv };
  }

  console.log(`\n${Object.keys(sellerMetas).length} consultoras com metas extraidas:\n`);
  for (const [name, m] of Object.entries(sellerMetas)) {
    const pdv = m.pdv;
    const r = m.receita ? `R$${Math.round(m.receita)}` : '-';
    const s = m.skin ? `Skin R$${Math.round(m.skin)}` : '';
    const sv = m.servicos ? `Svc ${m.servicos}` : '';
    console.log(`  ${name.padEnd(18)} PDV ${pdv.padEnd(6)} ${r.padEnd(12)} ${s.padEnd(16)} ${sv}`);
  }

  // Calcular metas por loja (soma das consultoras de cada loja)
  const PDVS = ['24303', '24617', '24668', '24669', '24670', '24671'];
  const storeMetas = {};
  for (const pdv of PDVS) {
    const sellers = Object.entries(sellerMetas).filter(([, m]) => m.pdv === pdv);
    if (!sellers.length) continue;
    const receitaLoja = sellers.reduce((s, [, m]) => s + (m.receita || 0), 0);
    const skinLoja = sellers.reduce((s, [, m]) => s + (m.skin || 0), 0);
    const bms = sellers.filter(([, m]) => m.boletoMedio).map(([, m]) => m.boletoMedio);
    const boletoMedio = bms.length ? Math.round(bms.reduce((a, b) => a + b, 0) / bms.length) : '';
    storeMetas[pdv] = {
      receitaLoja: String(Math.round(receitaLoja)),
      skinLoja: String(Math.round(skinLoja)),
      boletoMedio: boletoMedio ? String(boletoMedio) : '',
      npsLoja: '90',
      auditoriaLoja: '95',
    };
  }

  console.log('\nMetas por loja:');
  for (const [pdv, m] of Object.entries(storeMetas)) {
    console.log(`  PDV ${pdv}: Receita R$${m.receitaLoja} | Skin R$${m.skinLoja} | BM R$${m.boletoMedio}`);
  }

  // POST to server
  console.log(`\nEnviando para ${BASE}...`);

  // Login admin
  const loginR = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '2255' }),
  });
  if (!loginR.ok) { console.error('Erro ao logar como admin'); process.exit(1); }
  const cookies = loginR.headers.getSetCookie?.() || [];
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');

  // POST seller metas
  const smR = await fetch(`${BASE}/api/seller-metas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(sellerMetas),
  });
  const smJ = await smR.json();
  console.log('Seller metas:', smJ.ok ? `OK (${smJ.count} pessoas)` : 'ERRO');

  // POST store metas
  for (const [pdv, metas] of Object.entries(storeMetas)) {
    const r = await fetch(`${BASE}/api/store-metas/${pdv}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(metas),
    });
    const j = await r.json();
    console.log(`Store ${pdv}:`, j.ok ? 'OK' : 'ERRO');
  }

  console.log('\nImportacao concluida!');
}

main().catch(e => { console.error(e); process.exit(1); });
