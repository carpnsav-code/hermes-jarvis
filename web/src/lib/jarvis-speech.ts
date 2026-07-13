/**
 * Speech helpers for the Jarvis voice page: markdown → speakable text, and
 * incremental sentence extraction from a streaming delta buffer.
 */

/** Strip markdown/code so utterances read naturally. */
export function sanitizeForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|]/g, " ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split streamed text into speakable complete sentences plus an unfinished
 * remainder. Never splits inside an unclosed ``` fence (waits for the close
 * so sanitizeForSpeech can drop the whole block).
 */
export function extractSpeakable(buffer: string): {
  sentences: string[];
  rest: string;
} {
  const fences = (buffer.match(/```/g) || []).length;
  if (fences % 2 === 1) return { sentences: [], rest: buffer };

  // Last sentence boundary: terminator (optionally followed by a closing
  // quote/paren) that is followed by whitespace, or a line break.
  let cut = -1;
  const re = /[.!?…][)"'\]]?(?=\s)|\n/g;
  for (let m = re.exec(buffer); m; m = re.exec(buffer)) {
    cut = m.index + m[0].length;
  }
  if (cut < 0) return { sentences: [], rest: buffer };

  const speakable = buffer.slice(0, cut);
  const rest = buffer.slice(cut);
  const sentences = speakable
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => sanitizeForSpeech(s))
    .filter((s) => s.length > 0);
  return { sentences, rest };
}
