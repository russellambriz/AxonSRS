/**
 * Minimal, DOM-free HTML → text conversion for Anki exports. The output
 * is treated as Markdown *data*; nothing here is ever executed or
 * inserted as HTML. Media references are reported, not silently dropped.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', times: '×', divide: '÷', minus: '−', plusmn: '±', deg: '°', middot: '·', rarr: '→', larr: '←', harr: '↔', le: '≤', ge: '≥', ne: '≠', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω', infin: '∞', radic: '√', sup2: '²', sup3: '³', frac12: '½' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

export function looksLikeHtml(text) {
  return /<\/?(br|div|p|span|b|i|u|strong|em|sub|sup|img|ul|ol|li|font|a|table|tr|td)\b[^>]*>/i.test(text) || /&(nbsp|amp|lt|gt|quot|#\d+);/.test(text);
}

/**
 * @returns {{ text: string, warnings: string[] }}
 */
export function htmlToText(html) {
  const warnings = [];
  let s = String(html);
  s = s.replace(/\[sound:([^\]]+)\]/g, (_, f) => {
    warnings.push(`Audio reference "${f}" was not imported (attach audio in the editor).`);
    return '';
  });
  s = s.replace(/<img\b[^>]*src=["']?([^"' >]+)[^>]*>/gi, (_, src) => {
    warnings.push(`Image "${src}" was not imported (add it in the editor).`);
    return '';
  });
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, () => {
    warnings.push('Removed embedded script or style content.');
    return '';
  });
  s = s.replace(/<sup>([^<]*)<\/sup>/gi, (_, t) => ([...t].every((c) => c in SUP) ? [...t].map((c) => SUP[c]).join('') : `^(${t})`));
  s = s.replace(/<sub>([^<]*)<\/sub>/gi, (_, t) => ([...t].every((c) => c in SUB) ? [...t].map((c) => SUB[c]).join('') : `_(${t})`));
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<(div|p|tr|h[1-6])\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: s, warnings };
}
