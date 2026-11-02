'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 日志按天分文件，这里列出已有的日期，最新的排前面
function listDays() {
  try {
    return fs
      .readdirSync(paths.LOG_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .map((name) => name.replace(/\.log$/, ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function fileOf(day) {
  const clean = String(day || '').trim();
  if (!DAY_PATTERN.test(clean)) return null;
  const file = path.join(paths.LOG_DIR, clean + '.log');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function readDay(day, tail) {
  const file = fileOf(day);
  if (!file) return [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  const limit = Number(tail) > 0 ? Number(tail) : 500;
  return lines.slice(-limit);
}

function sizeOf(day) {
  const file = fileOf(day);
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

module.exports = { listDays, fileOf, readDay, sizeOf };
