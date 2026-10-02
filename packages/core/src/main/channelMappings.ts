import type { ParsedFile, ParsedStream, UserData } from '../db/index.js';
import { parseDeclaredStreamInfo } from '../streams/declared.js';
import { CHANNEL_TYPE, LIVE_STREAM_TYPE, TV_TYPE } from '../utils/constants.js';
import type { ChannelStreamSource } from '../db/channelMapping.js';
import {
  compactChannelName,
  containsNormalizedChannelName,
  getChannelNameSimilarity,
  normalizeChannelGroup,
  normalizeChannelName,
} from '../utils/channelName.js';
import { decodeHtmlEntities } from '../utils/text.js';

export interface ChannelMatchCandidate {
  id: string;
  name: string;
  tvgId?: string;
  aliases?: string[];
  country?: string;
  language?: string;
  categories?: string[];
  logo?: string;
  hasSchedule?: boolean;
}

export function getCanonicalChannelId(id: string) {
  return id.split(':epg:', 1)[0];
}

export const MANUAL_STREAM_ADDON_ID = 'manual' as const;

export function isManualStreamSource(source: {
  addonId?: string;
  url?: string;
}) {
  return Boolean(source.url) || source.addonId === MANUAL_STREAM_ADDON_ID;
}

export function isLiveChannelType(type: string) {
  return type === CHANNEL_TYPE || type === TV_TYPE;
}

/** Catalog+stream builtins already key streams by the same channel id. */
export function bindsOwnCatalogStreams(source: {
  contributesChannels?: boolean;
  canStream?: boolean;
}): boolean {
  return Boolean(source.contributesChannels && source.canStream);
}

export function getChannelMapping(userData: UserData, channelId: string) {
  channelId = getCanonicalChannelId(channelId);
  return userData.channelMappings?.find((channel) => channel.id === channelId);
}

export function findChannelMappingForId(userData: UserData, channelId: string) {
  const canonicalId = getCanonicalChannelId(channelId);
  return userData.channelMappings?.find(
    (mapping) =>
      mapping.id === canonicalId ||
      mapping.streams?.some((stream) => stream.channelId === canonicalId)
  );
}

export function deduplicateLiveTvItems<
  T extends { id: string; name?: string | null },
>(userData: UserData, items: T[]): T[] {
  const kept: T[] = [];
  const seenMappingIds = new Set<string>();

  for (const item of items) {
    if (!isLiveChannelVisible(userData, item.id)) continue;

    const mapping = findChannelMappingForId(userData, item.id);
    if (mapping) {
      if (mapping.id !== getCanonicalChannelId(item.id)) continue;
      if (seenMappingIds.has(mapping.id)) continue;
      seenMappingIds.add(mapping.id);
      kept.push(item);
      continue;
    }

    kept.push(item);
  }

  return kept;
}

export function isLiveChannelVisible(userData: UserData, channelId: string) {
  const mapping = getChannelMapping(userData, channelId);
  if (!mapping) return true;
  if (mapping.hidden) return false;
  if (mapping.enabled === false) return false;
  return true;
}

export function getEffectiveChannelGroup(
  userData: UserData,
  channelId: string,
  sourceGroup?: string
): string | undefined {
  const override = normalizeChannelGroup(
    getChannelMapping(userData, channelId)?.group
  );
  return override || normalizeChannelGroup(sourceGroup);
}

export function applyLiveChannelGroupOverlay<
  T extends {
    id: string;
    name?: string | null;
    poster?: string | null;
    logo?: string | null;
    genres?: string[] | null;
  },
>(userData: UserData, items: T[]): T[] {
  return items.map((item) => {
    const mapping = getChannelMapping(userData, item.id);
    const group = getEffectiveChannelGroup(
      userData,
      item.id,
      Array.isArray(item.genres) ? item.genres[0] : undefined
    );
    const name = mapping?.name?.trim();
    const poster = mapping?.poster?.trim();
    return {
      ...item,
      ...(name ? { name } : {}),
      ...(poster ? { poster, logo: poster } : {}),
      ...(group ? { genres: [group] } : {}),
    };
  });
}

export function sortLiveCatalogItems<
  T extends { id: string; name?: string | null },
>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    (left.name ?? left.id).localeCompare(right.name ?? right.id, undefined, {
      sensitivity: 'base',
    })
  );
}

const normalisedIdCache = new Map<string, string>();

function normaliseId(value?: string) {
  if (!value) return '';
  const cached = normalisedIdCache.get(value);
  if (cached !== undefined) return cached;
  if (normalisedIdCache.size >= 50_000) normalisedIdCache.clear();
  const result = normaliseIdUncached(value);
  normalisedIdCache.set(value, result);
  return result;
}

function normaliseIdUncached(value: string) {
  return decodeHtmlEntities(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function equalId(left?: string, right?: string) {
  const normalizedLeft = normaliseId(left);
  return Boolean(normalizedLeft && normalizedLeft === normaliseId(right));
}

function equalOptional(a?: string, b?: string) {
  const left = normaliseId(a);
  return Boolean(left && left === normaliseId(b));
}

function overlaps(left: string[] = [], right: string[] = []) {
  const values = new Set(left.map(normalizeChannelName).filter(Boolean));
  return right.some((value) => values.has(normalizeChannelName(value)));
}

function collectNameEntries(candidate: ChannelMatchCandidate) {
  const entries: Array<{ value: string; alias: boolean }> = [];
  if (candidate.name) entries.push({ value: candidate.name, alias: false });
  for (const alias of candidate.aliases ?? []) {
    entries.push({ value: alias, alias: true });
  }
  return entries;
}

function scoreNamePair(
  left: { value: string; alias: boolean },
  right: { value: string; alias: boolean }
) {
  const leftNorm = normalizeChannelName(left.value);
  const rightNorm = normalizeChannelName(right.value);
  if (!leftNorm || !rightNorm) return 0;

  const aliasMatch = left.alias || right.alias;
  const leftCompact = compactChannelName(left.value);
  const rightCompact = compactChannelName(right.value);
  const minCompact = Math.min(leftCompact.length, rightCompact.length);

  if (
    leftNorm === rightNorm ||
    (leftCompact.length >= 2 && leftCompact === rightCompact)
  ) {
    return aliasMatch ? 0.88 : 0.9;
  }

  if (minCompact <= 3) return 0;

  let score = Math.max(
    getChannelNameSimilarity(leftNorm, rightNorm),
    getChannelNameSimilarity(leftCompact, rightCompact)
  );

  if (
    containsNormalizedChannelName(left.value, right.value) ||
    containsNormalizedChannelName(right.value, left.value)
  ) {
    score = Math.max(score, 0.85);
  }

  if (!score) return 0;
  if (aliasMatch) return Math.min(score, 0.88);
  return score;
}

function matchNormalizedNames(
  left: ChannelMatchCandidate,
  right: ChannelMatchCandidate
) {
  let best = 0;
  for (const leftEntry of collectNameEntries(left)) {
    for (const rightEntry of collectNameEntries(right)) {
      best = Math.max(best, scoreNamePair(leftEntry, rightEntry));
    }
  }
  return best;
}

export function getChannelMatchConfidence(
  left: ChannelMatchCandidate,
  right: ChannelMatchCandidate
) {
  if (
    equalId(left.tvgId, right.tvgId) ||
    equalId(left.tvgId, right.id) ||
    equalId(left.id, right.tvgId)
  ) {
    return 1;
  }

  let score = matchNormalizedNames(left, right);
  if (!score) return 0;

  if (equalOptional(left.country, right.country)) score += 0.03;
  if (equalOptional(left.language, right.language)) score += 0.03;
  if (overlaps(left.categories, right.categories)) score += 0.02;
  if (equalOptional(left.logo, right.logo)) score += 0.02;
  return Math.min(score, 0.99);
}

export function findPossibleDuplicateChannels(
  channels: Array<{ id: string; name: string; enabled?: boolean }>
): Array<{ name: string; channelIds: string[] }> {
  const groups = new Map<string, { name: string; channelIds: string[] }>();
  for (const channel of channels) {
    if (channel.enabled === false) continue;
    const key = compactChannelName(channel.name);
    if (key.length < 2) continue;
    const group = groups.get(key);
    if (group) {
      group.channelIds.push(channel.id);
    } else {
      groups.set(key, { name: channel.name, channelIds: [channel.id] });
    }
  }
  return [...groups.values()].filter((group) => group.channelIds.length > 1);
}

export const CHANNEL_AUTO_MERGE_CONFIDENCE = 0.9;
export const CHANNEL_LINK_STREAM_CONFIDENCE = 0.5;

export const isHighConfidenceChannelMatch = (confidence: number) =>
  confidence >= CHANNEL_AUTO_MERGE_CONFIDENCE;

export const isChannelMappingSuggestion = (confidence: number) =>
  confidence > 0 && confidence < CHANNEL_AUTO_MERGE_CONFIDENCE;

export function isChannelAddonEnabled(
  userData: UserData,
  channelId: string,
  addonId: string,
  streamChannelId?: string
) {
  return (
    getChannelMapping(userData, channelId)?.streams?.find((stream) =>
      streamChannelId
        ? stream.channelId === streamChannelId
        : stream.addonId === addonId
    )?.enabled !== false
  );
}

function compactHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const compact = Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => name.trim() && value.trim()
    )
  );
  return Object.keys(compact).length ? compact : undefined;
}

function parsedFileForManualSource(
  source: ChannelStreamSource
): ParsedFile | undefined {
  const declared = parseDeclaredStreamInfo({ name: source.name });
  const languages = source.languages?.length
    ? source.languages
    : (declared?.parsedFile.languages ?? []);
  const audioChannels = source.audioChannels?.length
    ? source.audioChannels
    : (declared?.parsedFile.audioChannels ?? []);
  const visualTags = source.visualTags?.length
    ? source.visualTags
    : (declared?.parsedFile.visualTags ?? []);
  const parsedFile: ParsedFile = {
    audioChannels,
    visualTags,
    audioTags: declared?.parsedFile.audioTags ?? [],
    languages,
    resolution: source.resolution ?? declared?.parsedFile.resolution,
    encode: source.encode ?? declared?.parsedFile.encode,
    quality: source.quality ?? declared?.parsedFile.quality,
  };
  if (
    !parsedFile.resolution &&
    !parsedFile.encode &&
    !parsedFile.quality &&
    !parsedFile.languages.length &&
    !parsedFile.audioChannels.length &&
    !parsedFile.visualTags.length
  ) {
    return undefined;
  }
  return parsedFile;
}

export function buildManualParsedStreams(
  userData: UserData,
  channelId: string
): ParsedStream[] {
  const mapping = getChannelMapping(userData, channelId);
  if (!mapping?.streams) return [];
  return mapping.streams
    .filter(
      (source) =>
        source.url &&
        source.addonId === MANUAL_STREAM_ADDON_ID &&
        source.enabled !== false
    )
    .map((source, index) => {
      const requestHeaders = compactHeaders(source.headers);
      const name = source.name ?? 'Manual HLS';
      return {
        id: `manual-${channelId}-${source.channelId ?? index}`,
        type: LIVE_STREAM_TYPE,
        url: source.url!,
        filename: name,
        originalName: name,
        message: name,
        parsedFile: parsedFileForManualSource(source),
        requestHeaders,
        notWebReady: requestHeaders ? true : undefined,
        addon: {
          instanceId: MANUAL_STREAM_ADDON_ID,
          name: 'Manual HLS',
          manifestUrl: 'https://aiolivetv.local/manual',
          enabled: true,
          timeout: 10_000,
          preset: { id: '', type: 'manual', options: {} },
        },
      };
    });
}

export function orderLiveStreamsByMapping(
  fetched: ParsedStream[],
  manual: ParsedStream[],
  sources: NonNullable<ReturnType<typeof getChannelMapping>>['streams']
): ParsedStream[] {
  if (!sources?.length) return [...manual, ...fetched];
  const fetchedByAddon = new Map<string, ParsedStream[]>();
  for (const stream of fetched) {
    const addonId = stream.addon.instanceId ?? stream.addon.preset.id;
    const list = fetchedByAddon.get(addonId) ?? [];
    list.push(stream);
    fetchedByAddon.set(addonId, list);
  }
  const manualByUrl = new Map(
    manual
      .filter((stream) => stream.url)
      .map((stream) => [stream.url!, stream] as const)
  );
  const ordered: ParsedStream[] = [];
  for (const source of sources) {
    if (isManualStreamSource(source) && source.url) {
      const stream = manualByUrl.get(source.url);
      if (stream) ordered.push(stream);
      continue;
    }
    if (!source.addonId) continue;
    ordered.push(...(fetchedByAddon.get(source.addonId) ?? []));
  }
  return ordered.length ? ordered : [...manual, ...fetched];
}

export { normalizeChannelName } from '../utils/channelName.js';
