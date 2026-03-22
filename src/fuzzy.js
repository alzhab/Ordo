function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[-–—_]/g, ' ')
    .replace(/[^а-яёa-z0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(text, query) {
  const h = normalize(text);
  const q = normalize(query);
  if (!q) return false;
  if (h.includes(q)) return true;
  const words = q.split(' ').filter(w => w.length >= 2);
  return words.length > 0 && words.every(w => h.includes(w));
}

module.exports = { normalize, fuzzyMatch };
