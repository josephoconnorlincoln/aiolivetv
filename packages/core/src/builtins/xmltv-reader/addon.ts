import { z } from 'zod';
import type { Manifest, Meta, MetaPreview } from '../../db/index.js';
import { TV_TYPE } from '../../utils/constants.js';
import {
  bareChannelPreview,
  buildEpgCatalogResponse,
  applyEpgTimeShift,
  EPG_CACHE_HEADERS,
  EPG_GUIDE_CATALOG_EXTRAS,
  guideChannelMeta,
  LIVE_TV_CATALOG_PAGE_SIZE,
  shiftedProgramOverlapsUtcDay,
  programToVideo,
  resolveGuideDate,
  type CatalogHandlerResponse,
} from '../live-tv/epg.js';
import {
  CHANNEL_ID_PREFIX,
  decodeChannelId,
  encodeChannelId,
  fetchSourceText,
  LiveTvSourceConfig,
  LiveTvSourceConfigSchema,
} from '../live-tv/shared.js';
import { parseXmltvData, buildProgramsByChannelId, type XmltvData } from './parser.js';

const SOURCE_CACHE_TTL_MS = 300_000;
const SOURCE_CACHE_MAX_ENTRIES = 8;

/**
 * Parsed guides are kept in this process only. A whole country guide is far
 * too large to round-trip through Redis on every catalog page (it can exceed
 * the store's value limit or the Redis timeout, which turns every page into a
 * full re-download and re-parse). The parsed data is treated as read-only.
 */
const parsedSources = new Map<string, { data: XmltvData; expiresAt: number }>();
const inflightSources = new Map<string, Promise<XmltvData>>();

/** Drop parsed guides held by this process (used by tests). */
export function clearXmltvSourceCache() {
  parsedSources.clear();
  inflightSources.clear();
}

async function loadXmltv(config: LiveTvSourceConfig): Promise<XmltvData> {
  const cacheKey = config.sourceUrl;
  const cached = parsedSources.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (cached) parsedSources.delete(cacheKey);

  // Concurrent catalog/meta requests for the same guide share one download.
  const pending = inflightSources.get(cacheKey);
  if (pending) return pending;

  const load = (async () => {
    const data = hydrateXmltvData(
      await parseXmltvData(await fetchSourceText(config))
    );
    parsedSources.set(cacheKey, {
      data,
      expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
    });
    while (parsedSources.size > SOURCE_CACHE_MAX_ENTRIES) {
      const oldest = parsedSources.keys().next().value;
      if (oldest === undefined) break;
      parsedSources.delete(oldest);
    }
    return data;
  })();
  inflightSources.set(cacheKey, load);
  try {
    return await load;
  } finally {
    inflightSources.delete(cacheKey);
  }
}

function hydrateXmltvData(data: XmltvData): XmltvData {
  if (data.programsByChannelId instanceof Map) {
    return data;
  }
  return {
    ...data,
    programsByChannelId: buildProgramsByChannelId(data.programs ?? []),
  };
}

function programsForChannel(data: XmltvData, channelId: string) {
  return data.programsByChannelId.get(channelId.trim().toLowerCase()) ?? [];
}

function mapProgramToVideo(
  encodedId: string,
  program: XmltvData['programs'][number],
  timeShiftMinutes: number
) {
  const { startTime, endTime } = applyEpgTimeShift(
    program.startTime,
    program.endTime,
    timeShiftMinutes
  );
  return programToVideo({
    channelEncodedId: encodedId,
    title: program.title,
    subtitle: program.subtitle,
    description: program.description,
    thumbnail: program.thumbnail,
    startTime,
    endTime,
    airedYear: program.released?.slice(0, 4),
    categories: program.categories,
    cast: program.cast,
    directors: program.directors,
    ratings: program.ratings,
  });
}

export class XmltvAddon {
  private readonly config: LiveTvSourceConfig;

  constructor(config: z.input<typeof LiveTvSourceConfigSchema>) {
    this.config = LiveTvSourceConfigSchema.parse(config);
  }

  getManifest(): Manifest {
    return {
      id: 'org.aiolivetv.xmltv',
      name: 'XMLTV',
      version: '1.0.0',
      description: 'Live TV channel metadata from XMLTV',
      types: [TV_TYPE],
      resources: [
        {
          name: 'catalog',
          types: [TV_TYPE],
          idPrefixes: [CHANNEL_ID_PREFIX],
        },
        {
          name: 'meta',
          types: [TV_TYPE],
          idPrefixes: [CHANNEL_ID_PREFIX],
        },
      ],
      catalogs: [
        {
          id: 'aiolivetv-channels',
          type: TV_TYPE,
          name: 'Channels',
          extra: [...EPG_GUIDE_CATALOG_EXTRAS],
        },
      ],
      behaviorHints: { epgProvider: true },
    };
  }

  async getCatalog(skip = 0): Promise<MetaPreview[]> {
    return (await loadXmltv(this.config)).channels
      .slice(skip, skip + LIVE_TV_CATALOG_PAGE_SIZE)
      .map((channel) =>
        bareChannelPreview({
          id: encodeChannelId(channel.id),
          name: channel.name,
          poster: channel.logo,
          tvgId: channel.id,
          aliases: channel.aliases,
          language: channel.language,
        })
      );
  }

  async getCatalogGuide(skip = 0, date?: string): Promise<Meta[]> {
    const guideDate = resolveGuideDate(date);
    const data = await loadXmltv(this.config);
    const { timeShiftMinutes } = this.config;
    return data.channels
      .slice(skip, skip + LIVE_TV_CATALOG_PAGE_SIZE)
      .map((channel) => {
        const encodedId = encodeChannelId(channel.id);
        const videos = programsForChannel(data, channel.id)
          .filter((program) =>
            shiftedProgramOverlapsUtcDay(program, guideDate, timeShiftMinutes)
          )
          .map((program) =>
            mapProgramToVideo(encodedId, program, timeShiftMinutes)
          );
        return guideChannelMeta(
          {
            id: encodedId,
            name: channel.name,
            logo: channel.logo,
            language: channel.language,
            tvgId: channel.id,
            aliases: channel.aliases,
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
    const data = await loadXmltv(this.config);
    const channel = data.channels.find(
      (item) => item.id.trim().toLowerCase() === channelId
    );
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const encodedId = encodeChannelId(channel.id);
    const guideDate = resolveGuideDate();
    const { timeShiftMinutes } = this.config;
    return {
      id: encodedId,
      type: TV_TYPE,
      name: channel.name,
      poster: channel.logo,
      posterShape: 'square',
      behaviorHints: { hasScheduledVideos: true },
      videos: programsForChannel(data, channel.id)
        .filter((program) =>
          shiftedProgramOverlapsUtcDay(program, guideDate, timeShiftMinutes)
        )
        .map((program) =>
          mapProgramToVideo(encodedId, program, timeShiftMinutes)
        ),
    };
  }
}
