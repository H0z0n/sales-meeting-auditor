// Провайдеры LLM с единым интерфейсом: async *streamAnalysis({ system, user, signal }) -> куски текста.
// Выбор провайдера: LLM_PROVIDER=anthropic | openai (в .env).

import { UserError } from './transcribe.js';

// Разбор SSE-потока от провайдера: отдаёт объекты { event, data } (data — строка).
async function* sseEvents(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

async function failFromResponse(res, name) {
  const body = await res.text();
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.error?.message || body;
  } catch {}
  const err = new UserError(`${name} вернул ошибку ${res.status}: ${msg}`, 502);
  err.transient = [429, 500, 502, 503, 504, 529].includes(res.status);
  throw err;
}

const TRANSIENT_RE = /high demand|overloaded|unavailable|try again|rate limit|fetch failed|socket|reset|timeout/i;
function transientError(message, status = 502) {
  const e = new UserError(message, status);
  e.transient = true;
  return e;
}

async function* anthropic({ system, user, signal }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new UserError('Не задан ANTHROPIC_API_KEY в файле .env (LLM_PROVIDER=anthropic).', 500);

  let res;
  try {
    res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: Number(process.env.MAX_OUTPUT_TOKENS) || 16000,
        stream: true,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw new UserError(`Не удалось связаться с Anthropic: ${e.message}`, 502);
  }
  if (!res.ok) await failFromResponse(res, 'Anthropic API');

  for await (const ev of sseEvents(res)) {
    let j;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text;
    else if (j.type === 'message_delta' && j.delta?.stop_reason === 'max_tokens')
      yield '\n\n> ⚠️ Отчёт обрезан по лимиту токенов. Увеличьте MAX_OUTPUT_TOKENS в .env.';
    else if (j.type === 'error') throw new UserError(`Anthropic: ${j.error?.message || 'ошибка потока'}`, 502);
  }
}

async function* openai({ system, user, signal }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new UserError('Не задан OPENAI_API_KEY в файле .env.', 500);

  let res;
  try {
    res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        max_completion_tokens: Number(process.env.MAX_OUTPUT_TOKENS) || 16000,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw new UserError(`Не удалось связаться с OpenAI: ${e.message}`, 502);
  }
  if (!res.ok) await failFromResponse(res, 'OpenAI API');

  for await (const ev of sseEvents(res)) {
    if (ev.data === '[DONE]') return;
    let j;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const choice = j.choices?.[0];
    if (choice?.delta?.content) yield choice.delta.content;
    if (choice?.finish_reason === 'length')
      yield '\n\n> ⚠️ Отчёт обрезан по лимиту токенов. Увеличьте MAX_OUTPUT_TOKENS в .env.';
  }
}

async function* gemini({ system, user, signal, model: modelOverride }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new UserError('Не задан GEMINI_API_KEY в файле .env (LLM_PROVIDER=gemini).', 500);
  const model = modelOverride || process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

  let res;
  try {
    res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) || 16000 },
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw transientError(`Не удалось связаться с Gemini: ${e.message}`);
  }
  if (!res.ok) await failFromResponse(res, 'Gemini API');

  try {
    for await (const ev of sseEvents(res)) {
      let j;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (j.error) {
        const msg = `Gemini: ${j.error.message || 'ошибка потока'}`;
        throw TRANSIENT_RE.test(msg) || [429, 500, 503].includes(j.error.code)
          ? transientError(msg)
          : new UserError(msg, 502);
      }
      if (j.promptFeedback?.blockReason)
        throw new UserError(`Gemini заблокировал запрос: ${j.promptFeedback.blockReason}`, 502);
      const cand = j.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (part.text && !part.thought) yield part.text;
      }
      if (cand?.finishReason === 'MAX_TOKENS')
        yield '\n\n> ⚠️ Отчёт обрезан по лимиту токенов. Увеличьте MAX_OUTPUT_TOKENS в .env.';
    }
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof UserError) throw e;
    throw transientError(`Соединение с Gemini оборвалось: ${e.message}`);
  }
}

const PROVIDERS = { anthropic, openai, gemini };
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o', gemini: 'gemini-3.5-flash' };
const MODEL_ENV = { anthropic: 'ANTHROPIC_MODEL', openai: 'OPENAI_MODEL', gemini: 'GEMINI_MODEL' };
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

export function currentProvider() {
  return (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
}

export function providerInfo() {
  const name = currentProvider();
  if (!PROVIDERS[name])
    throw new UserError(`Неизвестный LLM_PROVIDER "${name}". Допустимо: ${Object.keys(PROVIDERS).join(', ')}.`, 500);
  return { name, model: process.env[MODEL_ENV[name]] || DEFAULT_MODELS[name], hasKey: !!process.env[KEY_ENV[name]] };
}

// Модель отвечает не всегда (перегрузка, обрыв сети), поэтому временные ошибки повторяем:
// 2 повтора с паузой, последняя попытка — на запасной модели (GEMINI_FALLBACK_MODEL).
// Если ошибка случилась уже посреди отчёта, отдаём { reset: true }: клиент очищает черновик и ждёт заново.
export async function* streamAnalysis(args) {
  providerInfo(); // бросит понятную ошибку при неизвестном провайдере
  const run = PROVIDERS[currentProvider()];
  const fallback = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite';
  const MAX_ATTEMPTS = 3;
  let started = false;

  for (let attempt = 1; ; attempt++) {
    const useFallback = attempt === MAX_ATTEMPTS && currentProvider() === 'gemini';
    try {
      for await (const delta of run({ ...args, ...(useFallback && { model: fallback }) })) {
        started = true;
        yield delta;
      }
      return;
    } catch (e) {
      if (!e.transient || attempt >= MAX_ATTEMPTS || args.signal?.aborted) throw e;
      console.warn(`Попытка ${attempt} не удалась (${e.message}) — повторяю`);
      if (started) {
        yield { reset: true };
        started = false;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
