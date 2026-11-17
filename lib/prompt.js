// Сборка промпта: файл prompts/auditor.md делится на системную часть (до заголовка
// «ВХОДНЫЕ ДАННЫЕ») и блок входных данных, в который подставляются поля встречи и расшифровка.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'auditor.md');
// Заголовок Markdown любого уровня, содержащий «ВХОДНЫЕ ДАННЫЕ» (например, «# ВХОДНЫЕ ДАННЫЕ»).
const SPLIT_RE = /^#+[^\n]*ВХОДНЫЕ ДАННЫЕ/m;

const FIELDS = {
  MANAGER_NAME: 'manager',
  MANAGER_ID: 'managerId',
  MEETING_DATE: 'date',
  MEETING_ID: 'meetingId',
  CRM_DATA: 'crm',
  CLIENT_HISTORY: 'history',
  COMPANY_RULES: 'rules',
  PRODUCT_KNOWLEDGE: 'product',
};

export async function buildPrompt(meta = {}, transcript) {
  // Файл читаем при каждом запросе — промпт можно править без перезапуска сервера.
  const full = await readFile(PROMPT_FILE, 'utf8');
  const idx = full.search(SPLIT_RE);
  if (idx === -1) throw new Error('В prompts/auditor.md не найден заголовок «# ВХОДНЫЕ ДАННЫЕ»');

  // HTML-комментарии — подсказки для того, кто правит промпт; модели они не нужны.
  const system = full.slice(0, idx).replace(/<!--[\s\S]*?-->/g, '').trim();
  let user = full.slice(idx);

  for (const [placeholder, field] of Object.entries(FIELDS)) {
    const value = String(meta[field] ?? '').trim() || 'Не указано';
    user = user.split(`{{${placeholder}}}`).join(value);
  }
  // Расшифровку подставляем последней, чтобы её содержимое не затронули другие замены.
  user = user.split('{{TRANSCRIPT}}').join(transcript);

  return { system, user };
}
