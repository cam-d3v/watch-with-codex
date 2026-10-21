// Transcript parsing and windowing, shared by the transcript API route and the page.

export type TranscriptCue = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptTrackInfo = {
  languageCode: string;
  name: string;
  kind: 'uploaded' | 'auto-generated';
};

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function cleanCueText(raw: string) {
  return decodeEntities(raw.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// YouTube timedtext "format 3": <p t="ms" d="ms">text</p>, where auto-generated
// tracks split words into <s> children and add empty <p a="1"> line markers.
export function parseTimedTextXml(xml: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const paragraph = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (const match of xml.matchAll(paragraph)) {
    const start = /\bt="(\d+)"/.exec(match[1]);
    const duration = /\bd="(\d+)"/.exec(match[1]);
    const text = cleanCueText(match[2]);
    if (!start || !text) continue;
    const startSeconds = Number(start[1]) / 1_000;
    cues.push({
      start: startSeconds,
      end: startSeconds + (duration ? Number(duration[1]) / 1_000 : 2),
      text,
    });
  }
  return cues;
}

function parseCueTime(value: string) {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// Parses .srt and .vtt subtitle files.
export function parseSubtitleFile(contents: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const block of contents.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;
    const [startText, endText] = lines[timingIndex].split('-->');
    const start = parseCueTime(startText);
    const end = parseCueTime(endText.trim().split(/\s+/)[0] ?? '');
    const text = cleanCueText(lines.slice(timingIndex + 1).join(' '));
    if (start === null || end === null || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function cuesBetween(cues: TranscriptCue[], from: number, to: number) {
  return cues.filter((cue) => cue.start >= from && cue.start < to);
}

function clockTimecode(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Merges cues into paragraphs of about `groupSeconds`, each prefixed with its
// start time; far fewer tokens than one timestamp per cue.
export function formatSpeech(cues: TranscriptCue[], groupSeconds = 20) {
  const paragraphs: string[] = [];
  let groupStart: number | null = null;
  let words: string[] = [];
  for (const cue of cues) {
    if (groupStart !== null && cue.start - groupStart >= groupSeconds) {
      paragraphs.push(`[${clockTimecode(groupStart)}] ${words.join(' ')}`);
      groupStart = null;
      words = [];
    }
    groupStart ??= cue.start;
    words.push(cue.text);
  }
  if (groupStart !== null) paragraphs.push(`[${clockTimecode(groupStart)}] ${words.join(' ')}`);
  return paragraphs.join('\n');
}

// Short excerpt around a moment, for attaching to notes.
export function excerptAround(cues: TranscriptCue[], time: number, before = 15, after = 5) {
  const text = cuesBetween(cues, time - before, time + after)
    .map((cue) => cue.text)
    .join(' ');
  return text.length > 400 ? `…${text.slice(-399)}` : text;
}

// Spoken phrases that usually mean something worth seeing is on screen.
export const VISUAL_REFERENCE =
  /\b(as you can see|you can see (here|that)|look(ing)? at (this|the)|this (slide|diagram|graph|chart|picture|figure|equation|formula|table|plot|example|code)|on the (screen|board|slide)|shown here|over here|right here|written (here|down))\b/i;
