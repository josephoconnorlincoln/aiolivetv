import { decodeHtmlEntities } from './text.js';

/**
 * Normalises live channel names for matching by stripping provider prefixes,
 * quality markers and audio/language hints while preserving regional identifiers.
 */
export function normalizeChannelName(name: string): string {
  if (!name) return '';

  let normalized = decodeHtmlEntities(name).trim().toLowerCase();
  normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  normalized = normalized.replace(/²/g, '2');

  normalized = normalized.replace(
    /^[a-z0-9][a-z0-9\s]{1,}\s*(?:[-:|·])\s+/i,
    ''
  );

  const wordsToRemove = [
    /\btv\b/g,
    /\bhd[2]?\b/g,
    /\bfhd\b/g,
    /\buhd\b/g,
    /\b4k\b/g,
    /\bsd\b/g,
    /\blive\b/g,
    /\bao\s+vivo\b/g,
    /\bchannel\b/g,
    /\bcanal\b/g,
    /\brede\b/g,
    /\bleg(?:endado)?\b/g,
    /\bdub(?:bado|lado)?\b/g,
    /\borig(?:inal)?\b/g,
    /\bsub(?:titulado|s)?\b/g,
    /\b1080p?\b/g,
    /\b720p?\b/g,
    /\b2160p?\b/g,
    /\bfull\s+hd\b/g,
    /\bh26[456]\b/g,
    /\bx26[45]\b/g,
    /\bhevc\b/g,
    /\bavc\b/g,
    /\bav1\b/g,
    /\bvp9\b/g,
    /\bmpeg(?:2|4)?\b/g,
  ];

  for (const regex of wordsToRemove) {
    normalized = normalized.replace(regex, '');
  }

  normalized = normalized.replace(/&/g, ' ');
  normalized = normalized.replace(/[^a-z0-9\s]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

export function compactChannelName(name: string): string {
  return normalizeChannelName(name).replace(/\s+/g, '');
}

const DISPLAY_QUALITY =
  /(?:fhd|uhd|hd|sd|4k|1080p|720p|2160p)/i;

/**
 * Display name with quality markers removed. Keeps casing and identifiers
 * such as "A&E" or "FOX (103A)". Matching still uses `normalizeChannelName`.
 */
export function sanitizeChannelDisplayName(name: string): string {
  const original = decodeHtmlEntities(name).replace(/\s+/g, ' ').trim();
  if (!original) return '';

  let cleaned = original.replace(
    new RegExp(String.raw`\(\s*${DISPLAY_QUALITY.source}\s*\)`, 'gi'),
    ' '
  );
  cleaned = cleaned.replace(
    new RegExp(String.raw`\b${DISPLAY_QUALITY.source}\b`, 'gi'),
    ' '
  );
  cleaned = cleaned.replace(/\(\s*\)/g, ' ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned.replace(/\s+([,.;:!?])/g, '$1');
  cleaned = cleaned.replace(/^[-–—|:]+|[-–—|:]+$/g, '').trim();
  return cleaned || original;
}

const CHANNEL_GROUP_NOISE = /\b(?:fhd|hd|canais)\b/gi;

function titleCaseGroupWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLocaleLowerCase('pt-BR');
      return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
    })
    .join(' ');
}

/** Display label for IPTV/EPG channel groups: drop HD/FHD/CANAIS and title-case words. */
export function normalizeChannelGroup(group?: string): string | undefined {
  if (!group) return undefined;
  const cleaned = decodeHtmlEntities(group)
    .replace(CHANNEL_GROUP_NOISE, ' ')
    .replace(/[,/|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return titleCaseGroupWords(cleaned) || undefined;
}

function tokenizeChannelName(name: string) {
  return name.split(/\s+/).filter(Boolean);
}

/** True when shorter appears as consecutive words inside longer. */
export function containsAsWordSequence(longer: string, shorter: string) {
  const haystack = tokenizeChannelName(longer);
  const needle = tokenizeChannelName(shorter);
  if (!needle.length || !haystack.length) return false;
  if (needle.some((token) => token.length < 2)) return false;
  if (needle.length === 1) return haystack.includes(needle[0]!);
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a stream-like name refers to the same channel label.
 * Avoids substring traps such as matching "a e" (A&E) inside unrelated titles.
 */
export function containsNormalizedChannelName(
  haystackName: string,
  needleName: string
) {
  const haystack = normalizeChannelName(haystackName);
  const needle = normalizeChannelName(needleName);
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;

  const haystackCompact = compactChannelName(haystackName);
  const needleCompact = compactChannelName(needleName);
  if (haystackCompact === needleCompact) return true;

  const shorterNorm = haystack.length <= needle.length ? haystack : needle;
  const longerNorm = haystack.length > needle.length ? haystack : needle;
  const shorterCompact =
    haystackCompact.length <= needleCompact.length
      ? haystackCompact
      : needleCompact;
  const longerCompact =
    haystackCompact.length > needleCompact.length
      ? haystackCompact
      : needleCompact;

  if (shorterCompact.length < 4) return false;

  if (
    shorterCompact.length >= 5 &&
    longerCompact.length >= 5 &&
    longerCompact.includes(shorterCompact)
  ) {
    return true;
  }

  return containsAsWordSequence(longerNorm, shorterNorm);
}

/** Sørensen–Dice coefficient for fuzzy name comparison. */
export function getChannelNameSimilarity(left: string, right: string): number {
  const normLeft = left.replace(/\s+/g, '');
  const normRight = right.replace(/\s+/g, '');

  if (!normLeft || !normRight) return 0;
  if (normLeft === normRight) return 1;
  if (normLeft.length < 2 || normRight.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let index = 0; index < normLeft.length - 1; index++) {
    const bigram = normLeft.slice(index, index + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < normRight.length - 1; index++) {
    const bigram = normRight.slice(index, index + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersection++;
    }
  }

  return (2 * intersection) / (normLeft.length + normRight.length - 2);
}
