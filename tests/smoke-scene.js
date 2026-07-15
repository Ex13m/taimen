// Смоук сцены для CI: поднимаем статик-сервер на репозитории, стабим /api,
// открываем index.html в headless Chrome через CDP (без npm-зависимостей),
// проверяем: сцена ожила (шейдер слинковался), планеты заспавнились,
// ноль ошибок консоли. Ловит белый экран и сломанный GLSL — то, что тесты
// функций не видят. Chrome берём из CHROME_BIN (в CI ставит setup-chrome).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const cands = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  try { return execSync('which chromium-browser chromium google-chrome 2>/dev/null | head -n1').toString().trim(); } catch { /* нет */ }
  return null;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const url = req.url.split('?')[0];
  if (url === '/api/memory') return send(200, { persistent: false, data: null });
  if (url === '/api/tts') return send(501, { error: 'stub' });
  if (url === '/api/chat') return send(200, { text: 'Я здесь. [[mood:calm]]', model: 'claude-fable-5', usage: { in: 1, out: 1 } });
  const file = url === '/' ? '/index.html' : url;
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  const chromeBin = findChrome();
  if (!chromeBin) { console.error('✕ не нашёл Chrome (задай CHROME_BIN)'); process.exit(2); }
  await new Promise((r) => server.listen(PORT, r));
  const chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-debugging-port=9350', '--window-size=1000,700',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 20 && !ws; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9350/json')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); }
    } catch { /* ждём */ }
  }
  if (!ws) { console.error('✕ Chrome не поднялся'); chrome.kill(); process.exit(2); }

  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } else events.push(j); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value;

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(4500);
  await evalJs(`document.getElementById('news-ok') && document.getElementById('news-ok').click()`);
  await sleep(6000); // автостарт + разлёт нескольких планет

  const state = JSON.parse(await evalJs(`JSON.stringify({
    hasApi: !!window.TAIMEN,
    sceneOk: !!(window.TAIMEN && TAIMEN.sceneOk && TAIMEN.sceneOk()),
    orbs: (window.TAIMEN && TAIMEN.orbs) ? TAIMEN.orbs.length : 0,
    bootGone: !!(document.getElementById('boot') && document.getElementById('boot').classList.contains('gone')),
    ver: (window.TAIMEN && TAIMEN.ver) || '?'
  })`));

  // фатальны только настоящие ошибки/исключения, не warning (иначе флейк на
  // предупреждениях драйвера swiftshader или будущих console.warn)
  const errors = events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' &&
      !(e.params.entry.source === 'network' && /\/api\//.test(e.params.entry.url || '')))
  ).map((e) => JSON.stringify(e.params).slice(0, 260));

  chrome.kill(); server.close(); try { ws.close(); } catch { /* ok */ }

  console.log('состояние сцены:', JSON.stringify(state));
  const problems = [];
  if (!state.hasApi) problems.push('нет window.TAIMEN');
  if (!state.sceneOk) problems.push('шейдер НЕ слинковался (сцена = null)');
  if (state.orbs < 3) problems.push('планет мало: ' + state.orbs);
  if (!state.bootGone) problems.push('заставка не погасла (автостарт не сработал)');
  if (errors.length) problems.push('ошибки консоли: ' + errors.length);

  if (problems.length) {
    console.error('✕ СМОУК СЦЕНЫ УПАЛ:\n - ' + problems.join('\n - '));
    if (errors.length) console.error('консоль:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('смоук сцены: сцена жива, планет ' + state.orbs + ', версия ' + state.ver + ', консоль чистая ✓');
  process.exit(0);
})().catch((e) => { console.error('СМОУК УПАЛ:', e && e.message); process.exit(1); });
