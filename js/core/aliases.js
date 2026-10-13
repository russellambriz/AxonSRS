/**
 * Accepted-answer lists and their pipe-separated text form.
 *
 * Internally every answer side is a structured array of strings. The
 * editing, import and export convention is a single string where
 * alternatives are separated by an unescaped "|".
 *
 * Escaping rules (minimal, round-trip safe):
 *   "\|" decodes to a literal "|"
 *   "\\" decodes to a literal "\"
 *   any other backslash is kept as-is, so LaTeX such as \frac{1}{2}
 *   can be typed without doubling backslashes.
 * The encoder only escapes a backslash when it would otherwise be
 * ambiguous (followed by "|", "\" or at the end of a value).
 */

export function decodeAnswers(text) {
  if (text == null) return [];
  const source = String(text);
  const out = [];
  let current = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === '|' || next === '\\') {
        current += next;
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '|') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function encodeAnswer(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '|') {
      out += '\\|';
    } else if (ch === '\\') {
      const next = s[i + 1];
      out += next === undefined || next === '|' || next === '\\' ? '\\\\' : '\\';
    } else {
      out += ch;
    }
  }
  return out;
}

export function encodeAnswers(list) {
  return (list || []).map(encodeAnswer).join(' | ');
}

/** Append an alias if it is not already present (exact, trimmed). */
export function addAlias(list, alias) {
  const value = String(alias).trim();
  if (!value) return list.slice();
  if (list.some((v) => v === value)) return list.slice();
  return [...list, value];
}

export function removeAlias(list, alias) {
  return list.filter((v) => v !== alias);
}

/**
 * Split on an unescaped multi-character separator such as "::".
 * "\::" yields a literal "::". Used by the delimiter import format.
 */
export function splitUnescaped(text, separator) {
  const parts = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text.startsWith(separator, i + 1)) {
      current += separator;
      i += separator.length;
      continue;
    }
    if (text.startsWith(separator, i)) {
      parts.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += text[i];
  }
  parts.push(current);
  return parts;
}
