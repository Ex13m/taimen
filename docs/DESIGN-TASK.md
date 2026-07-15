# ЗАДАНИЕ НА ДИЗАЙН ИНТЕРФЕЙСА — TAIMEN (весь проект)

Готово к вставке в любой дизайн-инструмент (Stitch, Claude Design, Midjourney,
Figma AI, nano-banana и т.п.). Ниже — короткий английский промпт для генераторов
и подробное русское описание всех экранов.

---

## A. Короткий промпт (вставить в UI-генератор / image-модель)

> **Design a full mobile-first UI for "TAIMEN" — a living galaxy operating system.**
> Dark deep-space background (indigo #04070f → #14224f) with stars and faint
> green/blue nebula. Center: a glowing plasma singularity core labeled "TAIMEN"
> with a hot bright center, electric filaments, glowing latitude/longitude
> techno-grid lines and a colored atmospheric halo. Around it, on inclined 3D
> orbits, several smaller glowing plasma planets (violet, steel-blue, teal, amber,
> green, gold), each a glassy energy sphere with its own surface line-pattern.
> Overlay floating translucent glass panels (frosted, thin glowing borders,
> rounded 12px, backdrop blur):
> - top-left: HUD — big letter-spaced title "TAIMEN", status dot + word, version;
> - top-right: memory chip "🜁 память: git · 12";
> - right edge, small monospace log running top-to-bottom (agent activity ticker);
> - a floating translucent token gauge "⬡ 12k ткн · ~$0.30" in a corner;
> - bottom: a glass chat panel with message bubbles, a text input, mic 🎙, send ➤, voice 🔊;
> - bottom-left: a glowing circular "helm" handle emitting a radial one-finger command fan;
> - a planet info card (glass) showing planet title, epithet, skills, live data.
> Mood: deep, calm power, techno-sacred (subtle Warhammer-40k grandeur but clean
> and elegant, not busy). Neon glow, glass, thin lines, generous tap targets.
> Cyrillic + Latin type, wide tracking in titles, monospace for numbers.
> No real logos or brands. Cohesive dark theme.

Для светлой темы: замени фон на очень светлый холодный (#eef3ff), стекло —
светлое матовое, свечение мягче; всё остальное то же.

---

## B. Экраны (что должно быть нарисовано)

1. **Главный вид галактики** — ядро + планеты на наклонённых орбитах; поверх —
   все парящие панели (HUD, датчик расхода, журнал справа, штурвал слева внизу,
   строка чата снизу). Это «домашний экран».
2. **Инфо-экран планеты** (стеклянная карточка по центру-снизу): титул планеты,
   эпитет, суть, список умений, «последние данные», личный расход. У планеты
   Иммортис — живой обратный отсчёт (годы/мес/дни/чч:мм:сс.мс).
3. **Чат** — реплики хозяина (справа) и планет (слева) в стеклянных пузырях,
   у каждой реплики значок «копировать»; строка ввода с 🎙 и 🔊.
4. **Штурвал** (управление одним пальцем) — из светящейся рукояти слева внизу
   веером расходятся команды: ОРБЫ / ВИД / ГОЛОС / ЗНАНИЯ / ЗВУК, с раскрытием веток.
5. **Журнал вселенной** — узкий столбец мелким моноширинным шрифтом справа,
   строки бегут сверху вниз: «🚀 ТАЙМЕНЬ→СКРИПТОРУМ · вопрос», «🌐 сеть: …»,
   «🌱 колония: родилась ТАКТИКОРУМ».
6. **Экран обновления** — «что нового»: астероиды/осколки, замедляющиеся к центру,
   версия и список изменений.
7. **Панель знаний** — скормить материалы (текст/файл), «что он запомнил сам»,
   правила хозяина, книга пожеланий ☆.

## C. Планеты (титулы, цвет, узор поверхности)

| Титул | Роль | Палитра | Узор линий |
|---|---|---|---|
| ТАЙМЕНЬ (ядро) | владыка глубин | сине-фиолет | кольца, линзирование |
| СТРАТЕГОРУМ | замысел | фиолет→пурпур | меридианы-маршруты |
| ТАКТИКОРУМ | манёвр | стально-синий | косые шевроны-векторы |
| ПРОГРЕССОРУМ | развитие (Третий Путь) | изумруд→золото | маяки, восходящие импульсы |
| АНАЛИТИКУМ | данные | бирюза→зелёный | широтные дата-полосы |
| СКРИПТОРУМ | тексты | янтарь→алый | диагональные руны |
| КУСТОДЕС | память | зелёный | гексо-грани кристалла |
| СПЕКУЛЯТОР | разведка | серо-синий | сканирующая полоса |
| ИММОРТИС | отсчёт до бессмертия | золото→белый | концентрические кольца-часы |
| ФИСКАТОРУМ | казна | золото | сетка-гроссбух |

## D. Стиль

- Настроение: тёмный космос, глубина, спокойная мощь, техно-сакральность
  (лёгкий налёт WH40k, но чисто и элегантно, без визуального шума).
- Цвета: фон индиго #04070f→#14224f; акценты — голубой #6ea8ff, изумруд #6fdc4f,
  золото #ffc24d; у каждой планеты своя палитра (таблица C).
- Стекло, свечение, тонкие светящиеся границы, скругления ~12px, backdrop-blur.
- Типографика: широкие трек-инги в титулах (кир.+лат.), моноширинные цифры
  в отсчёте, балансах, датчике.
- Мобильный первый: крупные тап-зоны (≥44px), safe-area, всё парящее и
  полупрозрачное. Тёмная и светлая темы.

## E. Чего НЕ делать

- Никаких реальных логотипов/брендов, ничьих лиц, кроме предоставленных хозяином.
- Не перегружать: орб и планеты — главные, панели — второстепенные и прозрачные.
- Не «корпоративно» и не «игрушечно» — благородно и глубоко.

> Полный контекст системы (иерархия, взаимодействия, обоснование) — в
> docs/DESIGN-BRIEF.md и docs/STRATEGY-GALAXY.md.
