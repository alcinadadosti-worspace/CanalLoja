// Parser da planilha de COMISSÃO do ciclo (metas por consultora + metas globais).
//
// Vive fora do admin.html porque duas telas precisam dele:
//   - admin.html  → import de comissão do ciclo corrente (seção "04")
//   - index.html  → import retroativo de um ciclo passado, na aba Histórico,
//                   onde é essencial usar as metas DAQUELE ciclo e não as de hoje.
//
// Sem script de build no projeto: é carregado por <script src> nas duas páginas.
(function (global) {
  'use strict';

  const COM_VAR_MAP = {
    'RECEITA':'receita','BOLETO MÉDIO':'boletoMedio','BOLETO MEDIO':'boletoMedio',
    'CRESCIMENTO DE BOLETO MÉDIO':'boletoMedio','SKIN':'skin','CATEGORIA (SKIN)':'skin',
    'SERVIÇOS':'servicos','SERVICOS':'servicos','QUANTIDADE DE SERVIÇOS':'servicos',
    'ITENS/BOLETO':'itensBoleto','ITENS POR BOLETO':'itensBoleto',
    'AUDITORIA':'auditoria','NPS':'nps','PRM':'prm','TURBINADO':'turbinado',
    'RESGATE':'resgate','ID CLIENTE':'idCliente','ID  CLIENTE':'idCliente',
    'ID DO CLIENTE':'idCliente','CONVERSÃO':'conversao','CONVERSAO':'conversao',
    'RECEITA CABELOS':'receitaCabelos','RECEITA SKIN':'receitaSkin','RECEITA MAKE':'receitaMake',
    'CALÇADA PERFUMADA':'calcadaPerfumada',
  };

  // Abas e a posição das colunas [nome, coluna do "PREENCHIMENTO", coluna da meta].
  const SHEETS = [
    ['Gerente de unidade loja', 1, 2, 2], ['Gerente de canal Loja', 1, 2, 2],
    ['Consultor de loja', 1, 2, 2], ['Consultora de serviços', 0, 1, 1],
    ['Consultor Loja digital', 0, 1, 1],
  ];

  function parseComSheet(XLSX, wb, sheetName, nc, vc, mc) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return {};
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const res = {};
    let cur = null;
    for (const row of data) {
      const c1 = String(row[nc] || '').trim(), c2 = String(row[vc] || '').trim(), c3 = row[mc];
      if (c2 === 'PREENCHIMENTO' && c1) { cur = c1.toUpperCase(); if (!res[cur]) res[cur] = {}; continue; }
      if (c1 === 'VARIÁVEL') continue;
      if (cur && c1 && !c1.startsWith('Saldo')) {
        const k = COM_VAR_MAP[c1.toUpperCase().trim()];
        if (k && c3 !== '' && c3 != null) {
          const v = typeof c3 === 'number' ? c3 : parseFloat(String(c3).replace(',', '.'));
          if (!isNaN(v)) res[cur][k] = v;
        }
      }
      if (c1 && c1.startsWith('Saldo')) cur = null;
    }
    return res;
  }

  // Metas globais: o mesmo alvo se repete em toda consultora (PRM 0,33 / resgate
  // 0,52 / ...). Pega o valor MAIS FREQUENTE de cada indicador — assim uma linha
  // divergente (a Camille tinha 2,9 de itens/boleto quando o resto era 2,8) não
  // define a meta da rede.
  function maisFrequente(valores) {
    if (!valores.length) return null;
    const cont = new Map();
    for (const v of valores) cont.set(v, (cont.get(v) || 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }

  // Escala da planilha → escala que o app guarda em _metas.json.
  // A comissão traz fração (0,33); o app guarda "33". Itens/boleto é absoluto.
  const ESCALA_100 = ['prm', 'turbinado', 'resgate', 'nps', 'auditoria', 'idCliente'];

  function extrairGlobais(porPessoa) {
    const acc = {};
    for (const metas of Object.values(porPessoa)) {
      for (const [k, v] of Object.entries(metas)) {
        if (typeof v !== 'number') continue;
        (acc[k] = acc[k] || []).push(v);
      }
    }
    const out = {};
    for (const k of ['prm', 'turbinado', 'idCliente', 'resgate', 'nps', 'auditoria', 'itensBoleto']) {
      const v = maisFrequente(acc[k] || []);
      if (v == null) continue;
      out[k] = ESCALA_100.includes(k) ? Math.round(v * 100 * 100) / 100 : v;
    }
    return out;
  }

  /**
   * @param XLSX  a lib SheetJS já carregada na página
   * @param wb    workbook da planilha de comissão
   * @returns {{ metas: Object, globais: Object, abasAusentes: string[], leads: string[] }}
   *   metas   → { NOME: { receita, boletoMedio, skin, servicos, ..., storeLead? } }
   *   globais → { prm, turbinado, idCliente, resgate, nps, auditoria, itensBoleto }
   */
  function parseComissaoWorkbook(XLSX, wb) {
    const all = {};
    const abasAusentes = [];
    for (const [name, nc, vc, mc] of SHEETS) {
      if (!wb.Sheets[name]) { abasAusentes.push(name); continue; }
      for (const [n, m] of Object.entries(parseComSheet(XLSX, wb, name, nc, vc, mc))) {
        if (!all[n]) all[n] = {};
        Object.assign(all[n], m);
      }
    }

    // As globais saem das linhas INDIVIDUAIS, antes da aba de responsável
    // sobrescrever quem é líder de loja.
    const globais = extrairGlobais(all);

    // Aba "Consultora Resposável" (grafada assim, sem "n", desde o ciclo 10):
    // estas consultoras respondem pela meta da LOJA inteira, não pela individual,
    // e a linha delas aqui SUBSTITUI a da aba "Consultor de loja".
    const leads = [];
    const respSheet = wb.SheetNames.find(s => /RESPOS[ÁA]VEL|RESPONS[ÁA]VEL/i.test(s));
    if (respSheet) {
      for (const [n, m] of Object.entries(parseComSheet(XLSX, wb, respSheet, 1, 2, 2))) {
        const lead = { storeLead: true };
        for (const k of ['receita', 'boletoMedio', 'skin']) if (m[k] != null) lead[k] = m[k];
        all[n] = lead;
        leads.push(n);
      }
    }

    // JÚNIOR → JOSENILDO (a planilha usa o apelido em algumas abas)
    if (all['JÚNIOR']) { all['JOSENILDO'] = { ...(all['JOSENILDO'] || {}), ...all['JÚNIOR'] }; delete all['JÚNIOR']; }
    if (all['JUNIOR']) { all['JOSENILDO'] = { ...(all['JOSENILDO'] || {}), ...all['JUNIOR'] }; delete all['JUNIOR']; }
    // ANNY → JULIENE: a planilha do ciclo 11 ainda traz "ANNY" na aba de loja
    // digital, mas quem opera o canal desde 20/07/2026 é a JULIENE REIS.
    if (all['ANNY']) { all['JULIENE'] = { ...(all['JULIENE'] || {}), ...all['ANNY'] }; delete all['ANNY']; }

    return { metas: all, globais, abasAusentes, leads };
  }

  global.ComissaoParser = { parseComissaoWorkbook, COM_VAR_MAP };
})(window);
