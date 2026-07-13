// ТАЙМЕНЬ · ШПИОН-разведчик (scheduled function)
// Сам ходит по RSS-лентам долголетия, отдаёт находки Иммортала (Sonnet 5),
// пишет анализы и сдвиг отсчёта прямо в git-память проекта.
// Расписание — в netlify.toml. Бюджет: SCOUT_DAILY_COST (дефолт $0.50),
// жёсткая отсечка на 110% (перерасход не более 10%).

const GH = 'https://api.github.com';
const FILE_PATH = 'memory/taimen-memory.json';
const FEEDS = [
  'https://www.fightaging.org/feed/',
  'https://longevity.technology/feed/',
];
const MAX_PER_RUN = 3;

function gh(token, path, opts = {}) {
  return fetch(GH + path, {
    ...opts,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'taimen-scout',
      ...(opts.headers || {}),
    },
  });
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

async function fetchFeedItems(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'taimen-scout/1.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return (xml.match(/<item[\s\S]*?<\/item>/gi) || []).slice(0, 10).map((it) => ({
      title: pickTag(it, 'title').slice(0, 200),
      link: pickTag(it, 'link').slice(0, 300),
      desc: pickTag(it, 'description').slice(0, 900),
    })).filter((i) => i.title && i.link);
  } catch (e) {
    console.error('feed failed', url, e && e.message);
    return [];
  }
}

async function judge(apiKey, item) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 300,
      system: 'Ты — Иммортал, агент отсчёта до бессмертия (LEV). Оцени новость о долголетии. Ответь СТРОГО тремя строками:\nОЦЕНКА: число -10..+10\nСДВИГ: дни со знаком (минус = приближает бессмертие; прорыв ≈ -300, заметный результат ≈ -60, мелочь ≈ -5, провал/запрет ≈ +60; нерелевантное = 0)\nСУТЬ: одна строка по-русски',
      messages: [{ role: 'user', content: item.title + '\n\n' + item.desc }],
    }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status);
  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const rating = parseFloat((out.match(/ОЦЕНКА:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
  const shift = parseFloat((out.match(/СДВИГ:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
  const gist = ((out.match(/СУТЬ:\s*([^\n]+)/i) || [])[1] || '').trim();
  const u = data.usage || {};
  const cost = ((u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15) / 1e6;
  if (isNaN(rating) || isNaN(shift) || !gist) return { skip: true, cost };
  return {
    cost,
    analysis: {
      ts: Date.now(), rating: Math.max(-10, Math.min(10, rating)),
      shift: Math.max(-3650, Math.min(3650, shift)), gist: gist.slice(0, 180),
      title: item.title.slice(0, 80), src: 'scout', link: item.link,
    },
  };
}

exports.handler = async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'Ex13m/taimen';
  const branch = process.env.MEMORY_BRANCH || 'taimen-memory';
  if (!apiKey || !token) {
    console.log('scout: спит — нет ключей (ANTHROPIC_API_KEY/GITHUB_TOKEN)');
    return { statusCode: 200, body: 'sleep' };
  }

  // читаем память проекта
  let sha = null, mem = {};
  const cur = await gh(token, `/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`);
  if (cur.ok) {
    const f = await cur.json();
    sha = f.sha;
    try { mem = JSON.parse(Buffer.from(f.content || '', 'base64').toString('utf8')) || {}; } catch { mem = {}; }
  } else if (cur.status !== 404) {
    console.error('scout: память недоступна', cur.status);
    return { statusCode: 200, body: 'no-memory' };
  }

  mem.scout = mem.scout || { seen: [], meter: { day: '', cost: 0 }, lastRun: 0, lastReport: '' };
  const today = new Date().toISOString().slice(0, 10);
  if (mem.scout.meter.day !== today) mem.scout.meter = { day: today, cost: 0 };

  // бюджет: жёсткая отсечка на 110% дневного лимита разведчика
  const capUsd = parseFloat(process.env.SCOUT_DAILY_COST) || 0.5;
  if (mem.scout.meter.cost >= capUsd * 1.1) {
    console.log('scout: дневной бюджет исчерпан (', mem.scout.meter.cost.toFixed(3), '/', capUsd, ')');
    return { statusCode: 200, body: 'budget' };
  }

  // собираем свежие новости
  const seen = new Set(mem.scout.seen || []);
  let items = [];
  for (const feed of FEEDS) items = items.concat(await fetchFeedItems(feed));
  const fresh = items.filter((i) => !seen.has(i.link)).slice(0, MAX_PER_RUN);
  if (!fresh.length) {
    console.log('scout: нового нет');
    return { statusCode: 200, body: 'nothing-new' };
  }

  mem.immortal = mem.immortal || { baseTs: Date.UTC(2045, 0, 1), shiftMs: 0, analyses: [] };
  let added = 0;
  for (const item of fresh) {
    if (mem.scout.meter.cost >= capUsd * 1.1) break;
    try {
      const v = await judge(apiKey, item);
      mem.scout.meter.cost += v.cost;
      seen.add(item.link);
      if (v.skip) continue;
      mem.immortal.analyses.unshift(v.analysis);
      mem.immortal.shiftMs += v.analysis.shift * 86400000;
      added++;
    } catch (e) {
      console.error('scout judge failed', e && e.message);
    }
  }
  while (mem.immortal.analyses.length > 30) mem.immortal.analyses.pop();
  mem.scout.seen = [...seen].slice(-300);
  mem.scout.lastRun = Date.now();
  mem.scout.lastReport = 'Шпион: осмотрено ' + fresh.length + ', в журнал Иммортала — ' + added;

  const put = await gh(token, `/repos/${repo}/contents/${FILE_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'taimen-scout: доклад ' + new Date().toISOString(),
      content: Buffer.from(JSON.stringify(mem, null, 2), 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) console.error('scout: запись памяти не удалась', put.status);
  console.log('scout:', mem.scout.lastReport, '· потрачено за день $' + mem.scout.meter.cost.toFixed(3));
  return { statusCode: 200, body: 'ok:' + added };
};
