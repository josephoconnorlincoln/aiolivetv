import type {
  ChannelInfo,
  ChannelsResponse,
  RemovedChannelInfo,
} from '@/lib/api';

export function isChannelSuggestion(confidence: number) {
  return confidence > 0 && confidence < 0.9;
}

export function normalizeChannelGroup(group?: string): string | undefined {
  if (!group) return undefined;
  const cleaned = group
    .replace(/\b(?:fhd|hd|canais)\b/gi, ' ')
    .replace(/[,/|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLocaleLowerCase('pt-BR');
      return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
    })
    .join(' ');
}

export function countSuggestions(channels: ChannelInfo[]) {
  return channels.reduce(
    (total, channel) =>
      total +
      channel.mappings.filter((mapping) =>
        isChannelSuggestion(mapping.confidence)
      ).length,
    0
  );
}

export function getMappingStats(channel: ChannelInfo) {
  const total = channel.mappings.length;
  const pending = channel.mappings.filter((mapping) =>
    isChannelSuggestion(mapping.confidence)
  ).length;
  const accepted = total - pending;
  return { accepted, pending, total };
}

export function getChannelSourceLabel(channel: ChannelInfo) {
  if (channel.sourceName?.trim()) return channel.sourceName.trim();
  const canonical = channel.mappings.find(
    (mapping) => mapping.addonId === channel.canonicalAddonId
  );
  return canonical?.addonName ?? channel.mappings[0]?.addonName ?? 'Other';
}

export type ChannelSortMode = 'alphabetical' | 'source';

export const MANUAL_STREAM_ADDON_ID = 'manual';

const STREAM_SOURCE_KEY_SEP = '\0';

export function streamSourceKey(addonId: string, channelId: string) {
  return `${addonId}${STREAM_SOURCE_KEY_SEP}${channelId}`;
}

export function parseStreamSourceKey(key: string) {
  const sep = key.indexOf(STREAM_SOURCE_KEY_SEP);
  if (sep <= 0 || sep === key.length - 1) return undefined;
  return {
    addonId: key.slice(0, sep),
    streamChannelId: key.slice(sep + 1),
  };
}

export type ManualHlsDetails = {
  url: string;
  name: string;
  headers?: Record<string, string>;
  resolution?: string;
  encode?: string;
  quality?: string;
  languages?: string[];
  audioChannels?: string[];
  visualTags?: string[];
};

export function buildManualStreamChannelId(url: string) {
  return `manual:${encodeURIComponent(url)}`;
}

export function persistableManualStreamFields(details: ManualHlsDetails) {
  return {
    url: details.url,
    name: details.name,
    ...(details.headers && Object.keys(details.headers).length
      ? { headers: details.headers }
      : {}),
    ...(details.resolution ? { resolution: details.resolution } : {}),
    ...(details.encode ? { encode: details.encode } : {}),
    ...(details.quality ? { quality: details.quality } : {}),
    ...(details.languages?.length ? { languages: details.languages } : {}),
    ...(details.audioChannels?.length
      ? { audioChannels: details.audioChannels }
      : {}),
    ...(details.visualTags?.length ? { visualTags: details.visualTags } : {}),
  };
}

export function declaredFromManualDetails(
  details: ManualHlsDetails
): ChannelInfo['mappings'][number]['declared'] {
  const parsedFile = {
    resolution: details.resolution,
    quality: details.quality,
    encode: details.encode,
    audioChannels: details.audioChannels ?? [],
    audioTags: [] as string[],
    visualTags: details.visualTags ?? [],
    languages: details.languages ?? [],
  };
  if (
    !parsedFile.resolution &&
    !parsedFile.encode &&
    !parsedFile.quality &&
    !parsedFile.languages.length &&
    !parsedFile.audioChannels.length &&
    !parsedFile.visualTags.length
  ) {
    return null;
  }
  return {
    parsedFile,
    source: 'name',
    label: details.name,
  };
}

export function isManualStreamMapping(mapping: {
  addonId: string;
  url?: string | null;
}) {
  return Boolean(mapping.url) || mapping.addonId === MANUAL_STREAM_ADDON_ID;
}

export function isValidStreamUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sortChannels(
  channels: ChannelInfo[],
  mode: ChannelSortMode
): ChannelInfo[] {
  if (mode === 'alphabetical') {
    return [...channels].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }
  return [...channels].sort((a, b) => {
    const sourceCompare = getChannelSourceLabel(a).localeCompare(
      getChannelSourceLabel(b),
      undefined,
      { sensitivity: 'base' }
    );
    if (sourceCompare !== 0) return sourceCompare;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function groupChannelsBySource(channels: ChannelInfo[]) {
  const groups = new Map<string, ChannelInfo[]>();
  for (const channel of channels) {
    const label = getChannelSourceLabel(channel);
    const list = groups.get(label) ?? [];
    list.push(channel);
    groups.set(label, list);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

export function getRemovedChannels(
  mappings:
    | Array<{
        id: string;
        hidden?: boolean;
        name?: string;
        poster?: string;
      }>
    | undefined,
  catalogRemoved: RemovedChannelInfo[] = []
) {
  const fromCatalog = new Map(
    catalogRemoved.map((channel) => [channel.id, channel])
  );
  return (mappings ?? [])
    .filter((mapping) => mapping.hidden)
    .map((mapping) => {
      const snapshot = fromCatalog.get(mapping.id);
      return {
        id: mapping.id,
        name: mapping.name?.trim() || snapshot?.name?.trim() || mapping.id,
        poster: mapping.poster || snapshot?.poster || undefined,
        sourceName: snapshot?.sourceName,
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
}

export function emptyChannelsResponse(): ChannelsResponse {
  return {
    channels: [],
    sources: [],
    unmatchedStreams: [],
    unavailableStreams: [],
    duplicates: [],
    removedChannels: [],
  };
}

export function asChannelsResponse(
  data: ChannelsResponse | ChannelInfo[] | undefined
): ChannelsResponse {
  if (!data) return emptyChannelsResponse();
  if (Array.isArray(data)) {
    return { ...emptyChannelsResponse(), channels: data };
  }
  return {
    channels: data.channels ?? [],
    sources: data.sources ?? [],
    unmatchedStreams: data.unmatchedStreams ?? [],
    unavailableStreams: data.unavailableStreams ?? [],
    duplicates: data.duplicates ?? [],
    removedChannels: data.removedChannels ?? [],
    scan: data.scan,
    streamCatalog: data.streamCatalog ?? [],
  };
}

export function channelHasPlayableStream(channel: ChannelInfo) {
  return channel.mappings.some(
    (mapping) =>
      mapping.canStream &&
      mapping.enabled &&
      !isChannelSuggestion(mapping.confidence)
  );
}

export function channelHasSchedule(channel: ChannelInfo) {
  return (
    channel.epgProvider === true ||
    channel.mappings.some((mapping) => mapping.epgProvider)
  );
}

export type ChannelReviewFilter =
  | 'all'
  | 'no-stream'
  | 'suggestions'
  | 'duplicates'
  | 'no-schedule'
  | 'unavailable';

export function compactChannelLabel(name: string) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(hd|fhd|uhd|4k|sd|tv|channel|canal|rede|live)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function findDuplicateGroups(channels: ChannelInfo[]) {
  const groups = new Map<string, { name: string; channelIds: string[] }>();
  for (const channel of channels) {
    if (!channel.enabled) continue;
    const key = compactChannelLabel(channel.name);
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

export function filterChannelsByReview(
  channels: ChannelInfo[],
  filter: ChannelReviewFilter,
  duplicateIds: Set<string>
) {
  switch (filter) {
    case 'no-stream':
      return channels.filter(
        (channel) => channel.enabled && !channelHasPlayableStream(channel)
      );
    case 'suggestions':
      return channels.filter((channel) =>
        channel.mappings.some((mapping) =>
          isChannelSuggestion(mapping.confidence)
        )
      );
    case 'duplicates':
      return channels.filter((channel) => duplicateIds.has(channel.id));
    case 'no-schedule':
      return channels.filter(
        (channel) => channel.enabled && !channelHasSchedule(channel)
      );
    case 'unavailable':
      return channels;
    default:
      return channels;
  }
}
