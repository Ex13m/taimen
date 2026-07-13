// ТАЙМЕНЬ · постоянная память через GitHub API
// GET  /api/memory        -> { persistent, data }
// POST /api/memory {data} -> { ok }
//
// Память хранится в repo (GITHUB_REPO, дефолт Ex13m/taimen) в ветке
// MEMORY_BRANCH (дефолт taimen-memory), файл memory/taimen-memory.json.
// Отдельная ветка нужна, чтобы каждое сохранение памяти не триггерило
// пересборку сайта на Netlify. Токен — GITHUB_TOKEN в ENV (contents: rw).
// Без токена: GET отвечает persistent:false, POST -> 501; фронт живёт
// на localStorage.

const API = 'https://api.github.com';
const FILE_PATH = 'memory/taimen-memory.json';
const MAX_BODY_BYTES = 64 * 1024;
const MIN_WRITE_INTERVAL_MS = 5000;

const lastWrite = new Map(); // ip -> ts

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function gh(token, path, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'taimen-memory',
      ...(opts.headers || {}),
    },
  });
}

async function ensureBranch(token, repo, branch) {
  const ref = await gh(token, `/repos/${repo}/git/ref/heads/${branch}`);
  if (ref.ok) return true;
  if (ref.status !== 404) return false;
  // ветки нет — создаём от дефолтной
  const meta = await gh(token, `/repos/${repo}`);
  if (!meta.ok) return false;
  const defaultBranch = (await meta.json()).default_branch || 'main';
  const base = await gh(token, `/repos/${repo}/git/ref/heads/${defaultBranch}`);
  if (!base.ok) return false;
  const sha = (await base.json()).object.sha;
  const created = await gh(token, `/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  return created.ok;
}

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'Ex13m/taimen';
  const branch = process.env.MEMORY_BRANCH || 'taimen-memory';

  if (event.httpMethod === 'GET') {
    if (!token) return json(200, { persistent: false, data: null });
    try {
      const res = await gh(token, `/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`);
      if (res.status === 404) return json(200, { persistent: true, data: null });
      if (!res.ok) {
        console.error('memory read failed', res.status);
        return json(200, { persistent: false, data: null });
      }
      const file = await res.json();
      const text = Buffer.from(file.content || '', 'base64').toString('utf8');
      let data = null;
      try { data = JSON.parse(text); } catch { /* повреждённый файл — начнём заново */ }
      return json(200, { persistent: true, data });
    } catch (e) {
      console.error('memory read error', e && e.message);
      return json(200, { persistent: false, data: null });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Только GET или POST.' });
  if (!token) return json(501, { error: 'Постоянная память не подключена (нет GITHUB_TOKEN).' });

  const raw = event.body || '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json(400, { error: 'Память переполнена: запись больше 64KB.' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'Битый JSON.' }); }
  if (!body || typeof body.data !== 'object' || body.data === null) {
    return json(400, { error: 'Нужно поле data (объект).' });
  }

  const ip = event.headers['x-nf-client-connection-ip'] || 'unknown';
  const now = Date.now();
  if (now - (lastWrite.get(ip) || 0) < MIN_WRITE_INTERVAL_MS) {
    return json(429, { error: 'Память пишется не чаще раза в 5 секунд.' });
  }
  lastWrite.set(ip, now);
  if (lastWrite.size > 500) lastWrite.clear();

  try {
    if (!(await ensureBranch(token, repo, branch))) {
      return json(502, { error: 'Не удалось подготовить ветку памяти.' });
    }
    // sha текущей версии файла (если есть)
    let sha;
    const cur = await gh(token, `/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`);
    if (cur.ok) sha = (await cur.json()).sha;

    const put = await gh(token, `/repos/${repo}/contents/${FILE_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'taimen: память ' + new Date().toISOString(),
        content: Buffer.from(JSON.stringify(body.data, null, 2), 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) {
      console.error('memory write failed', put.status, await put.text().catch(() => ''));
      return json(502, { error: 'Не удалось записать память.' });
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('memory write error', e && e.message);
    return json(502, { error: 'Не удалось записать память.' });
  }
};
