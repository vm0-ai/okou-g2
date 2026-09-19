/**
 * Markdown to unformatted text.
 *
 * The G2 lens has one font, no styling and no alignment, so every Markdown
 * marker is noise that costs characters on a 576×288 display. This strips the
 * syntax and keeps the words, including the link text that carries the meaning
 * while the URL does not.
 *
 * It is deliberately not a parser. A full Markdown AST would be larger than the
 * rest of this app and still has to collapse to plain text at the end.
 */

/** Fenced blocks are replaced wholesale so their contents never reach a regex. */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/gu

const RULES: readonly (readonly [RegExp, string])[] = [
  // Images before links: the alt text of an image is rarely worth a lens line.
  [/!\[[^\]]*\]\([^)]*\)/gu, ''],
  // Keep link text, drop the URL.
  [/\[([^\]]*)\]\([^)]*\)/gu, '$1'],
  // Reference-style links and footnotes.
  [/\[([^\]]*)\]\[[^\]]*\]/gu, '$1'],
  [/<https?:\/\/[^>]+>/gu, ''],
  // Inline code.
  [/`([^`]*)`/gu, '$1'],
  // Headings, blockquotes and list markers at line start.
  [/^\s{0,3}#{1,6}\s+/gmu, ''],
  [/^\s{0,3}>\s?/gmu, ''],
  [/^\s{0,3}[-*+]\s+/gmu, '• '],
  [/^\s{0,3}(\d+)\.\s+/gmu, '$1. '],
  // Thematic breaks.
  [/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gmu, ''],
  // Emphasis. Bold first so `**x**` does not leave stray asterisks.
  [/\*\*([^*]+)\*\*/gu, '$1'],
  [/__([^_]+)__/gu, '$1'],
  [/\*([^*]+)\*/gu, '$1'],
  [/_([^_]+)_/gu, '$1'],
  [/~~([^~]+)~~/gu, '$1'],
  // Table pipes and separator rows.
  [/^\s*\|?[\s:|-]+\|[\s:|-]*$/gmu, ''],
  [/\s*\|\s*/gu, '  '],
  // Any raw HTML the model emitted.
  [/<[^>]+>/gu, ''],
]

export function markdownToPlainText(markdown: string): string {
  let text = markdown.replace(FENCED_CODE, ' [code] ')
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, replacement)
  }
  return text
    .replace(/\r\n?/gu, '\n')
    // Blank lines carry no meaning once styling is gone.
    .replace(/\n{2,}/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

/** Trim to a character budget without cutting mid-word when avoidable. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const clipped = text.slice(0, limit - 1)
  const lastSpace = clipped.lastIndexOf(' ')
  // Only honour the word boundary if it keeps most of the budget; otherwise a
  // long unbroken token would collapse the line to almost nothing.
  const cut = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped
  return `${cut}…`
}
