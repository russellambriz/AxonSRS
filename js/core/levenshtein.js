/**
 * Optimal-string-alignment (restricted Damerau–Levenshtein) distance.
 * A transposition of adjacent characters counts as one edit, which
 * matches how typing mistakes usually happen.
 *
 * `max` lets callers stop early once the distance exceeds a budget;
 * the return value is then max + 1.
 */
export function editDistance(a, b, max = Infinity) {
  const s = [...a];
  const t = [...b];
  const n = s.length;
  const m = t.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (n === 0) return m;
  if (m === 0) return n;
  let prevPrev = new Array(m + 1).fill(0);
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[m];
}
