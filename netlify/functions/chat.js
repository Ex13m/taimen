// ТАЙМЕНЬ · прокси-мозг
// POST /api/chat  { messages, system, model?, max_tokens? } -> { text }
// Ключ живёт только в ENV Netlify (ANTHROPIC_API_KEY), наружу не отдаётся.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Иерархия разума: значение — потолок max_tokens для модели.
// Таймень — Fable 5 (мышление всегда включено и ест бюджет ответа — потолок выше),
// свита — Opus 4.8, суб-агенты-исполнители — Sonnet 5, haiku — резерв.
const MODELS = {
  'claude-fable-5': 2000,
  'claude-opus-4-8': 1200,
  'claude-sonnet-5': 1000,
  'claude-haiku-4-5': 800,
};
const DEFAULT_MODEL = 'claude-fable-5';
const FABLE_FALLBACK = 'claude-opus-4-8'; // при отказе классификаторов Fable

const MAX_BODY_BYTES = 32 * 1024; // 32KB
const MAX_MESSAGES = 16;
const MIN_INTERVAL_MS = 2000; // >=2с между запросами с одного IP

// Запасной мозг — когда Anthropic недоступен (нет ключа / 401 / 429 / 5xx).
// Два варианта, хватит одного (пробуются по порядку):
//  · OpenRouter (openrouter.ai) — агрегатор с НАСТОЯЩИМИ бесплатными моделями
//    (пометка :free — $0 за токены), ключ OPENROUTER_API_KEY;
//  · Replicate (replicate.com) — открытые модели за копейки, REPLICATE_API_TOKEN.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free';
// не-:free модель OpenRouter тоже учитываем в бюджете — консервативно ($/млн),
// чтобы платная модель не молотила мимо дневной отсечки
const OPENROUTER_PRICE = (process.env.OPENROUTER_PRICE || '3,15').split(',').map(Number);
const REPLICATE_URL = 'https://api.replicate.com/v1/models/';
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'meta/meta-llama-3-70b-instruct';
const REPLICATE_PRICE = (process.env.REPLICATE_PRICE || '0.65,2.75').split(',').map(Number); // $/млн (дефолт llama-3-70b)

// Цены $/млн токенов [ввод, вывод] — для бюджет-контроля
const PRICES = {
  'claude-fable-5': [10, 50], 'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15], 'claude-haiku-4-5': [1, 5],
};

// Ограничитель в памяти инстанса функции. Не переживает холодный старт —
// «мягкий» лимит, достаточный для v1 (жёсткий вариант — TODO.md).
const lastHit = new Map(); // ip -> ts
let daily = { day: '', count: 0, cost: 0 };

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

// Запасной мозг №1: OpenRouter — обычный chat-формат, бесплатные :free модели.
async function askOpenRouter(messages, system, maxTokens) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (((await res.json()).error || {}).message || ''); } catch { /* ignore */ }
    console.error('openrouter error', res.status, detail);
    return { error:
      res.status === 401 || res.status === 402 ? 'Запасной мозг: ключ OpenRouter не подошёл или кончился баланс.'
      : res.status === 429 ? 'Запасной мозг: дневной лимит бесплатной модели. Попробуй позже.'
      : 'Запасной мозг сейчас недоступен. Попробуй ещё раз.' };
  }
  const data = await res.json();
  const text = ((((data.choices || [])[0] || {}).message || {}).content || '').trim();
  if (!text) return { error: 'Запасной мозг промолчал. Попробуй ещё раз.' };
  const u = data.usage || {};
  const usage = { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 };
  const free = OPENROUTER_MODEL.endsWith(':free');
  return { text, usage, model: 'openrouter/' + (data.model || OPENROUTER_MODEL),
    cost: free ? 0 : (usage.in * OPENROUTER_PRICE[0] + usage.out * OPENROUTER_PRICE[1]) / 1e6 };
}

// Запасной мозг №2: Replicate. История склеивается в диалог,
// т.к. открытые модели принимают один prompt. Ждём не дольше 8с (лимит функции 10с).
async function askReplicate(messages, system, maxTokens) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;
  const dialogue = messages
    .map((m) => (m.role === 'user' ? 'Хозяин: ' : 'Таймень: ') + m.content)
    .join('\n') + '\nТаймень:';
  const res = await fetch(REPLICATE_URL + REPLICATE_MODEL + '/predictions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      prefer: 'wait=8',
    },
    body: JSON.stringify({
      input: {
        prompt: dialogue,
        system_prompt: (system || 'Ты — Таймень, дух глубин. Отвечай по-русски, коротко.') +
          '\nОтвечай ТОЛЬКО за Тайменя, одной репликой, без префикса «Таймень:».',
        max_tokens: maxTokens,
        max_new_tokens: maxTokens,
        temperature: 0.7,
      },
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()).detail || ''); } catch { /* ignore */ }
    console.error('replicate error', res.status, detail);
    return { error: res.status === 401 || res.status === 402
      ? 'Запасной мозг: ключ Replicate не подошёл или кончился баланс.'
      : 'Запасной мозг сейчас недоступен. Попробуй ещё раз.' };
  }
  const pred = await res.json();
  if (pred.status === 'failed' || pred.status === 'canceled') {
    console.error('replicate prediction failed', pred.error || pred.status);
    return { error: 'Запасной мозг споткнулся. Попробуй ещё раз.' };
  }
  if (pred.status !== 'succeeded' && !(Array.isArray(pred.output) && pred.output.length)) {
    return { error: 'Запасной мозг прогревается (холодный старт) — повтори через полминуты.' };
  }
  const text = (Array.isArray(pred.output) ? pred.output.join('') : String(pred.output || '')).trim();
  const m = pred.metrics || {};
  const usage = { in: m.input_token_count || 0, out: m.output_token_count || 0 };
  return { text, usage, model: 'replicate/' + REPLICATE_MODEL,
    cost: (usage.in * REPLICATE_PRICE[0] + usage.out * REPLICATE_PRICE[1]) / 1e6 };
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
  const cap = MODELS[model];
  const maxTokens = Math.min(
    Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : cap,
    cap
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
  if (daily.day !== today) daily = { day: today, count: 0, cost: 0 };
  const limit = parseInt(process.env.DAILY_LIMIT, 10) || 200;
  if (daily.count >= limit) {
    return json(429, { error: 'Таймень отдыхает до завтра — дневной лимит разговоров исчерпан.' });
  }
  // Бюджет в деньгах: DAILY_COST_LIMIT (дефолт $5) + допуск перерасхода 10%.
  const costLimit = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
  if (daily.cost >= costLimit * 1.1) {
    return json(429, { error: 'Дневной бюджет Тайменя исчерпан (' + costLimit + '$ +10%). До завтра.' });
  }
  daily.count += 1;

  // Ответ запасного мозга -> тот же формат, что и основной (с учётом бюджета).
  // Порядок: OpenRouter (бесплатно), потом Replicate (копейки).
  const viaBackup = async () => {
    let r = null;
    try { r = await askOpenRouter(messages, system, Math.min(maxTokens, 1000)); }
    catch (e) { console.error('openrouter failure', e && e.message); r = { error: 'Запасной мозг не отозвался. Попробуй ещё раз.' }; }
    if (!r || r.error) {
      let r2 = null;
      try { r2 = await askReplicate(messages, system, Math.min(maxTokens, 1000)); }
      catch (e) { console.error('replicate failure', e && e.message); r2 = { error: 'Запасной мозг не отозвался. Попробуй ещё раз.' }; }
      if (r2) r = r2;
    }
    if (!r) return null;
    if (r.error) return json(502, { error: r.error });
    daily.cost += r.cost || 0;
    const lim = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
    return json(200, { text: r.text, usage: r.usage, model: r.model,
      budget: { spent: Math.round(daily.cost * 100) / 100, limit: lim } });
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const backup = await viaBackup();
    if (backup) return backup;
    return json(503, { error: 'Мозг не подключён: нет ANTHROPIC_API_KEY (или запасного OPENROUTER_API_KEY / REPLICATE_API_TOKEN) в ENV.' });
  }

  try {
    const isFable = model === 'claude-fable-5';
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        // серверный фолбэк: если классификаторы Fable отказали — тот же запрос
        // дослуживает Opus 4.8 внутри того же вызова
        ...(isFable ? { 'anthropic-beta': 'server-side-fallback-2026-06-01' } : {}),
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages,
        ...(isFable ? { fallbacks: [{ model: FABLE_FALLBACK }] } : {}),
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()).error || {}).message || '';
      } catch { /* ignore */ }
      console.error('anthropic error', res.status, detail);
      // основной мозг недоступен (не наша ошибка запроса) — пробуем запасной
      if (res.status === 401 || res.status === 429 || res.status >= 500) {
        const backup = await viaBackup();
        if (backup) return backup;
      }
      const friendly =
        res.status === 429 ? 'Слишком много мыслей сразу. Попробуй через минуту.'
        : res.status === 401 ? 'Ключ не подошёл. Проверь ANTHROPIC_API_KEY.'
        : res.status >= 500 ? 'Глубины сейчас неспокойны. Попробуй ещё раз.'
        : 'Не получилось подумать. Попробуй переформулировать.';
      return json(res.status === 429 ? 429 : 502, { error: friendly });
    }

    const data = await res.json();
    const usage = data.usage
      ? { in: data.usage.input_tokens || 0, out: data.usage.output_tokens || 0 }
      : null;
    if (usage) {
      const p = PRICES[data.model] || PRICES[model] || [5, 25];
      daily.cost += (usage.in * p[0] + usage.out * p[1]) / 1e6;
    }
    const costLimit2 = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
    const budget = { spent: Math.round(daily.cost * 100) / 100, limit: costLimit2 };
    if (data.stop_reason === 'refusal') {
      return json(200, { text: 'Об этом я говорить не стану — спроси иначе.', usage, model: data.model || model, budget });
    }
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return json(200, { text, usage, model: data.model || model, budget });
  } catch (e) {
    console.error('proxy failure', e && e.message);
    const backup = await viaBackup();
    if (backup) return backup;
    return json(502, { error: 'Связь с глубинами прервалась. Попробуй ещё раз.' });
  }
};
