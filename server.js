// Аудитор встреч продаж. Без внешних зависимостей: node --env-file=.env server.js

import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcribe, extForMime, UserError } from './lib/transcribe.js';
import { buildPrompt } from './lib/prompt.js';
import { streamAnalysis, providerInfo } from './lib/llm.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SESSION_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
}

async function saveFile(sessionId, name, content) {
  try {
    const dir = path.join(DATA_DIR, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), content);
  } catch (e) {
    console.error(`Не удалось сохранить ${name}:`, e.message);
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError(`Слишком большой запрос (лимит ${Math.round(limit / 1048576)} МБ).`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleTranscribe(req, res) {
  const mime = req.headers['content-type'] || 'audio/webm';
  const buffer = await readBody(req, MAX_AUDIO_BYTES);
  const sessionId = newSessionId();
  // Аудио сохраняем до расшифровки: если Whisper упадёт, запись не потеряется.
  if (buffer.length) await saveFile(sessionId, `audio.${extForMime(mime)}`, buffer);
  const { text, duration } = await transcribe(buffer, mime);
  await saveFile(sessionId, 'transcript.txt', text);
  sendJson(res, 200, { sessionId, transcript: text, duration });
}

async function handleAnalyze(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('Некорректный JSON в запросе.');
  }
  const transcript = String(body.transcript || '').trim();
  if (!transcript) throw new UserError('Расшифровка пуста — нечего анализировать.');

  const info = providerInfo();
  if (!info.hasKey) {
    throw new UserError(`Для провайдера "${info.name}" не задан API-ключ в .env.`, 500);
  }

  const sessionId = SESSION_ID_RE.test(body.sessionId || '') ? body.sessionId : newSessionId();
  const meta = { ...(body.meta || {}) };
  if (!String(meta.meetingId || '').trim()) meta.meetingId = sessionId;
  const { system, user } = await buildPrompt(meta, transcript);

  await saveFile(sessionId, 'transcript.txt', transcript);

  // Дальше отвечаем потоком SSE: {delta} — кусок отчёта, {done} — конец, {error} — ошибка.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(); // клиент закрыл страницу — не тратим токены
  });

  let report = '';
  try {
    for await (const delta of streamAnalysis({ system, user, signal: ac.signal })) {
      if (delta.reset) {
        report = '';
        send({ reset: true });
        continue;
      }
      report += delta;
      send({ delta });
    }
    if (!report.trim()) throw new UserError('Модель вернула пустой ответ.', 502);
    await saveFile(sessionId, 'report.md', report);
    send({ done: true, sessionId });
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('Ошибка анализа:', e.message);
      send({ error: e instanceof UserError ? e.message : `Ошибка анализа: ${e.message}` });
    }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      const info = providerInfo();
      return sendJson(res, 200, {
        provider: info.name,
        model: info.model,
        llmReady: info.hasKey,
        whisperReady: !!process.env.OPENAI_API_KEY,
      });
    }
    if (req.method === 'POST' && pathname === '/api/transcribe') return await handleTranscribe(req, res);
    if (req.method === 'POST' && pathname === '/api/analyze') return await handleAnalyze(req, res);
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (!(e instanceof UserError)) console.error(e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: e instanceof UserError ? e.message : 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, () => {
  let info;
  try {
    info = providerInfo();
  } catch (e) {
    console.error(`ВНИМАНИЕ: ${e.message}`);
    info = { name: process.env.LLM_PROVIDER, model: '-', hasKey: false };
  }
  console.log(`Sales Meeting Auditor: http://localhost:${PORT}`);
  console.log(`  Расшифровка: Whisper ${process.env.OPENAI_API_KEY ? '(ключ есть)' : '(НЕТ OPENAI_API_KEY)'}`);
  console.log(`  Анализ: ${info.name} / ${info.model} ${info.hasKey ? '(ключ есть)' : '(НЕТ API-КЛЮЧА)'}`);
});
