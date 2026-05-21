const jwt = require('jsonwebtoken');
const { USERS } = require('../config/users');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-render';
const COOKIE_NAME = 'canalloja_session';
const TOKEN_TTL = '12h';

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

// API: returns 401 JSON if not authenticated
function requireApi(req, res, next) {
  const u = verifyCookie(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  req.username = u;
  next();
}

// Page: redirects to /login.html if not authenticated
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

module.exports = { requireApi, requirePage, setCookie, clearCookie, COOKIE_NAME };
