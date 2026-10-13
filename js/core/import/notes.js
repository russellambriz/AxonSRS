/**
 * Structured notes → card drafts (deterministic, local).
 *
 * Recognised patterns:
 *   # Heading / ## Subheading     → context: tag (and optionally deck)
 *   - Term :: definition           (also ":", " — ", " – ", " - ", " = ", " → ")
 *   - Term                         with indented child bullets → back = children
 *   Term                           followed by ": definition" (definition list)
 *   Q: … / A: …                    labeled pairs inside notes
 *   Lines with {{c1::cloze}}       → cloze drafts
 * Every other non-empty line is returned in `unused` with its line
 * number so the user can convert it manually — nothing is discarded.
 */

import { slugTag } from './slug.js';

const SEPARATORS = [' :: ', '::', ' — ', ' – ', ' -> ', ' → ', ' = ', ': ', ' - '];

function splitTermDefinition(text) {
  for (const sep of SEPARATORS) {
    const idx = text.indexOf(sep);
    if (idx > 0) {
      const term = text.slice(0, idx).trim();
      const def = text.slice(idx + sep.length).trim();
      if (term && def && !(sep === ': ' && /^https?$/i.test(term))) return { term, def, sep: sep.trim() };
    }
  }
  return null;
}

export function notesToDrafts(src, options = {}) {
  const lines = String(src).split(/\r?\n/);
  const drafts = [];
  const unused = [];
  const headingStack = [];
  const used = new Set();
  const useHeadingsAsDecks = !!options.headingsAsDecks;
  let n = 0;
  const context = () => {
    const tags = headingStack.filter(Boolean).map((h) => slugTag(h.text));
    const deck = useHeadingsAsDecks && headingStack[0] ? headingStack[0].text : '';
    return { tags, deck };
  };
  const addDraft = (line, front, back, raw, extra = {}) => {
    const ctx = context();
    drafts.push({
      id: `d${++n}`,
      line,
      source: raw,
      front,
      back,
      tags: [...new Set([...(ctx.tags || []), ...(extra.tags || [])])],
      deck: ctx.deck || options.defaultDeck || '',
      hint: extra.hint || '',
      explanation: extra.explanation || '',
      taskType: options.defaultTaskType || 'recall',
      answerMode: options.defaultAnswerMode || '',
      warnings: extra.warnings || [],
      include: true,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const lineNo = i + 1;
    if (!text.trim()) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (heading) {
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = { text: heading[2], line: lineNo };
      used.add(lineNo);
      continue;
    }
    const qa = /^\s*(?:[-*+]\s+)?(q|question)\s*[:.]\s*(.+)$/i.exec(text);
    if (qa) {
      // find the answer on following lines
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const a = j < lines.length ? /^\s*(?:[-*+]\s+)?(a|answer)\s*[:.]\s*(.+)$/i.exec(lines[j]) : null;
      if (a) {
        addDraft(lineNo, qa[2].trim(), a[2].trim(), `${text}\n${lines[j]}`);
        used.add(lineNo);
        used.add(j + 1);
        i = j;
        continue;
      }
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
    if (bullet) {
      const indent = bullet[1].replace(/\t/g, '    ').length;
      const body = bullet[2].trim();
      if (/{{.+}}/.test(body)) {
        addDraft(lineNo, body, '', text);
        used.add(lineNo);
        continue;
      }
      const td = splitTermDefinition(body);
      if (td) {
        addDraft(lineNo, td.term, td.def, text);
        used.add(lineNo);
        // child bullets become part of the explanation
        let j = i + 1;
        const children = [];
        while (j < lines.length) {
          const child = /^(\s*)[-*+]\s+(.*)$/.exec(lines[j]);
          if (!child || child[1].replace(/\t/g, '    ').length <= indent) break;
          children.push(child[2].trim());
          used.add(j + 1);
          j++;
        }
        if (children.length) drafts[drafts.length - 1].explanation = children.map((c) => `- ${c}`).join('\n');
        i = j - 1;
        continue;
      }
      // Bullet with nested children and no separator: term → children
      let j = i + 1;
      const children = [];
      while (j < lines.length) {
        const child = /^(\s*)[-*+]\s+(.*)$/.exec(lines[j]);
        if (!child || child[1].replace(/\t/g, '    ').length <= indent) break;
        children.push({ text: child[2].trim(), line: j + 1 });
        j++;
      }
      if (children.length) {
        addDraft(lineNo, body, children.map((c) => c.text).join('; '), [text, ...children.map((c) => lines[c.line - 1])].join('\n'), {
          warnings: children.length > 1 ? ['Answer built from several bullet points — consider editing'] : [],
        });
        used.add(lineNo);
        children.forEach((c) => used.add(c.line));
        i = j - 1;
        continue;
      }
      unused.push({ line: lineNo, text, reason: 'Bullet without a term/definition separator' });
      used.add(lineNo);
      continue;
    }
    // Definition list: "Term" then ": definition"
    const next = lines[i + 1];
    if (next && /^\s*:\s+\S/.test(next)) {
      addDraft(lineNo, text.trim(), next.replace(/^\s*:\s+/, '').trim(), `${text}\n${next}`);
      used.add(lineNo);
      used.add(lineNo + 1);
      i++;
      continue;
    }
    if (/{{.+}}/.test(text)) {
      addDraft(lineNo, text.trim(), '', text);
      used.add(lineNo);
      continue;
    }
    const td = splitTermDefinition(text.trim());
    if (td && td.sep !== '-' && td.term.length <= 120) {
      addDraft(lineNo, td.term, td.def, text);
      used.add(lineNo);
      continue;
    }
    unused.push({ line: lineNo, text, reason: 'No recognisable card pattern' });
    used.add(lineNo);
  }
  return { drafts, unused, rows: [], errors: [], mapping: null, columns: null, directives: {} };
}
