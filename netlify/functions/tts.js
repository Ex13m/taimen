// ТАЙМЕНЬ · голос глубин: ElevenLabs TTS.
// POST /api/tts { text } -> audio/mpeg (base64). Без ELEVENLABS_API_KEY — 501,
// фронт тихо остаётся на браузерном синтезе.

const VOICE = process.env.ELEVENLABS_VOICE || 'onwK4e9ZLuTAKqWW03F9'; // Daniel — низкий, спокойный, мультиязычный
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
// у каждого орба свой тембр (premade-голоса ElevenLabs); переопределить —
// переменной ELEVENLABS_VOICES = JSON {"shpion":"voiceId",...}
let VOICES = {
  main: VOICE,
  strateg: 'pNInz6obpgDQGcFmaJgB',  // Adam — собранный
  analitik: 'ErXwobaYiN019PkySvjV', // Antoni — точный
  pisar: 'TxGEqnHWrfWFTfGW9XjX',    // Josh — тёплый рассказчик
  hranitel: 'VR6AewLTigWG4xSOukaG', // Arnold — старый бас
  shpion: 'N2lVS1w4EtoT3dr4eOWO',   // Callum — вкрадчивый
  immortal: 'MF3mGyEYCl7XYWbV9V6O', // Elli — неземная
  progressor: 'onwK4e9ZLuTAKqWW03F9', // Daniel — зрелый, взвешенный
  bank: 'pNInz6obpgDQGcFmaJgB',       // Adam — сухой, деловой
  taktik: 'TxGEqnHWrfWFTfGW9XjX',     // Josh — командный
};
try { VOICES = Object.assign(VOICES, JSON.parse(process.env.ELEVENLABS_VOICES || '{}')); } catch { /* дефолты */ }
const MAX_CHARS = 600; // одна реплика
const DAY_CHARS = parseInt(process.env.TTS_DAILY_CHARS, 10) || 20000; // дневной потолок символов

let daily = { day: '', chars: 0 }; // мягкий лимит в памяти инстанса (как у chat.js)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Только POST.' });

  const requiredKey = process.env.ACCESS_KEY;
  if (requiredKey && event.headers['x-taimen-key'] !== requiredKey) {
    return json(401, { error: 'Таймень закрыт паролем.', locked: true });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return json(501, { error: 'Красивый голос ещё не подключён — говорю браузерным.' });

  let body;
  try { body = JSON.parse(event.body || ''); } catch { return json(400, { error: 'Битый JSON.' }); }
  const text = String((body && body.text) || '').trim().slice(0, MAX_CHARS);
  if (!text) return json(400, { error: 'Нужен text.' });
  const voice = VOICES[body && body.orb] || VOICES.main; // тембр по орбу

  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, chars: 0 };
  if (daily.chars + text.length > DAY_CHARS) {
    return json(429, { error: 'Голос глубин отдыхает до завтра (дневной потолок символов).' });
  }
  daily.chars += text.length;

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.7, style: 0.25 },
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify((await res.json()).detail || '').slice(0, 200); } catch { /* ignore */ }
      console.error('elevenlabs error', res.status, detail);
      return json(res.status === 401 ? 502 : 502, {
        error: res.status === 401 ? 'Ключ голоса не подошёл (ELEVENLABS_API_KEY).'
          : res.status === 429 ? 'Голос устал (лимит ElevenLabs). Говорю браузерным.'
          : 'Голос глубин сейчас недоступен.',
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: 200,
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('tts failure', e && e.message);
    return json(502, { error: 'Голос глубин прервался.' });
  }
};
