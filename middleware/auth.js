const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { USERS } = require('../config/users');

const SECRET = (function resolveSecret() {
  const env = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!env || env === 'dev-secret-change-me-in-render') {
      console.error('[FATAL] JWT_SECRET nao definido em producao. Encerrando.');
      process.exit(1);
    }
    return env;
  }
  if (env) return env;
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET nao definido — usando segredo aleatorio (sessoes nao sobrevivem restart)');
  return generated;
})();

const COOKIE_NAME = 'canalloja_session';
const ADMIN_COOKIE = 'canalloja_admin';
const TOKEN_TTL = '12h';
const ADMIN_TTL = '4h';

function sign(username) {
  return jwt.sign({ u: username }, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyCookie(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const { u } = jwt.verify(token, SECRET);
    return USERS[u] ? u : null;
  } catch {
    return null;
  }
}

function requireApi(req, res, next) {
  const u = verifyCookie(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  req.username = u;
  next();
}

function requirePage(req, res, next) {
  const u = verifyCookie(req);
  if (!u) return res.redirect('/login.html');
  req.username = u;
  next();
}

function setCookie(res, username) {
  const token = sign(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function signAdmin() {
  return jwt.sign({ admin: true }, SECRET, { expiresIn: ADMIN_TTL });
}

function setAdminCookie(res) {
  res.cookie(ADMIN_COOKIE, signAdmin(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 4 * 60 * 60 * 1000,
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
}

function isAdmin(req) {
  const t = req.cookies?.[ADMIN_COOKIE];
  if (!t) return false;
  try {
    jwt.verify(t, SECRET);
    return true;
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'not_admin' });
  next();
}

function requireAdminOnly(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'not_admin' });
  const u = verifyCookie(req);
  req.username = u || 'admin';
  next();
}

function requireAnyAuth(req, res, next) {
  const u = verifyCookie(req);
  if (u) { req.username = u; return next(); }
  if (isAdmin(req)) { req.username = 'admin'; return next(); }
  return res.status(401).json({ error: 'unauthenticated' });
}

module.exports = {
  requireApi, requirePage, setCookie, clearCookie, COOKIE_NAME,
  setAdminCookie, clearAdminCookie, isAdmin, requireAdmin,
  requireAdminOnly, requireAnyAuth, ADMIN_COOKIE,
};
