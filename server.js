require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const { USERS, publicProfile } = require('./config/users');
const { ADMIN_PASSWORD_HASH } = require('./config/admin');
const {
  requireApi, requirePage, setCookie, clearCookie,
  setAdminCookie, clearAdminCookie, isAdmin, requireAdmin,
  requireAdminOnly, requireAnyAuth,
} = require('./middleware/auth');
const supa = require('./lib/supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const FILE_KEYS = ['resumo', 'bbx', 'servicosRealizados', 'cuidadosFaciais', 'lojaDigital'];
const fileStore = {};

const META_DEFAULTS = {
  metaPRM: '33', metaTurbinado: '31', metaID: '115',
  metaNPS: '90', metaResgate: '52', metaBBX: '20',
  metaItensBoleto: '2.7', metaAuditoria: '95',
  metaDigitalReceita: '15000', metaDigitalConversao: '12', metaDigitalBM: '190',
};
const metaStore = { ...META_DEFAULTS };
const storeMetasStore = {};
const sellerMetasStore = {};
const historicoStore = {};   // { "<ciclo>": snapshot } — ver /api/historico
const serieDiariaStore = {}; // { "<ciclo>": { "<dia>": { "<pdv>": {...} } } } — ver /api/serie-diaria

// A restauracao do boot e a UNICA coisa que enche os stores acima. Se ela falhar
// por rede/timeout/5xx, eles ficam VAZIOS — e como todo POST persiste o store
// INTEIRO (ex.: saveSellerMetas({...sellerMetasStore})), a primeira edicao no admin
// gravaria esse vazio por cima do cadastro real e do historico no Supabase.
// O lib/supabase.js ja propaga erro que nao seja 404 exatamente para isso ser
// detectavel; aqui a gente se recusa a ESCREVER ate um boot completo dar certo.
// Ler continua liberado: o painel abre, so nao persiste nada.
let restauracaoOk = false;
function bloqueadoPorRestauracao(res) {
  if (restauracaoOk) return false;
  res.status(503).json({
    error: 'restauracao_incompleta',
    message: 'O servidor subiu sem conseguir ler os dados do Supabase. '
           + 'Gravar agora apagaria o que esta la. Reinicie o servico e tente de novo.',
  });
  return true;
}

// Calendario dos ciclos (datas oficiais do Boticario). O app so conhece a string
// de periodo da aba FILTROS das planilhas; este mapa e quem diz "isso e o ciclo 10".
const CICLOS = require('./config/ciclos-2026.json');

// ---------- Rate limiter (login endpoints) ----------
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of loginAttempts) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, recent);
  }
}, 60_000).unref();

function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const times = (loginAttempts.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Muitas tentativas. Tente novamente em 15 minutos.' });
  }
  times.push(now);
  loginAttempts.set(ip, times);
  next();
}

const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---------- CSRF: reject state-changing requests from foreign origins ----------
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.headers.origin || req.headers.referer;
  if (!source) return next();
  try {
    const url = new URL(source);
    if (url.host !== req.headers.host) {
      return res.status(403).json({ error: 'csrf_rejected' });
    }
  } catch {
    return res.status(403).json({ error: 'csrf_rejected' });
  }
  next();
});

// ---------- Health check (publico, para UptimeRobot/Render) ----------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ---------- API ----------
app.post('/api/login', loginRateLimit, async (req, res) => {
  // Login só com senha (sem usuário): confere a senha contra os acessos
  // cadastrados e entra como o primeiro que casar.
  const { password } = req.body || {};
  for (const u of Object.values(USERS)) {
    if (await bcrypt.compare(password || '', u.passwordHash)) {
      setCookie(res, u.username);
      return res.json(publicProfile(u.username));
    }
  }
  return res.status(401).json({ error: 'invalid_credentials' });
});

app.post('/api/logout', (req, res) => {
  clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireApi, (req, res) => {
  res.json({ ...publicProfile(req.username), isAdmin: isAdmin(req) });
});

// ---------- Admin: senha mestra desbloqueia upload de planilhas ----------
app.post('/api/admin/login', loginRateLimit, async (req, res) => {
  const { password } = req.body || {};
  const ok = await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'invalid_admin_password' });
  setAdminCookie(res);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: isAdmin(req) });
});

// Legacy
app.post('/api/admin/verify', requireApi, loginRateLimit, async (req, res) => {
  const { password } = req.body || {};
  const ok = await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: 'invalid_admin_password' });
  setAdminCookie(res);
  res.json({ ok: true });
});

app.post('/api/admin/lock', requireApi, (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// Recebe bytes brutos
const RAW_XLSX = express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  limit: '10mb',
});
app.post('/api/admin/upload', requireAdminOnly, RAW_XLSX, async (req, res) => {
  const key = req.query.key;
  if (!FILE_KEYS.includes(key)) return res.status(400).json({ error: 'invalid_key' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'no_data' });

  let filename = String(req.query.filename || '').slice(0, 200).trim();
  if (!filename) filename = `upload-${Date.now()}.xlsx`;
  if (UNSAFE_FILENAME_CHARS.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'invalid_filename', message: 'Nome do arquivo contem caracteres invalidos.' });
  }

  const meta = {
    filename, mtime: new Date().toISOString(),
    uploader: req.username, size: req.body.length,
  };
  fileStore[key] = { ...meta, bytes: req.body };

  let backupOk = true;
  try { await supa.uploadFile(key, req.body, meta); }
  catch (e) { console.warn('[supabase] upload:', e.message); backupOk = false; }

  const resp = { ok: true, key, size: req.body.length, mtime: meta.mtime };
  if (!backupOk) resp.warning = 'Arquivo salvo em memoria, mas backup na nuvem falhou.';
  res.json(resp);
});

// Limpa todas as planilhas (admin)
app.post('/api/admin/clear-files', requireAdminOnly, async (req, res) => {
  for (const key of FILE_KEYS) delete fileStore[key];
  let backupOk = true;
  try { await supa.deleteAllFiles(FILE_KEYS); }
  catch (e) { console.warn('[supabase] clear:', e.message); backupOk = false; }
  const resp = { ok: true };
  if (!backupOk) resp.warning = 'Memoria limpa, mas erro ao remover da nuvem.';
  res.json(resp);
});

// ---------- Metas globais ----------
app.get('/api/metas', (req, res) => {
  res.json({ ...metaStore });
});

app.post('/api/metas', requireAdminOnly, async (req, res) => {
  if (bloqueadoPorRestauracao(res)) return;
  const updates = req.body || {};
  for (const [key, val] of Object.entries(updates)) {
    if (!(key in metaStore)) continue;
    const str = String(val).trim().replace(',', '.');
    if (str.length > 20) {
      return res.status(400).json({ error: 'invalid_meta', message: `${key}: valor muito longo.` });
    }
    const num = Number(str);
    if (isNaN(num) || num < 0 || num > 999999) {
      return res.status(400).json({ error: 'invalid_meta', message: `${key}: deve ser um numero entre 0 e 999999.` });
    }
    metaStore[key] = str;
  }
  let backupOk = true;
  try { await supa.saveMetas({ ...metaStore }); }
  catch (e) { console.warn('[supabase] metas:', e.message); backupOk = false; }
  const resp = { ok: true, metas: { ...metaStore } };
  if (!backupOk) resp.warning = 'Metas salvas em memoria, mas backup na nuvem falhou.';
  res.json(resp);
});

// ---------- Metas por loja ----------
app.get('/api/store-metas', requireAnyAuth, (req, res) => {
  res.json({ ...storeMetasStore });
});

app.post('/api/store-metas/:pdv', requireAdminOnly, async (req, res) => {
  if (bloqueadoPorRestauracao(res)) return;
  const pdv = req.params.pdv;
  if (!/^\d{4,6}$/.test(pdv)) return res.status(400).json({ error: 'invalid_pdv' });
  const updates = req.body || {};
  if (!storeMetasStore[pdv]) storeMetasStore[pdv] = {};
  for (const [key, val] of Object.entries(updates)) {
    const str = String(val).trim().replace(',', '.');
    if (str === '') { delete storeMetasStore[pdv][key]; continue; }
    if (str.length > 20) continue;
    storeMetasStore[pdv][key] = str;
  }
  let backupOk = true;
  try { await supa.saveStoreMetas({ ...storeMetasStore }); }
  catch (e) { console.warn('[supabase] store-metas:', e.message); backupOk = false; }
  const resp = { ok: true, pdv, metas: storeMetasStore[pdv] };
  if (!backupOk) resp.warning = 'Metas salvas em memoria, mas backup falhou.';
  res.json(resp);
});

// ---------- Metas por consultora ----------
app.get('/api/seller-metas', requireAnyAuth, (req, res) => {
  res.json({ ...sellerMetasStore });
});

app.post('/api/seller-metas', requireAdminOnly, async (req, res) => {
  if (bloqueadoPorRestauracao(res)) return;
  const updates = req.body || {};
  for (const [name, metas] of Object.entries(updates)) {
    if (typeof metas !== 'object' || !metas) continue;
    sellerMetasStore[name] = { ...(sellerMetasStore[name] || {}), ...metas };
  }
  let backupOk = true;
  try { await supa.saveSellerMetas({ ...sellerMetasStore }); }
  catch (e) { console.warn('[supabase] seller-metas:', e.message); backupOk = false; }
  const resp = { ok: true, count: Object.keys(sellerMetasStore).length };
  if (!backupOk) resp.warning = 'Metas salvas em memoria, mas backup falhou.';
  res.json(resp);
});

// ---------- Historico por ciclo ----------
// Calendario oficial dos ciclos — o front usa pra traduzir "PERIODO ATUAL" em numero de ciclo.
app.get('/api/ciclos', requireAnyAuth, (req, res) => res.json(CICLOS));

app.get('/api/historico', requireAnyAuth, (req, res) => {
  res.json({ ...historicoStore });
});

// Grava o snapshot de UM ciclo. Dois caminhos:
//  - origem 'auto': gerado sozinho quando o painel carrega as planilhas do servidor.
//  - origem 'retroativo': import manual de um ciclo passado (planilhas locais no painel).
// Guarda contra aba velha esquecida aberta: um snapshot 'auto' nao sobrescreve ciclo
// que fechou ha mais de 30 dias. Import retroativo e sempre explicito, entao passa.
app.post('/api/historico', requireAnyAuth, async (req, res) => {
  if (bloqueadoPorRestauracao(res)) return;
  const s = req.body || {};
  const ciclo = parseInt(s.ciclo, 10);
  if (!Number.isInteger(ciclo) || ciclo < 1 || ciclo > 40) {
    return res.status(400).json({ error: 'ciclo_invalido' });
  }
  if (typeof s.periodo !== 'string' || !s.periodo.trim()) {
    return res.status(400).json({ error: 'periodo_ausente' });
  }
  if (typeof s.lojas !== 'object' || !s.lojas || typeof s.consultoras !== 'object' || !s.consultoras) {
    return res.status(400).json({ error: 'payload_invalido' });
  }
  const key = String(ciclo);
  const existente = historicoStore[key];
  const origem = s.origem === 'retroativo' ? 'retroativo' : 'auto';
  if (origem === 'auto' && existente) {
    const fim = new Date(s.fim || 0).getTime();
    if (!fim || Date.now() - fim > 30 * 24 * 60 * 60 * 1000) {
      return res.status(409).json({
        error: 'ciclo_antigo',
        message: `Ciclo ${ciclo} ja tem snapshot e fechou ha mais de 30 dias. Use o import retroativo para sobrescrever.`,
      });
    }
  }
  historicoStore[key] = {
    ciclo,
    periodo: String(s.periodo).slice(0, 60),
    inicio: s.inicio || null,
    fim: s.fim || null,
    dias: Number(s.dias) || null,
    // ciclo ainda em curso: o IAF do snapshot e parcial, a aba mostra "em curso"
    fechado: !!s.fechado,
    origem,
    atualizadoEm: new Date().toISOString(),
    lojas: s.lojas,
    consultoras: s.consultoras,
    digital: s.digital || null,
    metasGlobais: s.metasGlobais || null,
    // Servicos por dia so vem do relatorio v1 (com DATA REALIZACAO). A producao usa
    // o v2, que nao tem data — entao o snapshot 'auto' NAO produz esta serie e nao
    // pode apagar a que o import retroativo gravou. Preserva a existente.
    servicosPorDia: (s.servicosPorDia && typeof s.servicosPorDia === 'object' && Object.keys(s.servicosPorDia).length)
      ? s.servicosPorDia
      : (existente?.servicosPorDia || null),
    servicosPorTipo: (s.servicosPorTipo && typeof s.servicosPorTipo === 'object' && Object.keys(s.servicosPorTipo).length)
      ? s.servicosPorTipo
      : (existente?.servicosPorTipo || null),
    servicosPorConsultora: (s.servicosPorConsultora && typeof s.servicosPorConsultora === 'object' && Object.keys(s.servicosPorConsultora).length)
      ? s.servicosPorConsultora
      : (existente?.servicosPorConsultora || null),
    // ciclos 1-7 nao tem planilha de comissao — o front marca aqui pra UI
    // mostrar "—" em vez de 0% nas colunas de atingimento e segmento.
    semMetas: !!s.semMetas,
  };
  let backupOk = true;
  try { await supa.saveHistorico({ ...historicoStore }); }
  catch (e) { console.warn('[supabase] historico:', e.message); backupOk = false; }
  const resp = { ok: true, ciclo, ciclos: Object.keys(historicoStore).length, substituiu: !!existente };
  if (!backupOk) resp.warning = 'Snapshot salvo em memoria, mas backup na nuvem falhou.';
  res.json(resp);
});

// ---------- Serie diaria (curva de ritmo dentro do ciclo) ----------
// Uma foto por dia do ACUMULADO do ciclo. O snapshot do historico guarda so o
// estado final; sem isto a trajetoria DENTRO do ciclo se perde a cada upload,
// e "no dia 10 de 21, 45% da meta e bom ou ruim?" fica sem resposta.
// Nao ha reconstrucao possivel depois — por isso grava desde o primeiro upload.
app.get('/api/serie-diaria', requireAnyAuth, (req, res) => {
  res.json({ ...serieDiariaStore });
});

const SERIE_MAX_DIAS = 45;        // ciclo mais longo tem 28 dias; folga pra erro de calendario
const SERIE_MAX_CICLOS = 40;

app.post('/api/serie-diaria', requireAnyAuth, async (req, res) => {
  if (bloqueadoPorRestauracao(res)) return;
  const b = req.body || {};
  const ciclo = parseInt(b.ciclo, 10);
  if (!Number.isInteger(ciclo) || ciclo < 1 || ciclo > 40) {
    return res.status(400).json({ error: 'ciclo_invalido' });
  }
  if (typeof b.dia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dia)) {
    return res.status(400).json({ error: 'dia_invalido' });
  }
  if (typeof b.lojas !== 'object' || !b.lojas) {
    return res.status(400).json({ error: 'payload_invalido' });
  }
  // So numeros, so os campos previstos: o payload vem do navegador e este arquivo
  // e lido inteiro pela aba — nao pode virar deposito de qualquer coisa.
  const lojas = {};
  for (const [pdv, v] of Object.entries(b.lojas)) {
    if (!/^\d{4,6}$/.test(pdv) || typeof v !== 'object' || !v) continue;
    const reg = {};
    for (const k of ['receita', 'skin', 'servicos', 'boletos']) {
      const n = Number(v[k]);
      if (Number.isFinite(n)) reg[k] = Math.round(n * 100) / 100;
    }
    if (Object.keys(reg).length) lojas[pdv] = reg;
  }
  if (!Object.keys(lojas).length) return res.status(400).json({ error: 'sem_lojas_validas' });

  const key = String(ciclo);
  if (!serieDiariaStore[key]) serieDiariaStore[key] = {};
  // Reescreve o ponto do dia: varios uploads no mesmo dia devem deixar o ultimo,
  // que e o acumulado mais completo daquele dia.
  serieDiariaStore[key][b.dia] = lojas;

  // Poda: mantem os dias mais recentes do ciclo e os ciclos mais recentes.
  const dias = Object.keys(serieDiariaStore[key]).sort();
  for (const d of dias.slice(0, Math.max(0, dias.length - SERIE_MAX_DIAS))) {
    delete serieDiariaStore[key][d];
  }
  const ciclos = Object.keys(serieDiariaStore).map(Number).sort((a, b2) => a - b2);
  for (const c of ciclos.slice(0, Math.max(0, ciclos.length - SERIE_MAX_CICLOS))) {
    delete serieDiariaStore[String(c)];
  }

  let backupOk = true;
  try { await supa.saveSerieDiaria({ ...serieDiariaStore }); }
  catch (e) { console.warn('[supabase] serie-diaria:', e.message); backupOk = false; }
  const resp = { ok: true, ciclo, dia: b.dia, dias: Object.keys(serieDiariaStore[key]).length };
  if (!backupOk) resp.warning = 'Ponto salvo em memoria, mas backup na nuvem falhou.';
  res.json(resp);
});

// Metadados
app.get('/api/files', requireAnyAuth, (req, res) => {
  const out = {};
  for (const k of FILE_KEYS) {
    if (fileStore[k]) {
      const { filename, mtime, uploader, size } = fileStore[k];
      out[k] = { filename, mtime, uploader, size };
    } else {
      out[k] = null;
    }
  }
  res.json(out);
});

// Bytes da planilha
app.get('/api/files/:key', requireAnyAuth, (req, res) => {
  const k = req.params.key;
  if (!FILE_KEYS.includes(k)) return res.status(400).json({ error: 'invalid_key' });
  const f = fileStore[k];
  if (!f) return res.status(404).json({ error: 'not_uploaded' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.filename)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(f.bytes);
});

// Placeholder Slack
app.post('/api/slack/send', requireApi, async (req, res) => {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return res.status(501).json({ error: 'slack_not_configured',
      hint: 'defina SLACK_WEBHOOK_URL no ambiente' });
  }
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'missing_text' });
  if (text.length > 10000) return res.status(400).json({ error: 'text_too_long' });
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`slack ${r.status}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'slack_failed', message: e.message });
  }
});

// ---------- Slack DM ----------
app.post('/api/slack/dm', requireAnyAuth, async (req, res) => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(501).json({ error: 'slack_bot_not_configured' });
  const { channel, text, blocks } = req.body || {};
  if (!channel || typeof channel !== 'string') return res.status(400).json({ error: 'missing_channel' });
  if (!text && !blocks) return res.status(400).json({ error: 'missing_text_or_blocks' });
  try {
    const payload = { channel };
    if (text) payload.text = text;
    if (blocks) payload.blocks = blocks;
    payload.mrkdwn = true;
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) return res.status(502).json({ error: 'slack_error', detail: j.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'slack_failed', message: e.message });
  }
});

// ---------- Static ----------
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});
// Parser da comissao: precisa ficar FORA do static protegido por requirePage.
// O admin.html e servido sem o cookie de usuario (tem senha propria), entao um
// <script src> dele para dentro do static levava redirect pro login e a pagina
// recebia HTML no lugar do JS — quebrando o import de comissao. Sem segredo aqui,
// e so a logica de leitura da planilha.
app.get('/comissao-parser.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'comissao-parser.js'));
});

// Pagina principal protegida
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

function renderIndex(username) {
  const profile = publicProfile(username);
  const json = JSON.stringify(profile).replace(/</g, '\\u003c');
  const inject = `<script>window.currentUser = ${json};</script>`;
  return INDEX_TEMPLATE.replace('<!--USER_INJECT-->', inject);
}

app.get(['/', '/index.html'], requirePage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderIndex(req.username));
});

app.use(requirePage, express.static(PUBLIC_DIR, { index: false }));

// ---------- Startup: restaura dados do Supabase ----------
async function restoreFromSupabase() {
  if (!supa.isConfigured()) {
    // Sem Supabase nao existe nada na nuvem para destruir: modo memoria e liberado.
    console.log('[supabase] nao configurado — usando apenas memoria');
    restauracaoOk = true;
    return;
  }
  try {
    await supa.initBucket();

    const metas = await supa.getMetas(META_DEFAULTS);
    Object.assign(metaStore, metas);
    console.log('[supabase] metas restauradas');

    const sm = await supa.getStoreMetas();
    Object.assign(storeMetasStore, sm);
    if (Object.keys(sm).length) console.log(`[supabase] metas por loja restauradas (${Object.keys(sm).length} lojas)`);

    const slm = await supa.getSellerMetas();
    Object.assign(sellerMetasStore, slm);
    if (Object.keys(slm).length) console.log(`[supabase] metas por consultora restauradas (${Object.keys(slm).length} pessoas)`);

    const hist = await supa.getHistorico();
    Object.assign(historicoStore, hist);
    if (Object.keys(hist).length) console.log(`[supabase] historico restaurado (${Object.keys(hist).length} ciclo(s))`);

    const serie = await supa.getSerieDiaria();
    Object.assign(serieDiariaStore, serie);
    if (Object.keys(serie).length) {
      const pts = Object.values(serie).reduce((n, c) => n + Object.keys(c).length, 0);
      console.log(`[supabase] serie diaria restaurada (${Object.keys(serie).length} ciclo(s), ${pts} dia(s))`);
    }

    const filesMeta = await supa.getFilesMeta();
    let count = 0;
    for (const [key, meta] of Object.entries(filesMeta)) {
      if (!FILE_KEYS.includes(key)) continue;
      const bytes = await supa.downloadFile(key);
      if (bytes) {
        fileStore[key] = { ...meta, bytes };
        count++;
      }
    }
    if (count) console.log(`[supabase] ${count} planilha(s) restaurada(s)`);

    // So aqui: todo o estado veio da nuvem, entao gravar por cima e seguro.
    restauracaoOk = true;
  } catch (e) {
    console.error('[supabase] FALHA AO RESTAURAR:', e.message);
    console.error('[supabase] GRAVACOES BLOQUEADAS (HTTP 503) ate um boot completo. '
                + 'O servidor esta no ar so para leitura — reinicie quando o Supabase voltar.');
  }
}

(async () => {
  await restoreFromSupabase();
  const server = app.listen(PORT, () => {
    console.log(`canalloja rodando em http://localhost:${PORT}`);
  });
  function shutdown(signal) {
    console.log(`[${signal}] Encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
