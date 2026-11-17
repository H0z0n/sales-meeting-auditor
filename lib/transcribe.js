// Расшифровка аудио через OpenAI Whisper API.
// Возвращает текст с таймкодами вида "[мм:сс] фраза" — промпт аудитора просит ссылаться на время фрагментов.

const MAX_BYTES = 25 * 1024 * 1024; // лимит OpenAI на размер файла

const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
};

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function extForMime(mime = '') {
  const base = mime.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] || 'webm';
}

export async function transcribe(buffer, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new UserError('Не задан OPENAI_API_KEY в файле .env — он нужен для расшифровки аудио (Whisper).', 500);
  if (!buffer.length) throw new UserError('Запись пустая — ничего не записано.');
  if (buffer.length > MAX_BYTES) {
    throw new UserError(
      `Файл слишком большой (${(buffer.length / 1048576).toFixed(1)} МБ). Лимит Whisper API — 25 МБ (примерно 100 минут записи).`,
      413,
    );
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), `meeting.${extForMime(mime)}`);
  form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
  form.append('language', 'ru');
  form.append('response_format', 'verbose_json'); // даёт сегменты с таймкодами

  let res;
  try {
    res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com'}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (e) {
    throw new UserError(`Не удалось связаться с OpenAI: ${e.message}`, 502);
  }

  if (!res.ok) {
    const body = await res.text();
    let msg = body;
    try {
      msg = JSON.parse(body).error?.message || body;
    } catch {}
    throw new UserError(`Whisper API вернул ошибку ${res.status}: ${msg}`, 502);
  }

  const data = await res.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const text = segments.length
    ? segments
        .map((s) => `[${formatTime(s.start)}] ${String(s.text).trim()}`)
        .filter((l) => l.length > 8)
        .join('\n')
    : String(data.text || '').trim();

  if (!text) throw new UserError('Речь в записи не распознана. Проверьте микрофон и повторите запись.');
  return { text, duration: data.duration ?? null };
}
