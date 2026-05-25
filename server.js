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

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Storage em memória das 5 planilhas. Some quando o servidor dorme (Free tier)
// — admin re-faz upload de manhã. Cabe ~70 KB total, irrelevante pra RAM.
const FILE_KEYS = ['resumo', 'bbx', 'servicosRealizados', 'cuidadosFaciais', 'lojaDigital'];
const fileStore = {};

const metaStore = {
  metaPRM: '33', metaTurbinado: '31', metaID: '115',
  metaNPS: '90', metaResgate: '52', metaBBX: '20',
  metaItensBoleto: '2.7', metaAuditoria: '95',
  metaDigitalReceita: '15000', metaDigitalConversao: '12', metaDigitalBM: '190',
};

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---------- API ----------
app.post('/api/login', async (req, res) => {
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
app.post('/api/admin/login', async (req, res) => {
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

// Legacy — mantido para compatibilidade
app.post('/api/admin/verify', requireApi, async (req, res) => {
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

// Recebe bytes brutos (multipart é overkill pra 1 arquivo por request)
const RAW_XLSX = express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  limit: '10mb',
});
app.post('/api/admin/upload', requireAdminOnly, RAW_XLSX, (req, res) => {
  const key = req.query.key;
  const filename = String(req.query.filename || '').slice(0, 200) || `upload-${Date.now()}.xlsx`;
  if (!FILE_KEYS.includes(key)) return res.status(400).json({ error: 'invalid_key' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'no_data' });
  fileStore[key] = {
    filename, bytes: req.body,
    mtime: new Date().toISOString(),
    uploader: req.username,
    size: req.body.length,
  };
  res.json({ ok: true, key, size: req.body.length, mtime: fileStore[key].mtime });
});

// ---------- Metas globais (em memória, admin gerencia) ----------
app.get('/api/metas', (req, res) => {
  res.json({ ...metaStore });
});

app.post('/api/metas', requireAdminOnly, (req, res) => {
  const updates = req.body || {};
  for (const [key, val] of Object.entries(updates)) {
    if (key in metaStore) metaStore[key] = String(val);
  }
  res.json({ ok: true, metas: { ...metaStore } });
});

// Metadados — qualquer usuária logada ou admin pode ver o que tem disponível
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

// Bytes da planilha — qualquer usuária logada ou admin baixa
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

// Placeholder — quando implementar o bot Slack, usar o webhook do .env
app.post('/api/slack/send', requireApi, async (req, res) => {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return res.status(501).json({ error: 'slack_not_configured',
      hint: 'defina SLACK_WEBHOOK_URL no ambiente' });
  }
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'missing_text' });
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

// ---------- Static (sem auth: login + admin) ----------
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// ---------- Página principal protegida ----------
// Lê index.html do disco e injeta window.currentUser antes de servir
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

function renderIndex(username) {
  const profile = publicProfile(username);
  const inject = `<script>window.currentUser = ${JSON.stringify(profile)};</script>`;
  return INDEX_TEMPLATE.replace('<!--USER_INJECT-->', inject);
}

app.get(['/', '/index.html'], requirePage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderIndex(req.username));
});

// Demais arquivos do /public/ exigem auth (ex: auth.js do app principal)
app.use(requirePage, express.static(PUBLIC_DIR, { index: false }));

app.listen(PORT, () => {
  console.log(`canalloja rodando em http://localhost:${PORT}`);
});
