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
// Пайплайн: цепочка моделей — OpenRouter сам перебирает по списку, если одна
// недоступна/лимитирована (нативный фолбэк через поле models[]). Первым — выбор
// хозяина (OPENROUTER_MODEL), дальше — крепкие бесплатные, хорошо знающие русский.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free';
const OPENROUTER_CHAIN = (process.env.OPENROUTER_MODELS ||
  'deepseek/deepseek-chat-v3-0324:free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen-2.5-72b-instruct:free,google/gemini-2.0-flash-exp:free,mistralai/mistral-small-3.1-24b-instruct:free'
).split(',').map((s) => s.trim()).filter(Boolean);
// не-:free модель OpenRouter тоже учитываем в бюджете — консервативно ($/млн),
// чтобы платная модель не молотила мимо дневной отсечки
const OPENROUTER_PRICE = (process.env.OPENROUTER_PRICE || '3,15').split(',').map(Number);
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://taimen-orb.netlify.app';
const REPLICATE_URL = 'https://api.replicate.com/v1/models/';
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'meta/meta-llama-3-70b-instruct';
const REPLICATE_PRICE = (process.env.REPLICATE_PRICE || '0.65,2.75').split(',').map(Number); // $/млн (дефолт llama-3-70b)

// Цены $/млн токенов [ввод, вывод] — для бюджет-контроля
const PRICES = {
  'claude-fable-5': [10, 50], 'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15], 'claude-haiku-4-5': [1, 5],
};

// ---- Руки Тайменя: инструменты, которыми мозг действует сам ----
// У функций Netlify открытый интернет — Таймень ходит в сеть и спрашивает
// планеты без участия хозяина. Цикл ограничен и посчитан в бюджет.
const TOOL_ROUNDS_MAX = 2;   // раунды инструментов (держим таймаут функции ~10с)
const TOOLS = [
  {
    name: 'fetch_url',
    description: 'Прочитать страницу по HTTPS-URL и получить её текст (до 20КБ). Используй, когда нужны свежие сведения из сети: новости, документация, статьи.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'https://…' } }, required: ['url'] },
  },
  {
    name: 'ask_planet',
    description: 'Задать вопрос планете-агенту галактики и получить её ответ. id: strateg (замысел/план), taktik (ходы/сроки), analitik (числа/разбор), pisar (тексты), hranitel (память), progressor (развитие/этика), bank (финансы), shpion (разведка), immortal (долголетие).',
    input_schema: { type: 'object', properties: {
      id: { type: 'string' }, question: { type: 'string' } }, required: ['id', 'question'] },
  },
];
// короткие серверные характеры планет для ask_planet (исполнители — Sonnet 5)
const PLANET_SYS = {
  strateg: 'Ты — Стратегорум, планета замысла. Дай план: шаги, развилки, риски. Кратко, по-русски.',
  taktik: 'Ты — Тактикорум, планета манёвра. Преврати замысел в ходы: ход → срок → критерий готовности. Кратко, по-русски.',
  analitik: 'Ты — Аналитикум, планета данных. Разбери по числам и логике, покажи вывод. Кратко, по-русски.',
  pisar: 'Ты — Скрипторум, планета текстов. Дай готовый живой текст. По-русски.',
  hranitel: 'Ты — Кустодес, планета памяти. Скажи, что стоит запомнить и как это связано с прошлым. Кратко, по-русски.',
  progressor: 'Ты — Прогрессорум, планета мягкого развития (Третий Путь Стругацких). Предложи следующий разумный шаг, взвесь цену вмешательства. По-русски.',
  bank: 'Ты — Фискаторум, планета-казна. Посчитай деньги/ресурсы, предупреди о перерасходе. Кратко, цифрами, по-русски.',
  shpion: 'Ты — Спекулятор, планета разведки. Скажи, где искать сведения и что проверить, с оговоркой о надёжности. Кратко, по-русски.',
  immortal: 'Ты — Иммортис, планета отсчёта до бессмертия. Оцени с позиции продления жизни, честно про неопределённость. Кратко, по-русски.',
};

// приватный ли IPv4 (в т.ч. извлечённый из IPv4-mapped IPv6)
function isPrivateV4(a, b){
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // метаданные/link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
// приватные/локальные/метадата-адреса — руки туда не ходят (защита от SSRF)
function isBlockedHost(host){
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal') return true;
  // IPv6 (есть двоеточие): loopback, ULA, link-local + IPv4-mapped (::ffff:a.b.c.d)
  if (h.includes(':')){
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    if (h === '::' ) return true;
    const md = h.match(/::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    if (md && isPrivateV4(+md[1], +md[2])) return true;
    const mh = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})/); // ::ffff:7f00:1
    if (mh){ const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16);
      if (isPrivateV4((hi >> 8) & 255, hi & 255)) return true; }
    return false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m && isPrivateV4(+m[1], +m[2])) return true;
  if (h === '169.254.169.254') return true;
  return false;
}

async function toolFetchUrl(rawUrl){
  let u;
  try { u = new URL(String(rawUrl)); } catch { return 'ошибка: некорректный URL'; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    // редиректы следуем ВРУЧНУЮ, перепроверяя каждый хоп (иначе 302 → внутренний адрес)
    let res, hops = 0;
    let target = u;
    while (true){
      if (target.protocol !== 'https:') return 'ошибка: только https';
      if (isBlockedHost(target.hostname)) return 'ошибка: этот адрес закрыт (локальный/приватный/метаданные)';
      res = await fetch(target.href, { signal: ctl.signal, redirect: 'manual',
        headers: { 'user-agent': 'TaimenGalaxy/1.0 (+taimen)' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < 4){
        hops += 1;
        try { target = new URL(res.headers.get('location'), target); } catch { return 'ошибка: битый редирект'; }
        continue;
      }
      break;
    }
    u = target;
    const raw = (await res.text()).slice(0, 300000);
    // грубое извлечение текста: режем скрипты/стили/теги, схлопываем пробелы
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000);
    return 'HTTP ' + res.status + ' · ' + u.hostname + '\n' + (text || '(пусто)');
  } catch (e) {
    return 'ошибка сети: ' + ((e && e.name === 'AbortError') ? 'таймаут' : (e && e.message) || '?');
  } finally { clearTimeout(timer); }
}

async function toolAskPlanet(apiKey, id, question, addCost, timeoutMs){
  const sys = PLANET_SYS[id];
  if (!sys) return 'ошибка: нет такой планеты (' + id + ')';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1200, timeoutMs || 4000));
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 500, system: sys,
        messages: [{ role: 'user', content: String(question).slice(0, 3000) }] }),
    });
    const data = await res.json();
    if (!res.ok) return 'планета молчит (' + res.status + ')';
    if (data.usage) addCost('claude-sonnet-5', data.usage);
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(тишина)';
  } catch (e) { return (e && e.name === 'AbortError') ? 'планета не успела ответить' : 'планета недоступна'; }
  finally { clearTimeout(timer); }
}

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

// Запасной мозг №1: OpenRouter — chat-формат, цепочка бесплатных моделей с
// нативным авто-фолбэком (models[]) + атрибуция (лучший бесплатный лимит).
async function askOpenRouter(messages, system, maxTokens) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  // первым — выбранная модель, затем цепочка (без дублей); OpenRouter принимает
  // не более 3 моделей в массиве — берём топ-3
  const models = [OPENROUTER_MODEL, ...OPENROUTER_CHAIN].filter((m, i, a) => a.indexOf(m) === i).slice(0, 3);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + key,
        'HTTP-Referer': SITE_URL,   // атрибуция OpenRouter — щедрее бесплатный лимит
        'X-Title': 'TAIMEN',
      },
      body: JSON.stringify({
        models,                      // цепочка: OpenRouter сам перебирает при отказе
        max_tokens: maxTokens,
        // allow_fallbacks — да; data_collection НЕ ограничиваем: почти все :free
        // модели требуют разрешённого сбора данных, иначе отсеиваются все.
        provider: { allow_fallbacks: true },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages,
        ],
      }),
    });
  } catch (e) { clearTimeout(timer); return { error: (e && e.name === 'AbortError') ? 'Запасной мозг долго думал.' : 'Запасной мозг недоступен.' }; }
  clearTimeout(timer);
  if (!res.ok) {
    let detail = '';
    try { detail = (((await res.json()).error || {}).message || ''); } catch { /* ignore */ }
    console.error('openrouter error', res.status, detail);
    return { error:
      res.status === 401 || res.status === 402 ? 'Запасной мозг: ключ OpenRouter не подошёл или кончился баланс.'
      : res.status === 429 ? 'Запасной мозг: все бесплатные модели заняты. Попробуй позже.'
      : 'Запасной мозг: OpenRouter вернул ' + res.status + (detail ? ' · ' + String(detail).slice(0, 160) : '') };
  }
  const data = await res.json();
  const usedModel = data.model || OPENROUTER_MODEL; // OpenRouter вернёт, кто реально ответил
  const text = ((((data.choices || [])[0] || {}).message || {}).content || '').trim();
  if (!text) return { error: 'Запасной мозг промолчал. Попробуй ещё раз.' };
  const u = data.usage || {};
  const usage = { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 };
  const free = String(usedModel).endsWith(':free');
  return { text, usage, model: 'openrouter/' + usedModel,
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

exports.isBlockedHost = isBlockedHost; // для теста SSRF в CI

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
  // silentOnError: если запаска тоже не смогла — вернуть null, чтобы вызвавший
  // показал мягкое «повтори» (когда основной мозг просто моргнул), а не пугал
  // ошибкой OpenRouter. Без флага — отдаём ошибку запаски (когда она единственная).
  const viaBackup = async (silentOnError) => {
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
    if (r.error) return silentOnError ? null : json(502, { error: r.error });
    daily.cost += r.cost || 0;
    const lim = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
    return json(200, { text: r.text, usage: r.usage, model: r.model,
      budget: { spent: Math.round(daily.cost * 100) / 100, limit: lim } });
  };

  // health-check запасного мозга: гоняет ТОЛЬКО запаску (OpenRouter/Replicate),
  // минуя Anthropic — чтобы проверить, что OpenRouter реально отвечает.
  if (body.diag === 'backup') {
    const b = await viaBackup();
    if (b) return b;
    return json(503, { error: 'Запасной мозг не настроен: нет OPENROUTER_API_KEY / REPLICATE_API_TOKEN.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const backup = await viaBackup();
    if (backup) return backup;
    return json(503, { error: 'Мозг не подключён: нет ANTHROPIC_API_KEY (или запасного OPENROUTER_API_KEY / REPLICATE_API_TOKEN) в ENV.' });
  }

  try {
    const isFable = model === 'claude-fable-5';
    // руки даём только главному разуму (не свите): body.tools !== false
    const handsOn = body.tools !== false && !body.entity;
    const addCost = (m, u) => {
      const p = PRICES[m] || [5, 25];
      daily.cost += (((u.input_tokens || u.in || 0) * p[0]) + ((u.output_tokens || u.out || 0) * p[1])) / 1e6;
    };
    const trace = []; // след действий: фронт покажет ракеты и пометки
    const convo = messages.map((m) => ({ role: m.role, content: m.content }));
    let usage = { in: 0, out: 0 };
    let data = null;
    // жёсткий бюджет времени: функция Netlify живёт ~10с, за таймаутом — 504.
    // HARD_WALL — потолок всей возни с Anthropic; каждый вызов обрывается по
    // остатку, инструменты раздаём только пока есть резерв на финальный ответ.
    const t0 = Date.now();
    const HARD_WALL = 9000;
    const WRAP_RESERVE = 3500; // резерв времени под завершающий текстовый ответ
    const remain = () => HARD_WALL - (Date.now() - t0);

    let didTools = false;
    let retriedOverload = false;
    for (let round = 0; round <= TOOL_ROUNDS_MAX; round++) {
      if (remain() < 800) break; // нет времени на ещё вызов — отдаём, что есть
      // инструменты — только не на последнем раунде и пока хватит времени на финал
      const offerTools = handsOn && round < TOOL_ROUNDS_MAX && remain() > (WRAP_RESERVE + 1500);
      // после «рук» финальную сборку делаем быстрым Sonnet (Fable с размышлением
      // не успеет в остаток) — чтобы приходил настоящий ответ, а не извинение
      const roundModel = (didTools && !offerTools) ? 'claude-sonnet-5' : model;
      const roundFable = roundModel === 'claude-fable-5';
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), Math.max(1500, remain()));
      let res;
      try {
        res = await fetch(ANTHROPIC_URL, {
          method: 'POST', signal: ac.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
            // серверный фолбэк: если классификаторы Fable отказали — тот же запрос
            // дослуживает Opus 4.8 внутри того же вызова
            ...(roundFable ? { 'anthropic-beta': 'server-side-fallback-2026-06-01' } : {}),
          },
          body: JSON.stringify({
            model: roundModel, max_tokens: maxTokens, system, messages: convo,
            ...(offerTools ? { tools: TOOLS } : {}),
            ...(roundFable ? { fallbacks: [{ model: FABLE_FALLBACK }] } : {}),
          }),
        });
      } catch (e) {
        clearTimeout(tm);
        console.error('anthropic call aborted/failed', e && e.name);
        if (data) break; // уже был ответ раньше — отдадим его
        const backup = await viaBackup();
        if (backup) return backup;
        return json(200, { text: 'Задумался слишком глубоко — задай короче или по частям.', usage, model, budget: { spent: Math.round(daily.cost * 100) / 100, limit: parseFloat(process.env.DAILY_COST_LIMIT) || 5 }, trace });
      }
      clearTimeout(tm);

      if (!res.ok) {
        let detail = '';
        try { detail = ((await res.json()).error || {}).message || ''; } catch { /* ignore */ }
        console.error('anthropic error', res.status, detail);
        // перегруз (529/500/503) часто мигает — один тихий повтор, если есть время
        if ((res.status === 529 || res.status === 500 || res.status === 503) && !retriedOverload && remain() > 3000) {
          retriedOverload = true;
          round -= 1; // тот же раунд ещё раз
          continue;
        }
        // основной мозг недоступен (не наша ошибка запроса) — пробуем запасной
        // тихо: если запаска тоже не смогла, покажем мягкое «повтори», не пугая
        if (res.status === 401 || res.status === 429 || res.status >= 500) {
          const backup = await viaBackup(true);
          if (backup) return backup;
        }
        const friendly =
          res.status === 429 ? 'Слишком много мыслей сразу — повтори через минуту.'
          : res.status === 401 ? 'Ключ не подошёл. Проверь ANTHROPIC_API_KEY.'
          : res.status >= 500 ? 'Глубины на миг переполнились — повтори через пару секунд.'
          : 'Не получилось подумать. Попробуй переформулировать.';
        return json(res.status === 429 ? 429 : 502, { error: friendly });
      }

      data = await res.json();
      if (data.usage) {
        usage.in += data.usage.input_tokens || 0;
        usage.out += data.usage.output_tokens || 0;
        addCost(data.model || model, data.usage);
      }

      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (data.stop_reason !== 'tool_use' || !toolUses.length || !offerTools) break;
      didTools = true;

      // исполняем инструменты ПАРАЛЛЕЛЬНО (не более 3), возвращаем результаты
      convo.push({ role: 'assistant', content: data.content });
      const results = await Promise.all(toolUses.slice(0, 3).map(async (tu) => {
        let out;
        if (tu.name === 'fetch_url') {
          out = await toolFetchUrl(tu.input && tu.input.url);
          trace.push({ tool: 'fetch_url', url: String((tu.input && tu.input.url) || '').slice(0, 200) });
        } else if (tu.name === 'ask_planet') {
          const pid = String((tu.input && tu.input.id) || '');
          out = await toolAskPlanet(apiKey, pid, (tu.input && tu.input.question) || '', addCost, remain() - 1000);
          trace.push({ tool: 'ask_planet', id: pid, q: String((tu.input && tu.input.question) || '').slice(0, 120) });
        } else {
          out = 'неизвестный инструмент';
        }
        return { type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 16000) };
      }));
      // лишние tool_use (сверх 3) закрываем пустышкой, чтобы протокол не сломался
      toolUses.slice(3).forEach((tu) => results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'пропущено (лимит инструментов)' }));
      convo.push({ role: 'user', content: results });
    }

    const costLimit2 = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
    const budget = { spent: Math.round(daily.cost * 100) / 100, limit: costLimit2 };
    if (data.stop_reason === 'refusal') {
      return json(200, { text: 'Об этом я говорить не стану — спроси иначе.', usage, model: data.model || model, budget, trace });
    }
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    // никогда не отдаём пустоту (напр. оборвались на tool_use по времени)
    const safeText = text || 'Задумался слишком глубоко — задай короче или по частям.';
    return json(200, { text: safeText, usage, model: data.model || model, budget, trace });
  } catch (e) {
    console.error('proxy failure', e && e.message);
    const backup = await viaBackup();
    if (backup) return backup;
    return json(502, { error: 'Связь с глубинами прервалась. Попробуй ещё раз.' });
  }
};
