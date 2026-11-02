/** Render untrusted metadata as one inert Markdown line, never as document syntax. */
export function markdownText(value) {
  return String(value).replace(/[\r\n\u0085\u2028\u2029]/g, ' ')
    .replace(/[&<>|*_\[\]#\x60\\!(){}~+=:/]/g, character => '&#' + character.charCodeAt(0) + ';')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, character => '&#' + character.charCodeAt(0) + ';');
}

/** A dynamically longer fence preserves raw source bytes without enabling HTML or links. */
export function markdownFence(text, language = '') {
  const value = String(text);
  let length = 3;
  for (const match of value.matchAll(/\x60+/g)) length = Math.max(length, match[0].length + 1);
  const marker = '\x60'.repeat(length);
  return marker + language + '\n' + value + '\n' + marker;
}
