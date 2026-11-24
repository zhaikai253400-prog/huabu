'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');

const FILE = path.join(paths.DATA_DIR, 'admin-auth.json');
const DEFAULT_PASSWORD = 'admin@local';
const sessions = new Map();

function read() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function write(data) {
  paths.ensureDir(paths.DATA_DIR);
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}

function ensureDefault() {
  let data = read();
  if (data && data.hash && data.salt) return data;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(DEFAULT_PASSWORD, salt);
  data = { hash, salt, updatedAt: Date.now(), defaultHint: DEFAULT_PASSWORD };
  write(data);
  return data;
}

function status() {
  ensureDefault();
  return {
    needSetup: false,
    unlocked: false,
    defaultHint: DEFAULT_PASSWORD,
  };
}

function setup(password) {
  if (String(password || '').length < 6) {
    const err = new Error('口令至少 6 位');
    err.code = 'TOO_SHORT';
    throw err;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  write({ hash, salt, updatedAt: Date.now() });
  return createSession();
}

function login(password) {
  const data = ensureDefault();
  const hash = hashPassword(password, data.salt);
  if (hash !== data.hash) {
    const err = new Error('口令错误');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  return createSession();
}

function createSession() {
  const session = crypto.randomBytes(24).toString('hex');
  sessions.set(session, { at: Date.now() });
  return { session };
}

function logout(session) {
  if (session) sessions.delete(String(session));
  return { ok: true };
}

function validSession(session) {
  if (!session) return false;
  const row = sessions.get(String(session));
  if (!row) return false;
  if (Date.now() - row.at > 12 * 3600 * 1000) {
    sessions.delete(String(session));
    return false;
  }
  row.at = Date.now();
  return true;
}

module.exports = {
  status,
  setup,
  login,
  logout,
  validSession,
  DEFAULT_PASSWORD,
};
