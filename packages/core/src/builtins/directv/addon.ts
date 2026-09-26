import { z } from 'zod';
import type { Manifest, Meta, MetaPreview } from '../../db/index.js';
import { config as appConfig } from '../../config/index.js';
import {
  normalizeChannelName,
  sanitizeChannelDisplayName,
} from '../../utils/channelName.js';
import { TV_TYPE } from '../../utils/constants.js';
import { Cache, decodeHtmlEntities, makeRequest } from '../../utils/index.js';
import {
  applyEpgTimeShift,
  bareChannelPreview,
  buildEpgCatalogResponse,
  EPG_GUIDE_CATALOG_EXTRAS,
  guideChannelMeta,
  mapWithEpgConcurrency,
  programToVideo,
  resolveGuideDate,
  shiftedProgramOverlapsUtcDay,
  type CatalogHandlerResponse,
} from '../live-tv/epg.js';
import {
  CHANNEL_ID_PREFIX,
  decodeChannelId,
  encodeChannelId,
  LIVE_TV_CATALOG_PAGE_SIZE,
} from '../live-tv/shared.js';

const API_ORIGIN = 'https://api.cld.dtvce.com';
const TOKEN_URL = `${API_ORIGIN}/authn-tokengo/v3/v2/tokens?client_id=DTVE_DFW_WEB_Chrome_G`;
const CHANNEL_CACHE_TTL = 60 * 60;
const PROGRAMME_CACHE_TTL = 15 * 60;
const DEFAULT_TOKEN_TTL = 50 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

const channelCache = Cache.getInstance<string, DirectvChannel[]>(
  'directv-channels'
);
const programmeCache = Cache.getInstance<string, DirectvProgramme[]>(
  'directv-programmes'
);
const tokenCache = Cache.getInstance<string, string>('directv-token');

export const DirectvConfigSchema = z.object({
  timeout: z.number().int().positive(),
  timeShiftMinutes: z.number().int().default(0),
});

export type DirectvConfig = z.infer<typeof DirectvConfigSchema>;

interface DirectvChannel {
  id: string;
  name: string;
  logo?: string;
  tvgId: string;
  hd: boolean;
  alternate: boolean;
}

interface DirectvProgramme {
  channelId: string;
  title: string;
  subtitle?: string;
  description?: string;
  thumbnail?: string;
  startTime: string;
  endTime: string;
  airedYear?: string;
  categories?: string[];
  ratings?: Array<{ value: string; system: string }>;
}

interface DirectvScheduleItem {
  programID?: unknown;
  title?: unknown;
  episodeTitle?: unknown;
  description?: unknown;
  parentalRating?: unknown;
  rating?: unknown;
  originalAirDate?: unknown;
  releaseYear?: unknown;
  genres?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  seriesId?: unknown;
  seriesEditId?: unknown;
  editId?: unknown;
  resourceId?: unknown;
  canonicalId?: unknown;
  images?: Array<{ defaultImageUrl?: unknown; imageUrl?: unknown; url?: unknown }>;
  imageList?: Array<{ defaultImageUrl?: unknown; imageUrl?: unknown; url?: unknown }>;
  consumables?: Array<{
    startTime?: unknown;
    endTime?: unknown;
    parentalRating?: unknown;
  }>;
}

const DIRECTV_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Origin: 'https://www.directv.com',
  Referer: 'https://www.directv.com/',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
} as const;

/**
 * DIRECTV's guide API is geo-blocked. Use the dashboard HTTP proxy, including
 * the host or `*` rule, and still send traffic through it when a rule would
 * otherwise turn proxying off.
 */
function directvProxy(): string | undefined {
  const proxies = appConfig.http.addonProxy ?? [];
  if (proxies.length === 0) return undefined;

  const hostname = 'api.cld.dtvce.com';
  let index = 0;
  for (const [ruleHostname, ruleValue] of Object.entries(
    appConfig.http.addonProxyConfig ?? {}
  )) {
    const matches =
      ruleHostname === '*' ||
      ruleHostname === hostname ||
      (ruleHostname.startsWith('*') &&
        hostname.endsWith(ruleHostname.slice(1)));
    if (!matches || ruleValue === false) continue;
    index =
      typeof ruleValue === 'number' && Number.isInteger(ruleValue)
        ? ruleValue
        : 0;
  }

  return proxies[index] ?? proxies[0];
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  const decoded = decodeHtmlEntities(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return decoded || undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : undefined;
  if (numeric === undefined || !Number.isInteger(numeric) || numeric <= 0) {
    return undefined;
  }
  return numeric;
}

function categories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [
    ...new Set(
      value
        .map((item) => {
          if (typeof item === 'string') return text(item);
          if (item && typeof item === 'object' && 'name' in item) {
            return text((item as { name?: unknown }).name);
          }
          return undefined;
        })
        .filter((item): item is string => Boolean(item))
    ),
  ];
  return names.length ? names : undefined;
}

function airedYear(item: DirectvScheduleItem): string | undefined {
  const release = String(item.releaseYear ?? '');
  if (/^\d{4}$/.test(release)) return release;
  const original = epochMs(item.originalAirDate);
  if (original !== undefined) return new Date(original).getUTCFullYear().toString();
  const match = String(item.originalAirDate ?? '').match(/\b(\d{4})\b/);
  return match?.[1];
}

function programmeSubtitle(item: DirectvScheduleItem): string | undefined {
  const episodeTitle = text(item.episodeTitle);
  const season = positiveInt(item.seasonNumber);
  const episode = positiveInt(item.episodeNumber);
  const code =
    season && episode
      ? `S${season}E${episode}`
      : season
        ? `S${season}`
        : episode
          ? `E${episode}`
          : undefined;
  if (code && episodeTitle) return `${code} · ${episodeTitle}`;
  return code || episodeTitle;
}

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function directvFetch(
  url: string,
  timeout: number,
  init?: { method?: string; token?: string }
) {
  const proxy = directvProxy();
  const response = await makeRequest(url, {
    timeout: Math.max(timeout, REQUEST_TIMEOUT_MS),
    method: init?.method,
    headers: {
      ...DIRECTV_HEADERS,
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    ...(proxy ? { forceProxy: proxy } : {}),
  });
  if (response.status === 403 || response.status === 451) {
    throw new Error(
      'DIRECTV blocked the request. Set an HTTP proxy in Dashboard settings so guide requests leave from an allowed region.'
    );
  }
  return response;
}

async function accessToken(timeout: number): Promise<string> {
  const cached = await tokenCache.get('access-token');
  if (cached) return cached;

  const response = await directvFetch(TOKEN_URL, timeout, { method: 'POST' });
  if (!response.ok) {
    throw new Error(
      `DIRECTV token request failed (${response.status}). The guide API is geo-blocked and uses the HTTP proxy from Dashboard settings.`
    );
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  const token = typeof body.access_token === 'string' ? body.access_token : '';
  if (!token) {
    throw new Error('DIRECTV token response did not include access_token');
  }
  const expiresIn =
    typeof body.expires_in === 'number' && body.expires_in > 120
      ? body.expires_in - 60
      : DEFAULT_TOKEN_TTL;
  await tokenCache.set('access-token', token, expiresIn);
  return token;
}

const ALTERNATE_FEED = /\(\s*alternate\s*\d*\s*\)/i;

function isAlternateFeed(name: string): boolean {
  return ALTERNATE_FEED.test(name);
}

function isHdChannel(item: Record<string, unknown>, name: string): boolean {
  if (/\bhd\b/i.test(name)) return true;
  const callSign = text(item.callSign) ?? '';
  if (/hd$/i.test(callSign)) return true;
  const format = `${text(item.format) ?? ''} ${text(item.videoFormat) ?? ''}`;
  return /\bhd\b/i.test(format);
}

/** Same station in SD, HD and "(Alternate)" feeds collapses to one guide entry. */
function channelDedupeKey(name: string): string {
  return normalizeChannelName(name.replace(ALTERNATE_FEED, ' '));
}

function channelRank(channel: DirectvChannel): number {
  if (!channel.alternate && channel.hd) return 4;
  if (!channel.alternate) return 3;
  if (channel.hd) return 2;
  return 1;
}

function dedupeChannels(channels: DirectvChannel[]): DirectvChannel[] {
  const chosen = new Map<string, DirectvChannel>();
  const plainNames = new Map<string, string>();
  const order: string[] = [];
  for (const channel of channels) {
    const key = channelDedupeKey(channel.name) || channel.id;
    if (!channel.hd && !channel.alternate) {
      plainNames.set(key, channel.name);
    }
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, channel);
      order.push(key);
      continue;
    }
    if (channelRank(channel) > channelRank(existing)) {
      chosen.set(key, channel);
    }
  }
  return order.map((key) => {
    const channel = chosen.get(key)!;
    return {
      ...channel,
      name: sanitizeChannelDisplayName(
        plainNames.get(key) ?? channel.name
      ),
    };
  });
}

const CHANNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO_UPSTREAM =
  'https://dfwfis.prod.dtvcdn.com/catalog/image/imageserver/v1/service/channel';

function imageUrlFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const image = value as {
    imageUrl?: unknown;
    defaultImageUrl?: unknown;
    url?: unknown;
  };
  return (
    httpUrl(image.imageUrl) ||
    httpUrl(image.defaultImageUrl) ||
    httpUrl(image.url)
  );
}

function listedImage(item: Record<string, unknown>): string | undefined {
  const direct =
    httpUrl(item.imageUrl) ||
    httpUrl(item.defaultImageUrl) ||
    imageUrlFrom(item);
  if (direct) return direct;
  for (const key of ['imageList', 'images'] as const) {
    const list = item[key];
    if (!Array.isArray(list)) continue;
    for (const image of list) {
      const url = imageUrlFrom(image);
      if (url) return url;
    }
  }
  return undefined;
}

const PROGRAMME_IMAGE_ROOT =
  'https://dfwfis.prod.dtvcdn.com/catalog/image/imageserver/v1/service';

function cdnImage(id: string): string | undefined {
  if (!CHANNEL_ID_PATTERN.test(id)) return undefined;
  return `${LOGO_UPSTREAM}/${id}/chlogo-bwdb-player/120/91`;
}

/**
 * Episode stills (`editId` + `keyframe-ci`) exist only for some airings.
 * The series image (`seriesEditId` + `iconic-ci`) is the one the guide can
 * show when that still is missing. `seriesId` is not an image-server id.
 */
function programmeCdnImage(
  kind: 'episode' | 'series',
  id: string
): string | undefined {
  if (!CHANNEL_ID_PATTERN.test(id)) return undefined;
  if (kind === 'episode') {
    return `${PROGRAMME_IMAGE_ROOT}/episode/${id}/keyframe-ci/640/360`;
  }
  return `${PROGRAMME_IMAGE_ROOT}/series/${id}/iconic-ci/640/360`;
}

function mapChannel(item: Record<string, unknown>): DirectvChannel | undefined {
  const id = text(item.resourceId);
  const name = text(item.channelName);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    logo: listedImage(item) || cdnImage(id),
    tvgId: text(item.callSign) || name,
    hd: isHdChannel(item, name),
    alternate: isAlternateFeed(name),
  };
}

async function loadChannels(config: DirectvConfig): Promise<DirectvChannel[]> {
  const cached = await channelCache.get('channels-v6');
  if (cached) return cached;

  const token = await accessToken(config.timeout);
  const url = new URL(
    '/discovery/metadata/channel/v5/service/allchannels',
    API_ORIGIN
  );
  url.searchParams.set('sort', 'OrdCh=ASC');
  const response = await directvFetch(url.href, config.timeout, { token });
  if (!response.ok) {
    throw new Error(`DIRECTV channel list failed (${response.status})`);
  }
  const body = (await response.json()) as {
    channelInfoList?: Array<Record<string, unknown>>;
  };
  const channels = dedupeChannels(
    (body.channelInfoList ?? [])
      .map(mapChannel)
      .filter((channel): channel is DirectvChannel => Boolean(channel))
  );
  if (channels.length) {
    await channelCache.set('channels-v6', channels, CHANNEL_CACHE_TTL);
  }
  return channels;
}

function ratingValue(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value);
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { rating?: unknown; value?: unknown; code?: unknown };
  return text(record.rating) || text(record.value) || text(record.code);
}

function programmeRating(
  item: DirectvScheduleItem
): { value: string; system: string } | undefined {
  const raw =
    ratingValue(item.parentalRating) ||
    ratingValue(item.consumables?.[0]?.parentalRating) ||
    ratingValue(item.rating);
  if (!raw) return undefined;
  const compact = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const tvLabels: Record<string, string> = {
    TVY: 'TV-Y',
    TVY7: 'TV-Y7',
    TVG: 'TV-G',
    TVPG: 'TV-PG',
    TV14: 'TV-14',
    TVMA: 'TV-MA',
  };
  const tvLabel = tvLabels[compact];
  if (tvLabel) return { value: tvLabel, system: 'tv-pg' };
  return { value: raw, system: 'mpa' };
}

function programmeThumbnail(item: DirectvScheduleItem): string | undefined {
  const external = listedImage(item as unknown as Record<string, unknown>);
  if (external) return external;
  const seriesEditId = text(item.seriesEditId);
  if (seriesEditId) return programmeCdnImage('series', seriesEditId);
  const editId = text(item.editId);
  if (editId) return programmeCdnImage('episode', editId);
  return undefined;
}

function mapProgramme(
  item: DirectvScheduleItem,
  channelId: string
): DirectvProgramme | undefined {
  if (String(item.programID ?? '') === '-1') return undefined;
  const title = text(item.title);
  const window = item.consumables?.[0];
  const startMs = epochMs(window?.startTime);
  const endMs = epochMs(window?.endTime);
  if (!title || startMs === undefined || endMs === undefined || endMs <= startMs) {
    return undefined;
  }
  const rating = programmeRating(item);
  const thumbnail = programmeThumbnail(item);
  return {
    channelId,
    title,
    subtitle: programmeSubtitle(item),
    description: text(item.description),
    thumbnail,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    airedYear: airedYear(item),
    categories: categories(item.genres),
    ratings: rating ? [rating] : undefined,
  };
}

async function loadProgrammesForChannelDay(
  config: DirectvConfig,
  channelId: string,
  date: string
): Promise<DirectvProgramme[]> {
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return [];
  const cacheKey = `${date}:${channelId.toLowerCase()}:v5`;
  const cached = await programmeCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL(
    '/discovery/edge/schedule/v1/service/schedule',
    API_ORIGIN
  );
  url.searchParams.set('startTime', String(startMs));
  url.searchParams.set('endTime', String(startMs + DAY_MS));
  url.searchParams.set('channelIds', channelId);
  url.searchParams.set('include4K', 'false');
  url.searchParams.set('is4Kcompatible', 'false');
  url.searchParams.set('includeTVOD', 'true');

  let body: { schedules?: Array<{ channelId?: unknown; contents?: unknown }> };
  try {
    const token = await accessToken(config.timeout);
    const response = await directvFetch(url.href, config.timeout, { token });
    if (!response.ok) return [];
    body = (await response.json()) as typeof body;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('DIRECTV blocked the request')
    ) {
      throw error;
    }
    return [];
  }

  const schedule = (body.schedules ?? []).find((item) =>
    sameId(String(item.channelId ?? ''), channelId)
  );
  const contents = Array.isArray(schedule?.contents) ? schedule.contents : [];
  const programmes = contents
    .map((item) =>
      item && typeof item === 'object'
        ? mapProgramme(item as DirectvScheduleItem, channelId)
        : undefined
    )
    .filter((item): item is DirectvProgramme => Boolean(item));

  await programmeCache.set(cacheKey, programmes, PROGRAMME_CACHE_TTL);
  return programmes;
}

async function loadProgrammesForUtcDay(
  config: DirectvConfig,
  channelIds: string[],
  date: string
): Promise<DirectvProgramme[]> {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (!ids.length) return [];
  const batches = await mapWithEpgConcurrency(
    ids,
    (id) => loadProgrammesForChannelDay(config, id, date),
    [] as DirectvProgramme[]
  );
  return batches.flat();
}

function toVideo(
  encodedId: string,
  item: DirectvProgramme,
  timeShiftMinutes: number
) {
  const { startTime, endTime } = applyEpgTimeShift(
    item.startTime,
    item.endTime,
    timeShiftMinutes
  );
  return programToVideo({
    channelEncodedId: encodedId,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    thumbnail: item.thumbnail,
    startTime,
    endTime,
    airedYear: item.airedYear,
    categories: item.categories,
    ratings: item.ratings,
  });
}

export class DirectvAddon {
  private readonly config: DirectvConfig;

  constructor(config: z.input<typeof DirectvConfigSchema>) {
    this.config = DirectvConfigSchema.parse(config);
  }

  getManifest(): Manifest {
    return {
      id: 'org.aiolivetv.directv',
      name: 'DIRECTV',
      version: '1.0.0',
      description:
        'Live channels and EPG from DIRECTV. Guide requests use the HTTP proxy from Dashboard settings.',
      types: [TV_TYPE],
      resources: [
        {
          name: 'catalog',
          types: [TV_TYPE],
          idPrefixes: [CHANNEL_ID_PREFIX],
        },
        { name: 'meta', types: [TV_TYPE], idPrefixes: [CHANNEL_ID_PREFIX] },
      ],
      catalogs: [
        {
          id: 'directv-channels',
          type: TV_TYPE,
          name: 'DIRECTV Channels',
          extra: [...EPG_GUIDE_CATALOG_EXTRAS],
        },
      ],
      behaviorHints: { epgProvider: true },
    };
  }

  async getCatalog(skip = 0): Promise<MetaPreview[]> {
    return (await loadChannels(this.config))
      .slice(skip, skip + LIVE_TV_CATALOG_PAGE_SIZE)
      .map((channel) =>
        bareChannelPreview({
          id: encodeChannelId(channel.id),
          name: channel.name,
          logo: channel.logo,
          poster: channel.logo,
          tvgId: channel.tvgId,
          country: 'US',
          language: 'en',
        })
      );
  }

  async getCatalogGuide(skip = 0, date?: string): Promise<Meta[]> {
    const guideDate = resolveGuideDate(date);
    const channels = (await loadChannels(this.config)).slice(
      skip,
      skip + LIVE_TV_CATALOG_PAGE_SIZE
    );
    const programmes = await loadProgrammesForUtcDay(
      this.config,
      channels.map((channel) => channel.id),
      guideDate
    );

    return channels.map((channel) => {
      const encodedId = encodeChannelId(channel.id);
      const videos = programmes
        .filter((item) => sameId(item.channelId, channel.id))
        .filter((item) =>
          shiftedProgramOverlapsUtcDay(
            item,
            guideDate,
            this.config.timeShiftMinutes
          )
        )
        .map((item) => toVideo(encodedId, item, this.config.timeShiftMinutes));
      return guideChannelMeta(
        {
          id: encodedId,
          name: channel.name,
          logo: channel.logo,
          country: 'US',
          language: 'en',
          tvgId: channel.tvgId,
        },
        videos
      );
    });
  }

  async getCatalogResponse(
    skip = 0,
    date?: string
  ): Promise<CatalogHandlerResponse> {
    return buildEpgCatalogResponse(
      (pageSkip) => this.getCatalog(pageSkip),
      (pageSkip, guideDate) => this.getCatalogGuide(pageSkip, guideDate),
      skip,
      date
    );
  }

  async getMeta(id: string): Promise<Meta> {
    const channelId = decodeChannelId(id);
    const channel = (await loadChannels(this.config)).find((item) =>
      sameId(item.id, channelId)
    );
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const guideDate = resolveGuideDate();
    const programmes = await loadProgrammesForUtcDay(
      this.config,
      [channel.id],
      guideDate
    );
    const encodedId = encodeChannelId(channel.id);
    const videos = programmes
      .filter((item) =>
        shiftedProgramOverlapsUtcDay(
          item,
          guideDate,
          this.config.timeShiftMinutes
        )
      )
      .map((item) => toVideo(encodedId, item, this.config.timeShiftMinutes));

    return {
      id: encodedId,
      type: TV_TYPE,
      name: channel.name,
      logo: channel.logo,
      poster: channel.logo,
      posterShape: 'square',
      country: 'US',
      language: 'en',
      tvgId: channel.tvgId,
      behaviorHints: { hasScheduledVideos: true },
      videos,
    };
  }
}
