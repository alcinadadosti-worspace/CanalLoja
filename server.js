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

// ---------- API ----------
app.post('/api/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[(username || '').toLowerCase().trim()];
  if (!u) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password || '', u.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  setCookie(res, u.username);
  res.json(publicProfile(u.username));
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

// ---------- Static ----------
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
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
    console.log('[supabase] nao configurado — usando apenas memoria');
    return;
  }
  try {
    await supa.initBucket();

    const metas = await supa.getMetas(META_DEFAULTS);
    Object.assign(metaStore, metas);
    console.log('[supabase] metas restauradas');

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
  } catch (e) {
    console.warn('[supabase] falha ao restaurar:', e.message);
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
