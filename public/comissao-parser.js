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
    'CALÇADA PERFUMADA':'calcadaPerfumada','P.M.C':'pmc','P.M.C.':'pmc','PMC':'pmc',
  };

  // METAS AINDA SEM FONTE DE REALIZADO.
  // O ciclo 13 trocou a linha RECEITA das consultoras de serviços por CONVERSÃO e
  // P.M.C. As duas são lidas e gravadas no cadastro — quando o realizado aparecer,
  // a meta do ciclo já vai estar guardada — mas NENHUM dos cinco relatórios
  // importados traz o realizado delas, então nada as pontua: ficam fora do IAF, do
  // card da consultora e da DM do Slack. Não invente o realizado a partir de outro
  // indicador: um número errado aqui vira comissão errada.
  const METAS_FUTURAS = ['conversao', 'pmc'];

  // Abas e o papel de quem está nelas.
  //
  // O papel importa para a meta da LOJA: quem está nas abas de gerente responde por
  // um GRUPO de lojas, não por uma. A meta da Kemilly (R$ 526 mil no ciclo 10) somada
  // em São Sebastião sozinha — que realizou R$ 48 mil — dava os R$ 702 mil de meta
  // que ninguém entendia. Ver derivarMetasDeLoja.
  const SHEETS = [
    ['Gerente de unidade loja', 'gerente'], ['Gerente de canal Loja', 'gerente'],
    ['Consultor de loja', 'consultor'], ['Consultora de serviços', 'consultor'],
    ['Consultor Loja digital', 'digital'],
  ];

  // A COLUNA DE CADA ABA NÃO É FIXA. sheet_to_json numera a partir do início do
  // !ref, então uma aba cujo range começa em B fica com tudo uma coluna à esquerda.
  // Foi o que o ciclo 13 fez: "Consultor de loja" saiu de A18:Q291 para B18:M291 e,
  // com as colunas escritas no código (nome=1, meta=2), o parser devolveu ZERO
  // consultora de loja — em SILÊNCIO. O import teria gravado só as consultoras de
  // serviços, e a meta de cada loja (soma das individuais) despencaria.
  // Achar a célula "PREENCHIMENTO" resolve para qualquer range: o nome está na
  // coluna anterior e a META na mesma coluna do "PREENCHIMENTO".
  function acharColunas(data) {
    for (const row of data) {
      if (!row) continue;
      for (let j = 1; j < row.length; j++) {
        if (String(row[j]).trim() !== 'PREENCHIMENTO') continue;
        if (String(row[j - 1] || '').trim()) return { nc: j - 1, vc: j, mc: j };
      }
    }
    return null;
  }

  function parseComSheet(XLSX, wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return {};
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const cols = acharColunas(data);
    if (!cols) return {};
    const { nc, vc, mc } = cols;
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
   * @param opts  { digitalEhJuliene?: boolean, brunaEhSoares?: boolean } — ver os
   *              renames ANNY→JULIENE e BRUNA→BRUNA SOARES abaixo. Os dois vêm true
   *              (ciclo corrente); o import retroativo passa false para ciclo
   *              anterior ao 11 e ao 12, respectivamente.
   * @returns {{ metas, globais, abasAusentes: string[], abasVazias: string[], leads: string[] }}
   *   metas       → { NOME: { receita, boletoMedio, skin, servicos, ..., storeLead? } }
   *   globais     → { prm, turbinado, idCliente, resgate, nps, auditoria, itensBoleto }
   *   abasVazias  → abas que EXISTEM mas de onde não saiu ninguém (layout mudou) —
   *                 avise em vez de importar um cadastro pela metade.
   */
  function parseComissaoWorkbook(XLSX, wb, opts) {
    const digitalEhJuliene = !opts || opts.digitalEhJuliene !== false;
    const brunaEhSoares = !opts || opts.brunaEhSoares !== false;
    const all = {};
    const abasAusentes = [], abasVazias = [];
    for (const [name, papel] of SHEETS) {
      if (!wb.Sheets[name]) { abasAusentes.push(name); continue; }
      const doSheet = parseComSheet(XLSX, wb, name);
      // Aba presente e sem nenhum bloco reconhecido = layout mudou. Quem chama TEM
      // que avisar: sem isto o import segue adiante gravando um cadastro parcial.
      if (!Object.keys(doSheet).length) abasVazias.push(name);
      for (const [n, m] of Object.entries(doSheet)) {
        if (!all[n]) all[n] = {};
        Object.assign(all[n], m, { papel });
      }
    }

    // As globais saem das linhas INDIVIDUAIS, antes da aba de responsável
    // sobrescrever quem é líder de loja.
    const globais = extrairGlobais(all);

    // Aba "Consultora Resposável" (grafada assim, sem "n", desde o ciclo 10):
    // estas consultoras respondem pela meta da LOJA inteira, não pela individual,
    // e a linha delas aqui SUBSTITUI a da aba "Consultor de loja".
    const leads = [];
    // O nome da aba vem com typo ("Resposável") e o acento pode chegar em NFD, onde
    // o "á" sao dois code points e /[ÁA]/ nao casa. Se este find falhar a falha e
    // SILENCIOSA: leads fica vazio e a meta de cada loja vira a SOMA das individuais
    // em vez do valor oficial da lider — o erro dos R$ 702 mil descrito acima.
    const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
    const respSheet = wb.SheetNames.find(s => /RESPO?N?S[AÁ]VE(L|IS)/i.test(semAcento(s)));
    if (respSheet) {
      for (const [n, m] of Object.entries(parseComSheet(XLSX, wb, respSheet))) {
        const lead = { storeLead: true, papel: 'lead' };
        for (const k of ['receita', 'boletoMedio', 'skin']) if (m[k] != null) lead[k] = m[k];
        all[n] = lead;
        leads.push(n);
      }
    }

    // storeLead:false EXPLICITO para quem nao e responsavel. O servidor faz MERGE
    // do cadastro (`{...existente, ...novas}`), entao chave ausente e chave
    // preservada: sem escrever o false, quem deixou de ser responsavel continuaria
    // marcada para sempre, e a DM dela compararia o faturamento da LOJA INTEIRA
    // contra a meta individual. Cenario real do ciclo 12: as metas voltam a ser
    // individuais e so a Maryanna (Sao Sebastiao) segue respondendo pela loja.
    for (const [n, m] of Object.entries(all)) {
      if (!m.storeLead) m.storeLead = false;
    }

    // Nome curto da planilha → chave do cadastro. Roda DEPOIS da aba de responsável
    // para que `leads` acompanhe o nome novo — senão `leads` diria "BRUNA" enquanto
    // `metas` já teria "BRUNA SOARES".
    const renomear = (de, para) => {
      if (!all[de]) return;
      all[para] = { ...(all[para] || {}), ...all[de] };
      delete all[de];
      const i = leads.indexOf(de);
      if (i >= 0) leads[i] = para;
    };

    // JÚNIOR → JOSENILDO (a planilha usa o apelido em algumas abas)
    renomear('JÚNIOR', 'JOSENILDO');
    renomear('JUNIOR', 'JOSENILDO');
    // ANNY → JULIENE: a comissão traz "ANNY" na aba de loja digital em TODOS os
    // ciclos (nunca atualizaram o nome), mas quem opera o canal desde 20/07/2026
    // (ciclo 11) é a JULIENE REIS.
    // No import retroativo de ciclo anterior ao 11 quem trabalhou foi a Anny mesmo:
    // renomear ali jogaria o resultado dela na conta da Juliene, que nem estava na
    // empresa — por isso digitalEhJuliene vem false nesse caminho.
    if (digitalEhJuliene) renomear('ANNY', 'JULIENE');
    // BRUNA → BRUNA SOARES: existem DUAS Brunas e a comissão só traz o primeiro nome
    // — BRUNA RAYANE (Coruripe 24670) e BRUNA SOARES (Palmeira 24668). A chave
    // "BRUNA" do cadastro é a Rayane, então sem este rename tudo que a planilha
    // escreve como "BRUNA" cai nela e a Soares fica sem meta nenhuma. Foi o erro do
    // ciclo 12, corrigido a mão por scripts/fix-bruna-ciclo12.js.
    // Do ciclo 12 em diante o bloco é da SOARES: ele fica entre YASMIN e CECÍLIA (as
    // duas de Palmeira) e a Rayane está de licença (`paused` no cadastro). No ciclo
    // 11 e antes o bloco era da Rayane — ela era a Consultora Responsável do
    // Coruripe —, por isso o import retroativo passa brunaEhSoares:false.
    // SE A RAYANE VOLTAR DA LICENÇA, ESTE RENAME TEM QUE SAIR.
    if (brunaEhSoares) renomear('BRUNA', 'BRUNA SOARES');

    return { metas: all, globais, abasAusentes, abasVazias, leads };
  }

  // Linhas que NAO SAO PESSOA: rotulo de papel ("GERENTE CANAL LOJA") e totalizadores.
  // Isto e estrutura da planilha e vale para qualquer ciclo, inclusive os passados.
  const NAO_E_PESSOA = /^(GERENTE|TOTAL|RECEITA)/i;

  // SKIP_NAMES acrescenta QUEM SAIU DA EMPRESA — e portanto nao recebe Slack nem
  // entra na meta da loja do ciclo corrente. E um filtro sobre a situacao de HOJE:
  // nao pode ser aplicado ao import retroativo, senao apaga a meta de quem
  // trabalhou naquele ciclo (era o caso da Valesca no ciclo 8, R$ 60.035 sumidos
  // da meta do Palmeira). No caminho historico use NAO_E_PESSOA — o catalogo
  // daquele ciclo ja sabe quem estava na rede.
  const SKIP_NAMES = /^(GERENTE|LEIDIANE|VALESCA|ALEXIA|TOTAL|RECEITA)/i;

  const ehGerente = (nome, m) => SKIP_NAMES.test(nome) || (m && m.papel === 'gerente');

  const PDVS = ['24303', '24617', '24668', '24669', '24670', '24671'];

  /**
   * Meta da LOJA a partir das metas por consultora ja com pdv atribuido.
   * Regra unica para o admin (import do ciclo corrente) e para o import
   * retroativo do historico — se as duas divergirem, o mesmo ciclo passa a ter
   * meta de loja diferente conforme o caminho que gravou.
   *
   * @param sellerMetas { NOME: { pdv, receita, skin, boletoMedio, storeLead } }
   * @param opts { historico?: boolean } — no caminho historico, so exclui o que e
   *   estrutural (rotulo de papel e gerente de unidade). Quem foi desligada DEPOIS
   *   trabalhou naquele ciclo e a meta dela compoe a meta da loja de entao; usar
   *   SKIP_NAMES ali derrubaria o Sustentavel do ciclo 8 de R$ 30.000 para R$ 15.000.
   * @returns { pdv: { receitaLoja, skinLoja, boletoMedio } }  (numeros, nao strings)
   */
  function derivarMetasDeLoja(sellerMetas, opts) {
    const historico = !!(opts && opts.historico);
    const fora = (n, m) => historico
      ? (NAO_E_PESSOA.test(n) || (m && m.papel === 'gerente'))
      : ehGerente(n, m);
    const out = {};
    for (const pdv of PDVS) {
      const sellers = Object.entries(sellerMetas)
        .filter(([n, m]) => m.pdv === pdv && !fora(n, m));
      if (!sellers.length) continue;
      // Com consultora responsavel, a meta oficial da loja e a DELA (aba
      // "Consultora Resposável") — nao a soma das individuais, e sem contar a
      // propria lider duas vezes. Sem lider, soma (comportamento antigo).
      const lead = sellers.find(([, m]) => m.storeLead);
      if (lead) {
        out[pdv] = {
          receitaLoja: lead[1].receita || 0,
          skinLoja: lead[1].skin || 0,
          boletoMedio: lead[1].boletoMedio ? Math.round(lead[1].boletoMedio) : null,
        };
      } else {
        const bms = sellers.filter(([, m]) => m.boletoMedio).map(([, m]) => m.boletoMedio);
        out[pdv] = {
          receitaLoja: sellers.reduce((s, [, m]) => s + (m.receita || 0), 0),
          skinLoja: sellers.reduce((s, [, m]) => s + (m.skin || 0), 0),
          boletoMedio: bms.length ? Math.round(bms.reduce((a, b) => a + b, 0) / bms.length) : null,
        };
      }
    }
    return out;
  }

  global.ComissaoParser = { parseComissaoWorkbook, derivarMetasDeLoja, ehGerente, COM_VAR_MAP, METAS_FUTURAS, SKIP_NAMES, NAO_E_PESSOA, PDVS };
})(window);
