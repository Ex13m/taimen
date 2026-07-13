// ТАЙМЕНЬ · прокси-мозг
// POST /api/chat  { messages, system, model?, max_tokens? } -> { text }
// Ключ живёт только в ENV Netlify (ANTHROPIC_API_KEY), наружу не отдаётся.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Разрешённые модели: мозг (sonnet) и дешёвые суб-вызовы (haiku).
const MODELS = {
  'claude-sonnet-4-6': true,
  'claude-haiku-4-5': true,
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MAX_BODY_BYTES = 32 * 1024; // 32KB
const MAX_MESSAGES = 16;
const MAX_TOKENS_CAP = 1000;
const MIN_INTERVAL_MS = 2000; // >=2с между запросами с одного IP

// Ограничитель в памяти инстанса функции. Не переживает холодный старт —
// «мягкий» лимит, достаточный для v1 (жёсткий вариант — TODO.md).
const lastHit = new Map(); // ip -> ts
let daily = { day: '', count: 0 };

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function clientIp(event) {
  return (
    event.headers['x-nf-client-connection-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Только POST.' });
  }

  // Опциональный замок: если в ENV задан ACCESS_KEY, чужие без пароля не тратят токены.
  const requiredKey = process.env.ACCESS_KEY;
  if (requiredKey && event.headers['x-taimen-key'] !== requiredKey) {
    return json(401, { error: 'Таймень закрыт паролем.', locked: true });
  }

  const raw = event.body || '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json(400, { error: 'Слишком большой запрос (лимит 32KB).' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Битый JSON.' });
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json(400, { error: 'Нужен непустой массив messages.' });
  }

  // Обрезаем историю до последних MAX_MESSAGES и валидируем каждое сообщение.
  const messages = body.messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m && m.role,
    content: m && m.content,
  }));
  for (const m of messages) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) {
      return json(400, { error: 'Каждое сообщение: {role: user|assistant, content: строка}.' });
    }
  }

  const system = typeof body.system === 'string' ? body.system : undefined;
  const model = Object.prototype.hasOwnProperty.call(MODELS, body.model) ? body.model : DEFAULT_MODEL;
  const maxTokens = Math.min(
    Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : MAX_TOKENS_CAP,
    MAX_TOKENS_CAP
  );

  // --- Ограничитель трат ---
  const ip = clientIp(event);
  const now = Date.now();
  const prev = lastHit.get(ip) || 0;
  if (now - prev < MIN_INTERVAL_MS) {
    return json(429, { error: 'Таймень ещё думает. Подожди пару секунд.' });
  }
  lastHit.set(ip, now);
  if (lastHit.size > 500) for (const [k, t] of lastHit) if (now - t > MIN_INTERVAL_MS) lastHit.delete(k); // не копим мусор

  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  const limit = parseInt(process.env.DAILY_LIMIT, 10) || 200;
  if (daily.count >= limit) {
    return json(429, { error: 'Таймень отдыхает до завтра — дневной лимит разговоров исчерпан.' });
  }
  daily.count += 1;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(503, { error: 'Мозг не подключён: нет ANTHROPIC_API_KEY в ENV.' });
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()).error || {}).message || '';
      } catch { /* ignore */ }
      console.error('anthropic error', res.status, detail);
      const friendly =
        res.status === 429 ? 'Слишком много мыслей сразу. Попробуй через минуту.'
        : res.status === 401 ? 'Ключ не подошёл. Проверь ANTHROPIC_API_KEY.'
        : res.status >= 500 ? 'Глубины сейчас неспокойны. Попробуй ещё раз.'
        : 'Не получилось подумать. Попробуй переформулировать.';
      return json(res.status === 429 ? 429 : 502, { error: friendly });
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return json(200, { text });
  } catch (e) {
    console.error('proxy failure', e && e.message);
    return json(502, { error: 'Связь с глубинами прервалась. Попробуй ещё раз.' });
  }
};
