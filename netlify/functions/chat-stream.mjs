// ТАЙМЕНЬ · потоковый мозг (стриминг) для ПРОСТЫХ вопросов.
// Netlify Functions v2 (ESM) умеет отдавать ответ по мере генерации — текст
// появляется сразу, а не после полной готовности. Формат наружу — SSE:
//   data: {"delta":"кусок текста"}\n\n   — по мере генерации
//   data: {"done":true,"model":..,"usage":..,"budget":..}\n\n — в конце
//   data: {"error":"…"}\n\n — при сбое
// Сложные вопросы (нужны «руки»/инструменты), свита, отсутствие ключа, перегруз
// и лимиты → отвечаем {"buffered":true} (обычный JSON), и фронт идёт на /api/chat
// (там полный цикл с руками, лестницей моделей и запаской). Так стрим ничего не
// ломает: худший случай — как раньше. Ключ живёт только в ENV (ANTHROPIC_API_KEY).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODELS = { 'claude-fable-5': 2000, 'claude-opus-4-8': 1200, 'claude-sonnet-5': 1000, 'claude-haiku-4-5': 800 };
const DEFAULT_MODEL = 'claude-fable-5';
const FABLE_FALLBACK = 'claude-opus-4-8';
const PRICES = { 'claude-fable-5': [10, 50], 'claude-opus-4-8': [5, 25], 'claude-sonnet-5': [3, 15], 'claude-haiku-4-5': [1, 5] };
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGES = 16;
const MIN_INTERVAL_MS = 2000;
// признак нужды в «руках» — ДЕРЖАТЬ В СИНХРОНЕ с netlify/functions/chat.js!
const HANDS_HINT = /(найд|погугл|посмотр|проверь|узна|спрос|сколько\s|курс\b|погод|новост|https?:|www\.|сегодня|сейчас|актуальн|котиров|цена|стоит|который час|время в|расписан|прогноз|интернет|в сеть|сети|исследу|разведа|зов|посольств|совет планет|стратегорум|тактикорум|аналитикум|скрипт?ориум|скрипторум|кустодес|спекулятор|прогрессорум|фискаторум|иммортис|стратег|тактик|аналитик|писар|хранител|шпион|иммортал|прогрессор|\bбанк)/i;

// лёгкий лимитер в памяти инстанса (best-effort). Жёсткие каналы — на /api/chat.
const lastHit = new Map();
let daily = { day: '', count: 0, cost: 0 };

const jsonResp = (code, obj) => new Response(JSON.stringify(obj), {
  status: code, headers: { 'content-type': 'application/json; charset=utf-8' },
});
// {buffered:true} — сигнал фронту уйти на обычный /api/chat
const toBuffer = () => jsonResp(200, { buffered: true });

export default async (req) => {
  if (req.method !== 'POST') return jsonResp(405, { error: 'Только POST.' });

  const requiredKey = process.env.ACCESS_KEY;
  if (requiredKey && req.headers.get('x-taimen-key') !== requiredKey)
    return jsonResp(401, { error: 'Таймень закрыт паролем.', locked: true });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResp(400, { error: 'Слишком большой запрос (лимит 32KB).' });
  let body;
  try { body = JSON.parse(raw); } catch { return jsonResp(400, { error: 'Битый JSON.' }); }
  if (!body || !Array.isArray(body.messages) || !body.messages.length)
    return jsonResp(400, { error: 'Нужен непустой массив messages.' });
  if (body.entity) return toBuffer(); // свите не стримим — только главному разуму

  const messages = body.messages.slice(-MAX_MESSAGES).map((m) => ({ role: m && m.role, content: m && m.content }));
  for (const m of messages)
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim())
      return jsonResp(400, { error: 'Каждое сообщение: {role: user|assistant, content: строка}.' });

  // нужны ли «руки»? если да — пусть решает буферный /api/chat (с инструментами)
  const lastU = [...messages].reverse().find((m) => m.role === 'user');
  const lastText = lastU ? lastU.content : '';
  if (lastText.length > 140 || HANDS_HINT.test(lastText)) return toBuffer();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return toBuffer(); // нет ключа — на буфер (там запаска)

  const model = Object.prototype.hasOwnProperty.call(MODELS, body.model) ? body.model : DEFAULT_MODEL;
  const cap = MODELS[model];
  const maxTokens = Math.min(Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : cap, cap);
  const system = typeof body.system === 'string' ? body.system : undefined;
  const isFable = model === 'claude-fable-5';

  // лёгкий лимитер + отсечка по деньгам (на этом инстансе)
  const ip = (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'ip').split(',')[0].trim();
  const now = Date.now();
  if (now - (lastHit.get(ip) || 0) < MIN_INTERVAL_MS) return jsonResp(429, { error: 'Таймень ещё думает. Подожди пару секунд.' });
  lastHit.set(ip, now);
  if (lastHit.size > 500) for (const [k, t] of lastHit) if (now - t > MIN_INTERVAL_MS) lastHit.delete(k);
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0, cost: 0 };
  const limit = parseInt(process.env.DAILY_LIMIT, 10) || 200;
  const costLimit = parseFloat(process.env.DAILY_COST_LIMIT) || 5;
  if (daily.count >= limit || daily.cost >= costLimit * 1.1) return toBuffer(); // лимит — пусть буфер отдаст «отдыхает»
  daily.count += 1;

  // зовём Anthropic в режиме стрима
  let up;
  try {
    up = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        ...(isFable ? { 'anthropic-beta': 'server-side-fallback-2026-06-01' } : {}),
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages, stream: true,
        ...(isFable ? { fallbacks: [{ model: FABLE_FALLBACK }] } : {}),
      }),
    });
  } catch {
    return toBuffer(); // сеть подвела — пусть буфер (с лестницей моделей и запаской)
  }
  if (!up.ok || !up.body) return toBuffer(); // перегруз/ошибка — на буфер с лестницей

  const price = PRICES[model] || [5, 25];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
      const reader = up.body.getReader();
      let buf = '';
      let inTok = 0, outTok = 0, usedModel = model;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let ev;
            try { ev = JSON.parse(payload); } catch { continue; }
            if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
              send({ delta: ev.delta.text });
            } else if (ev.type === 'message_start' && ev.message) {
              usedModel = ev.message.model || usedModel;
              if (ev.message.usage) inTok += ev.message.usage.input_tokens || 0;
            } else if (ev.type === 'message_delta' && ev.usage) {
              outTok += ev.usage.output_tokens || 0;
            } else if (ev.type === 'error') {
              send({ error: (ev.error && ev.error.message) || 'сбой стрима' });
            }
          }
        }
        daily.cost += ((inTok * price[0]) + (outTok * price[1])) / 1e6;
        send({ done: true, model: usedModel, usage: { in: inTok, out: outTok }, budget: { spent: Math.round(daily.cost * 100) / 100, limit: costLimit } });
      } catch {
        send({ error: 'стрим прервался' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
};
