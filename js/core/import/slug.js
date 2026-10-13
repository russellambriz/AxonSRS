/** Turn a heading into a tag: "Acids & Bases" → "acids-bases". */
export function slugTag(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'notes';
}
