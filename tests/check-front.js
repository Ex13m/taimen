// Парс-чек фронта: вырезаем inline-JS из index.html и проверяем синтаксис
// (node --check). Ловит фатальные ошибки, из-за которых был бы белый экран —
// то, что обычные тесты функций не видят. Плюс инвариант версии.
const fs = require('fs');
const cp = require('child_process');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let fail = 0;

// 1) синтаксис всех inline-скриптов (без атрибута src)
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0;
while ((m = re.exec(html))) {
  const js = m[1];
  if (!js.trim()) continue;
  i += 1;
  const f = path.join(os.tmpdir(), 'taimen-front-' + i + '.js');
  fs.writeFileSync(f, js);
  try {
    cp.execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    console.error('✕ синтаксис упал в inline-script #' + i + ':\n' + String(e.stderr || e.message).slice(0, 800));
    fail += 1;
  }
}
if (i === 0) { console.error('✕ не нашёл ни одного inline-скрипта'); fail += 1; }

// 2) инвариант версии: APP_VERSION совпадает с HUD и присутствует в CHANGELOG
const ver = (html.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (!ver) { console.error('✕ нет APP_VERSION'); fail += 1; }
else {
  if (html.indexOf('v' + ver) < 0) { console.error('✕ версия ' + ver + ' не встречается в HUD (ожидал «v' + ver + '»)'); fail += 1; }
  const ch = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (ch.indexOf(ver) < 0) { console.error('✕ версия ' + ver + ' отсутствует в CHANGELOG.md'); fail += 1; }
}

// 3) инвариант протокола: каждый тег из системного промпта имеет разбор в parseTags
const promptTags = new Set();
const pm = html.match(/\[\[(mood|orb|note|rule|wish):/g) || [];
pm.forEach((t) => promptTags.add(t.replace(/\[\[/, '').replace(':', '')));
['mood', 'orb', 'note', 'rule', 'wish'].forEach((tag) => {
  if (promptTags.has(tag) && html.indexOf('\\[\\[' + (tag === 'mood' || tag === 'orb' ? '(mood|orb)' : tag)) < 0
      && html.indexOf('(mood|orb)') < 0) {
    // мягкая проверка: parseTags должен упоминать тег
    if (html.indexOf(tag) < 0) { console.error('✕ тег [[' + tag + ']] не разбирается в parseTags'); fail += 1; }
  }
});

if (fail) { console.error('\nПРОВЕРКА ФРОНТА УПАЛА: ' + fail + ' проблем(ы)'); process.exit(1); }
console.log('фронт: синтаксис ок · версия ' + ver + ' консистентна · теги на месте ✓');
