const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const { USERS, publicProfile } = require('./config/users');
const { requireApi, requirePage, setCookie, clearCookie } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  res.json(publicProfile(req.username));
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

// ---------- Static (sem auth: só login + assets do login) ----------
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
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
