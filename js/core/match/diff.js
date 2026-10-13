/**
 * Character-level diff used to highlight differences between a typed
 * answer and the expected answer on the correction screen.
 */

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function merge(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * @returns {{type:'same'|'missing'|'extra', text:string}[]}
 *   'missing' = in expected but not typed; 'extra' = typed but not expected.
 */
export function diffAnswer(typed, expected) {
  const a = [...typed];
  const b = [...expected];
  if (a.length * b.length > 250000) {
    return [{ type: 'extra', text: typed }, { type: 'missing', text: expected }];
  }
  const t = lcsTable(a, b);
  const segs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      segs.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) {
      segs.push({ type: 'extra', text: a[i] });
      i++;
    } else {
      segs.push({ type: 'missing', text: b[j] });
      j++;
    }
  }
  while (i < a.length) segs.push({ type: 'extra', text: a[i++] });
  while (j < b.length) segs.push({ type: 'missing', text: b[j++] });
  return merge(segs);
}
