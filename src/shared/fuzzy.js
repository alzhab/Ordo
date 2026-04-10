// Приводит строку к единому виду для сравнения:
// нижний регистр, дефисы/тире → пробел, удаляет спецсимволы,
// схлопывает множественные пробелы.
// "Купить молоко!" → "купить молоко"
// "self-improvement" → "self improvement"
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[-–—_]/g, ' ')
    .replace(/[^а-яёa-z0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Нечёткий поиск: проверяет совпадает ли query с text.
// Используется в intent.js когда пользователь голосом называет задачу
// или план и бот должен найти похожую запись в БД.
//
// Алгоритм:
//   1. Точное вхождение нормализованного query в нормализованный text → true
//   2. Иначе — каждое слово query (≥2 символа) должно встречаться в text
//
// Примеры:
//   fuzzyMatch("Купить молоко", "молоко")        → true  (вхождение)
//   fuzzyMatch("Позвонить маме", "позвони маме") → true  (все слова есть)
//   fuzzyMatch("Купить молоко", "хлеб")          → false
function fuzzyMatch(text, query) {
  const h = normalize(text);
  const q = normalize(query);
  if (!q) return false;
  if (h.includes(q)) return true;
  const words = q.split(' ').filter(w => w.length >= 2);
  return words.length > 0 && words.every(w => h.includes(w));
}

module.exports = { normalize, fuzzyMatch };
