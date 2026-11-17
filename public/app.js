// Клиент: запись (MediaRecorder) → /api/transcribe → /api/analyze (SSE) → отчёт.

const $ = (id) => document.getElementById(id);
const recBtn = $('recBtn');
const timerEl = $('timer');
const meterBar = $('meterBar');
const statusEl = $('status');
const errorEl = $('error');
const reportEl = $('report');

const state = {
  recorder: null,
  stream: null,
  chunks: [],
  audioCtx: null,
  timerId: null,
  startedAt: 0,
  busy: false,
  sessionId: null,
  transcript: '',
  report: '',
  abort: null,
};

// ---------- мелкие помощники ----------

function setStep(name) {
  const order = ['record', 'transcribe', 'analyze'];
  const idx = order.indexOf(name);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', idx === -1 ? name === 'done' : i < idx);
  });
}

function setStatus(text) {
  statusEl.textContent = text || '';
}

function showError(text) {
  errorEl.textContent = text || '';
  errorEl.hidden = !text;
}

function setBusy(busy) {
  state.busy = busy;
  recBtn.disabled = busy;
  $('fileInput').disabled = busy;
  $('manualBtn').disabled = busy;
  $('reBtn').disabled = busy;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function meta() {
  return {
    manager: $('f-manager').value,
    date: $('f-date').value,
    meetingId: $('f-meetingId').value,
    crm: $('f-crm').value,
    rules: $('f-rules').value,
  };
}

// ---------- рендер отчёта ----------

let renderQueued = false;
function renderReport(final = false) {
  const draw = () => {
    renderQueued = false;
    if (window.marked && window.DOMPurify) {
      reportEl.classList.remove('plain');
      reportEl.innerHTML = DOMPurify.sanitize(marked.parse(state.report, { gfm: true, breaks: false }));
    } else {
      // CDN недоступен — показываем сырой markdown, отчёт всё равно читаем
      reportEl.classList.add('plain');
      reportEl.textContent = state.report;
    }
    reportEl.classList.toggle('streaming', !final);
  };
  if (final) return draw();
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(draw);
  }
}

// ---------- запись ----------

function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecording() {
  showError('');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return showError('Этот браузер не поддерживает запись. Откройте страницу в Chrome, Edge или Safari по адресу localhost.');
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (e) {
    return showError(
      e.name === 'NotAllowedError'
        ? 'Доступ к микрофону запрещён. Разрешите его в настройках браузера и повторите.'
        : `Не удалось включить микрофон: ${e.message}`,
    );
  }

  const mimeType = pickMime();
  state.chunks = [];
  // 32 кбит/с хватает для речи и позволяет уложиться в лимит Whisper (25 МБ ≈ 100 минут)
  state.recorder = new MediaRecorder(state.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 });
  state.recorder.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
  state.recorder.onstop = onRecordingStopped;
  state.recorder.start(1000);

  // индикатор уровня звука
  try {
    state.audioCtx = new AudioContext();
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    state.audioCtx.createMediaStreamSource(state.stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!state.audioCtx) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      meterBar.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  } catch {}

  state.startedAt = Date.now();
  timerEl.textContent = '00:00';
  state.timerId = setInterval(() => (timerEl.textContent = fmt(Date.now() - state.startedAt)), 250);

  recBtn.textContent = 'Остановить и проанализировать';
  recBtn.classList.add('recording');
  setStep('record');
  setStatus('Идёт запись разговора…');
}

function stopRecording() {
  if (state.recorder?.state === 'recording') state.recorder.stop();
}

function cleanupRecording() {
  clearInterval(state.timerId);
  state.stream?.getTracks().forEach((t) => t.stop());
  state.audioCtx?.close().catch(() => {});
  state.audioCtx = null;
  meterBar.style.width = '0';
  recBtn.textContent = 'Начать запись';
  recBtn.classList.remove('recording');
}

async function onRecordingStopped() {
  cleanupRecording();
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
  if (Date.now() - state.startedAt < 1500 || blob.size < 1000) {
    setStep(null);
    setStatus('');
    return showError('Запись слишком короткая — ничего не записано.');
  }
  await processAudio(blob);
}

recBtn.addEventListener('click', () => {
  if (state.recorder?.state === 'recording') stopRecording();
  else startRecording();
});

// ---------- расшифровка и анализ ----------

async function processAudio(blob) {
  setBusy(true);
  showError('');
  setStep('transcribe');
  setStatus(`Расшифровываю аудио (${(blob.size / 1048576).toFixed(1)} МБ)… обычно до минуты.`);
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка сервера ${res.status}`);
    state.sessionId = data.sessionId;
    state.transcript = data.transcript;
    showTranscript();
    await runAnalysis();
  } catch (e) {
    setStep(null);
    setStatus('');
    showError(e.message);
  } finally {
    setBusy(false);
  }
}

function showTranscript() {
  $('transcript').textContent = state.transcript;
  $('transcriptCard').hidden = false;
}

async function runAnalysis() {
  setBusy(true);
  showError('');
  setStep('analyze');
  setStatus('ИИ анализирует разговор… отчёт большой, появляется постепенно.');
  state.report = '';
  $('reportCard').hidden = false;
  renderReport();
  $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

  state.abort = new AbortController();
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({ transcript: state.transcript, sessionId: state.sessionId, meta: meta() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Ошибка сервера ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/^data:\s*/, '');
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.reset) {
          state.report = '';
          setStatus('Модель перегружена, повторяю запрос…');
          renderReport();
        }
        if (msg.delta) {
          state.report += msg.delta;
          renderReport();
        }
        if (msg.done) {
          finished = true;
          state.sessionId = msg.sessionId || state.sessionId;
        }
      }
    }
    if (!finished) throw new Error('Соединение прервалось до конца отчёта.');
    renderReport(true);
    setStep('done');
    setStatus(`Готово. Запись, расшифровка и отчёт сохранены в data/${state.sessionId}/`);
  } catch (e) {
    renderReport(true);
    setStep(null);
    setStatus('');
    showError(e.message);
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

// ---------- кнопки отчёта ----------

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.report);
    $('copyBtn').textContent = 'Скопировано ✓';
  } catch {
    $('copyBtn').textContent = 'Не удалось';
  }
  setTimeout(() => ($('copyBtn').textContent = 'Скопировать'), 1500);
});

$('downloadBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([state.report], { type: 'text/markdown;charset=utf-8' }));
  a.download = `otchet-${state.sessionId || 'vstrecha'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('reBtn').addEventListener('click', () => state.transcript && runAnalysis());

// ---------- альтернативный ввод ----------

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) processAudio(file);
});

$('manualBtn').addEventListener('click', () => {
  const text = $('manualText').value.trim();
  if (!text) return showError('Вставьте текст разговора.');
  state.transcript = text;
  state.sessionId = null;
  showTranscript();
  runAnalysis();
});

// ---------- старт ----------

$('f-date').value = new Date().toISOString().slice(0, 10);

fetch('/api/config')
  .then((r) => r.json())
  .then((c) => {
    const el = $('cfg');
    const bad = [];
    if (!c.whisperReady) bad.push('нет OPENAI_API_KEY (расшифровка)');
    if (!c.llmReady) bad.push(`нет ключа для ${c.provider}`);
    el.textContent = `Анализ: ${c.provider} · ${c.model}`;
    if (bad.length) {
      const span = document.createElement('span');
      span.className = 'bad';
      span.textContent = ` — внимание: ${bad.join(', ')}. См. .env`;
      el.append(span);
    }
  })
  .catch(() => {});

window.addEventListener('beforeunload', (e) => {
  if (state.recorder?.state === 'recording') e.preventDefault();
});
