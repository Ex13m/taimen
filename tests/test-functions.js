// Тесты chat.js / memory.js / tts.js — эквивалент curl-критериев E2.
const assert = require('assert');
const chat = require(__dirname + '/../netlify/functions/chat.js');
const tts = require(__dirname + '/../netlify/functions/tts.js');

const realFetch = global.fetch;
let fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true, status: 200,
    json: async () => ({ content: [{ type: 'text', text: 'Привет из глубин. [[mood:calm]]' }] }),
  };
};

function ev(method, body, ip) {
  return { httpMethod: method, body: body == null ? null : JSON.stringify(body),
    headers: { 'x-nf-client-connection-ip': ip || '1.2.3.4' } };
}

(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.DAILY_LIMIT = '5';
  delete process.env.OPENROUTER_API_KEY; // чистое окружение: запаски включаются
  delete process.env.REPLICATE_API_TOKEN; // только в своих тестах

  // 405 не-POST
  let r = await chat.handler(ev('GET', null));
  assert.equal(r.statusCode, 405, 'GET -> 405');

  // 400 битый JSON
  r = await chat.handler({ httpMethod: 'POST', body: '{oops', headers: {} });
  assert.equal(r.statusCode, 400, 'битый JSON -> 400');

  // 400 нет messages
  r = await chat.handler(ev('POST', { system: 'x' }));
  assert.equal(r.statusCode, 400, 'нет messages -> 400');

  // 400 кривая роль
  r = await chat.handler(ev('POST', { messages: [{ role: 'wizard', content: 'hi' }] }));
  assert.equal(r.statusCode, 400, 'кривая роль -> 400');

  // 400 >32KB
  r = await chat.handler({ httpMethod: 'POST', body: 'x'.repeat(33000), headers: {} });
  assert.equal(r.statusCode, 400, '>32KB -> 400');

  // 200 валидный
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'привет' }], system: 'ты рыба' }, '10.0.0.1'));
  assert.equal(r.statusCode, 200, 'валидный -> 200');
  assert.ok(JSON.parse(r.body).text.includes('Привет'), 'есть text');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sent.model, 'claude-fable-5', 'дефолтная модель — Fable');
  assert.ok(Array.isArray(sent.fallbacks) && sent.fallbacks[0].model === 'claude-opus-4-8', 'fallback на Opus');
  assert.equal(fetchCalls[0].opts.headers['anthropic-beta'], 'server-side-fallback-2026-06-01', 'beta-заголовок фолбэка');
  assert.ok(sent.max_tokens <= 2000, 'max_tokens <= 2000 (Fable)');
  assert.equal(fetchCalls[0].opts.headers['x-api-key'], 'sk-test', 'ключ ушёл в заголовок');

  // 429 шквал (тот же IP сразу)
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'ещё' }] }, '10.0.0.1'));
  assert.equal(r.statusCode, 429, 'шквал -> 429');

  // обрезка истории до 16 + чужая модель -> дефолт + max_tokens клампится
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
  fetchCalls = [];
  r = await chat.handler(ev('POST', { messages: many, model: 'gpt-9000', max_tokens: 99999 }, '10.0.0.2'));
  assert.equal(r.statusCode, 200);
  const sent2 = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sent2.messages.length, 16, 'история обрезана до 16');
  assert.equal(sent2.model, 'claude-fable-5', 'чужая модель -> дефолт');
  assert.equal(sent2.max_tokens, 2000, 'кламп max_tokens по потолку модели');

  // haiku разрешён
  fetchCalls = [];
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }], model: 'claude-haiku-4-5' }, '10.0.0.3'));
  assert.equal(JSON.parse(fetchCalls[0].opts.body).model, 'claude-haiku-4-5', 'haiku разрешён');

  // дневной лимит: уже 4 вызова, лимит 5 -> ещё 1 ок, потом 429
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.4'));
  assert.equal(r.statusCode, 200, '5-й вызов ок');
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.5'));
  assert.equal(r.statusCode, 200, '5-й учтённый вызов ещё ок');
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.15'));
  assert.equal(r.statusCode, 429, 'сверх лимита -> 429 (дневной лимит)');
  assert.ok(JSON.parse(r.body).error.includes('отдыхает'), 'человеческий текст лимита');

  // ошибка Anthropic -> краткий error без стека
  global.fetch = async () => ({ ok: false, status: 529, json: async () => ({ error: { message: 'overloaded' } }) });
  await new Promise(res => setTimeout(res, 2100));
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.4'));
  // дневной лимит уже съеден -> это 429; поднимем лимит
  process.env.DAILY_LIMIT = '100';
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.6'));
  assert.equal(r.statusCode, 502, 'апстрим 529 -> 502');
  assert.ok(!JSON.parse(r.body).error.includes('stack'), 'без стека');

  // без ключа -> 503
  delete process.env.ANTHROPIC_API_KEY;
  await new Promise(res => setTimeout(res, 2100));
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.7'));
  assert.equal(r.statusCode, 503, 'нет ключа -> 503');

  // запасной мозг №1 (OpenRouter): нет ключа Anthropic, есть OPENROUTER_API_KEY -> 200
  process.env.OPENROUTER_API_KEY = 'or_test';
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      choices: [{ message: { content: 'Отвечаю из запаса.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }], system: 'ты рыба' }, '10.0.0.30'));
  assert.equal(r.statusCode, 200, 'openrouter-запаска -> 200');
  const jb = JSON.parse(r.body);
  assert.equal(jb.text, 'Отвечаю из запаса.', 'текст от запаски');
  assert.ok(jb.model.indexOf('openrouter/') === 0, 'модель помечена openrouter/');
  assert.ok(fetchCalls[0].url.includes('openrouter.ai'), 'запрос ушёл в OpenRouter');
  assert.equal(fetchCalls[0].opts.headers.authorization, 'Bearer or_test', 'ключ в заголовке');
  const orSent = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(orSent.messages[0].role, 'system', 'system ушёл первым сообщением');
  assert.ok(orSent.max_tokens <= 1000, 'потолок токенов запаски');
  assert.equal(jb.budget.spent, 0, ':free — бюджет не тратится');

  // основной мозг упал (529) + запаска есть -> отвечает запаска
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const calls2 = [];
  global.fetch = async (url) => {
    calls2.push(url);
    if (url.includes('anthropic')) return { ok: false, status: 529, json: async () => ({ error: { message: 'overloaded' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'запас' } }], usage: {} }) };
  };
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.31'));
  assert.equal(r.statusCode, 200, '529 у Anthropic + запаска -> 200');
  assert.equal(JSON.parse(r.body).text, 'запас', 'текст от запаски');
  assert.equal(calls2.length, 2, 'два вызова: Anthropic, потом OpenRouter');
  delete process.env.OPENROUTER_API_KEY;

  // запасной мозг №2 (Replicate): только REPLICATE_API_TOKEN
  delete process.env.ANTHROPIC_API_KEY;
  process.env.REPLICATE_API_TOKEN = 'r8_test';
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({
      status: 'succeeded', output: ['Из ', 'Replicate.'],
      metrics: { input_token_count: 10, output_token_count: 5 } }) };
  };
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.32'));
  assert.equal(r.statusCode, 200, 'replicate-запаска -> 200');
  const jb2 = JSON.parse(r.body);
  assert.equal(jb2.text, 'Из Replicate.', 'склейка output-массива');
  assert.ok(jb2.model.indexOf('replicate/') === 0, 'модель помечена replicate/');
  assert.ok(fetchCalls[0].url.includes('replicate.com'), 'запрос ушёл в Replicate');
  assert.ok(JSON.parse(fetchCalls[0].opts.body).input.prompt.includes('Хозяин: x'), 'история склеена в диалог');

  // failed-предикт Replicate с частичным output НЕ выдаётся как ответ
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    status: 'failed', error: 'OOM', output: ['обры'] }) });
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.33'));
  assert.equal(r.statusCode, 502, 'failed-предикт -> 502');
  assert.ok(JSON.parse(r.body).error.includes('споткнулся'), 'человеческий текст ошибки');
  delete process.env.REPLICATE_API_TOKEN;

  // tts заглушка
  r = await tts.handler({});
  assert.equal(r.statusCode, 501, 'tts -> 501');

  // memory без токена
  delete process.env.GITHUB_TOKEN;
  const memory = require(__dirname + '/../netlify/functions/memory.js');
  r = await memory.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).persistent, false, 'GET без токена -> persistent:false');
  r = await memory.handler({ httpMethod: 'POST', body: '{"data":{}}', headers: {} });
  assert.equal(r.statusCode, 501, 'POST без токена -> 501');

  // ACCESS_KEY: замок на чат и память
  process.env.ACCESS_KEY = 'sekret';
  await new Promise(res => setTimeout(res, 2100));
  r = await chat.handler(ev('POST', { messages: [{ role: 'user', content: 'x' }] }, '10.0.0.20'));
  assert.equal(r.statusCode, 401, 'без пароля -> 401');
  assert.equal(JSON.parse(r.body).locked, true, 'флаг locked');
  r = await chat.handler({ httpMethod: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    headers: { 'x-nf-client-connection-ip': '10.0.0.21', 'x-taimen-key': 'sekret' } });
  assert.notEqual(r.statusCode, 401, 'с паролем 401 нет (дальше 503 без ключа мозга)');
  r = await memory.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(r.statusCode, 401, 'память без пароля -> 401');
  r = await memory.handler({ httpMethod: 'GET', headers: { 'x-taimen-key': 'sekret' } });
  assert.equal(r.statusCode, 200, 'память с паролем -> 200');
  delete process.env.ACCESS_KEY;

  global.fetch = realFetch;
  console.log('ВСЕ ТЕСТЫ ПРОШЛИ ✓');
})().catch((e) => { console.error('ТЕСТ УПАЛ:', e.message); process.exit(1); });
