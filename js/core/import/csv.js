/**
 * RFC 4180-style delimited parser: quoted fields, doubled quotes,
 * embedded newlines, CRLF or LF. Reports malformed rows instead of
 * dropping them.
 */

export function parseDelimited(text, delimiter = ',', { quote = '"' } = {}) {
  const rows = [];
  const errors = [];
  let field = '';
  let fields = [];
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let rowStartLine = 1;
  let rowStartIndex = 0;
  const src = text.replace(/^\uFEFF/, '');
  const pushField = () => {
    fields.push(field);
    field = '';
    quotedField = false;
  };
  const pushRow = (endIndex) => {
    pushField();
    const raw = src.slice(rowStartIndex, endIndex);
    if (!(fields.length === 1 && fields[0] === '' && !raw.trim())) rows.push({ line: rowStartLine, fields, raw });
    fields = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === quote) {
        if (src[i + 1] === quote) {
          field += quote;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === quote && field.trim() === '' && !quotedField) {
      field = '';
      inQuotes = true;
      quotedField = true;
      continue;
    }
    if (src.startsWith(delimiter, i)) {
      pushField();
      i += delimiter.length - 1;
      continue;
    }
    if (ch === '\r' && src[i + 1] === '\n') continue;
    if (ch === '\n') {
      pushRow(i);
      line++;
      rowStartLine = line;
      rowStartIndex = i + 1;
      continue;
    }
    if (quotedField && ch !== ' ' && ch !== '\t') {
      errors.push({ line, message: 'Text after a closing quote' });
      quotedField = false;
    }
    field += ch;
  }
  if (inQuotes) {
    errors.push({ line: rowStartLine, message: 'Quoted field is never closed' });
  }
  if (field !== '' || fields.length) pushRow(src.length);
  return { rows, errors };
}

/** Count delimiter occurrences outside quotes on one line (detection). */
export function countOutsideQuotes(line, delimiter) {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (!q && line.startsWith(delimiter, i)) {
      n++;
      i += delimiter.length - 1;
    }
  }
  return n;
}
