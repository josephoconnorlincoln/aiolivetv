import pLimit from 'p-limit';
import {
  createLogger,
  constants,
  Env,
  ExtrasParser,
  makeUrlLogSafe,
  addonProvidesResource,
} from '../utils/index.js';
import { canRunFfprobe } from '../utils/runtime.js';
import { config as appConfig } from '../config/index.js';
import { getAddonName } from '../utils/general.js';
import { Wrapper } from './wrapper.js';
import { PresetManager } from '../presets/index.js';
import { FeatureControl } from '../utils/feature.js';
import { StreamContext, StreamUtils } from '../streams/index.js';
import { enrichStreamsWithProbe } from '../streams/stream-probe.js';
import { applyLiveStreamWebHints } from '../streams/web-readiness.js';
import { attachLiveMetadataToStreams } from '../streams/live-metadata.js';
import { populateNzbFallbacks } from './nzbFailover.js';
import { resolveServiceWrappedStreams } from './serviceWrapper.js';
import type { ServiceWrapServiceTiming } from './serviceWrapper.js';
import type { PrecomputeSubTimings } from '../streams/precomputer.js';
import { StreamSelector } from '../parser/streamExpression.js';
import type {
  ParsedMeta,
  ParsedStream,
  Subtitle,
  AddonCatalog,
} from '../db/schemas.js';
import type { Addon } from '../db/index.js';
import type { Metadata } from '../metadata/utils.js';
import type {
  AIOStreamsContext,
  AIOStreamsError,
  AIOStreamsResponse,
} from './types.js';
import { buildStatistics } from './statistics.js';
import { precacheCache } from './caches.js';
import {
  applyPosterModifications,
  convertDiscoverDeepLinks,
} from './catalog.js';
import {
  hmac,
  sampleConfigFeatures,
  track,
  userAnalyticsEnabled,
  type AnalyticsServiceBreakdown,
} from '../analytics/index.js';
import type { AddonDispositionMap } from '../streams/fetcher.js';
import {
  getCanonicalChannelId,
  getChannelMapping,
  getEffectiveChannelGroup,
  isChannelAddonEnabled,
  isLiveChannelVisible,
  isLiveChannelType,
  isManualStreamSource,
  buildManualParsedStreams,
  orderLiveStreamsByMapping,
  getChannelMatchConfidence,
  isHighConfidenceChannelMatch,
  type ChannelMatchCandidate,
} from './channelMappings.js';
import { decodeHtmlEntities } from '../utils/text.js';
import { configurationProvidesNativeEpg } from './epgProvider.js';

const logger = createLogger('core');

const PING_TIMEOUT_MS = 10_000;

async function pingStream(stream: ParsedStream, timeoutMs = PING_TIMEOUT_MS) {
  if (!stream.url) {
    throw new Error('pingStream: stream has no URL');
  }
  const wrapper = new Wrapper(stream.addon);
  return wrapper.makeRequest(stream.url, {
    timeout: timeoutMs,
    rawOptions: { redirect: 'manual' },
  });
}

async function pingStreamUrls(streams: ParsedStream[]): Promise<void> {
  const eligible = streams.filter((s) => s.url);
  if (eligible.length === 0) {
    logger.debug('No streams to ping');
    return;
  }
  logger.debug({ count: eligible.length }, 'pinging stream urls');
  const limit = pLimit(appConfig.resources.preload.streamsConcurrency);
  await Promise.all(
    eligible.map((stream) =>
      limit(async () => {
        try {
          const response = await pingStream(stream);
          response.body?.cancel().catch(() => undefined);
          logger.debug('Ping request sent', {
            url: makeUrlLogSafe(stream.url!),
            status: response.status,
            redirectHost: (() => {
              const location = response.headers.get('location');
              if (!location) return 'no redirect';
              try {
                return new URL(location).host;
              } catch {
                return 'invalid URL';
              }
            })(),
          });
        } catch (error) {
          logger.debug('Ping request failed', {
            url: makeUrlLogSafe(stream.url!),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    )
  );
}

/**
 * Returns all addons that support the given resource name, type, and id.
 * An addon is included if it has a matching resource where either:
 *  - it declares idPrefixes and at least one matches the id, or
 *  - it declares no idPrefixes (accepts all ids)
 */
const LIVE_CHANNEL_STREAM_TYPES = [
  constants.TV_TYPE,
  constants.CHANNEL_TYPE,
] as const;

function resourceSupportsRequestType(
  resourceTypes: string[],
  requestType: string
): boolean {
  if (resourceTypes.includes(requestType)) return true;
  if (!isLiveChannelType(requestType)) return false;
  return LIVE_CHANNEL_STREAM_TYPES.some((type) => resourceTypes.includes(type));
}

function getAddonsForResource(
  ctx: Pick<AIOStreamsContext, 'supportedResources' | 'addons'>,
  resourceName: string,
  type: string,
  id: string
): Addon[] {
  const addons: Addon[] = [];
  for (const [instanceId, resources] of Object.entries(
    ctx.supportedResources
  )) {
    const supported = resources.find(
      (r) =>
        r.name === resourceName &&
        resourceSupportsRequestType(r.types, type) &&
        (r.idPrefixes ? r.idPrefixes.some((p) => id.startsWith(p)) : true)
    );
    if (supported) {
      const addon = ctx.addons.find((a) => a.instanceId === instanceId);
      if (addon) addons.push(addon);
    }
  }
  return addons;
}

function resolveAddonResourceType(
  ctx: Pick<AIOStreamsContext, 'supportedResources'>,
  instanceId: string,
  resourceName: 'stream' | 'meta',
  preferredType: string
): string | undefined {
  const resource = ctx.supportedResources[instanceId]?.find(
    (entry) => entry.name === resourceName
  );
  if (!resource?.types.length) return undefined;
  if (resource.types.includes(preferredType)) return preferredType;
  return resource.types[0];
}

function resolveAddonStreamType(
  ctx: Pick<AIOStreamsContext, 'supportedResources'>,
  instanceId: string,
  preferredType: string
): string | undefined {
  return resolveAddonResourceType(ctx, instanceId, 'stream', preferredType);
}

function findMappedStreamAddon(
  ctx: Pick<AIOStreamsContext, 'supportedResources' | 'addons'>,
  preferredType: string,
  _mappedId: string,
  addonId: string
): Addon | undefined {
  const addon = ctx.addons.find(
    (candidate) => candidate.instanceId === addonId
  );
  if (!addon?.instanceId) return undefined;
  if (!resolveAddonStreamType(ctx, addon.instanceId, preferredType)) {
    return undefined;
  }
  return addon;
}

function buildAddonStreamTypes(
  ctx: Pick<AIOStreamsContext, 'supportedResources'>,
  addons: Addon[],
  preferredType: string
): Map<string, string> {
  const types = new Map<string, string>();
  for (const addon of addons) {
    const resolved = resolveAddonStreamType(
      ctx,
      addon.instanceId!,
      preferredType
    );
    if (resolved) types.set(addon.instanceId!, resolved);
  }
  return types;
}

/**
 * Returns candidate addons for a meta request in two priority tiers:
 *  1. Addons with a matching idPrefix (tried first, errors are reported)
 *  2. Addons with general type support and no idPrefixes (fallback, errors are silently skipped)
 */
function getMetaCandidates(
  ctx: Pick<AIOStreamsContext, 'supportedResources' | 'addons'>,
  type: string,
  id: string
): Array<{
  addon: Addon;
  instanceId: string;
  reason: 'matching id prefix' | 'general type support';
}> {
  const results: Array<{
    addon: Addon;
    instanceId: string;
    reason: 'matching id prefix' | 'general type support';
  }> = [];

  for (const [instanceId, resources] of Object.entries(
    ctx.supportedResources
  )) {
    if (
      resources.find(
        (r) =>
          r.name === 'meta' &&
          r.types.includes(type) &&
          r.idPrefixes?.some((p) => id.startsWith(p))
      )
    ) {
      const addon = ctx.addons.find((a) => a.instanceId === instanceId);
      if (addon)
        results.push({ addon, instanceId, reason: 'matching id prefix' });
    }
  }

  for (const [instanceId, resources] of Object.entries(
    ctx.supportedResources
  )) {
    if (results.some((r) => r.instanceId === instanceId)) continue;
    if (
      resources.find(
        (r) =>
          r.name === 'meta' && r.types.includes(type) && !r.idPrefixes?.length
      )
    ) {
      const addon = ctx.addons.find((a) => a.instanceId === instanceId);
      if (addon)
        results.push({ addon, instanceId, reason: 'general type support' });
    }
  }

  return results;
}

type MetaCandidate = {
  addon: Addon;
  instanceId: string;
  reason: 'matching id prefix' | 'general type support';
  metaType: string;
};

function resolveAddonMetaType(
  ctx: Pick<AIOStreamsContext, 'supportedResources'>,
  instanceId: string,
  preferredType: string
): string | undefined {
  return resolveAddonResourceType(ctx, instanceId, 'meta', preferredType);
}

function collectLiveChannelMetaCandidates(
  ctx: Pick<AIOStreamsContext, 'supportedResources' | 'addons' | 'userData'>,
  type: string,
  channelId: string
): MetaCandidate[] {
  const channelMapping = getChannelMapping(ctx.userData, channelId);
  const requestTypes = [type];
  const candidates = new Map<string, MetaCandidate>();

  const addCandidates = (metaId: string, instanceId?: string) => {
    for (const metaType of requestTypes) {
      for (const candidate of getMetaCandidates(ctx, metaType, metaId)) {
        if (instanceId && candidate.instanceId !== instanceId) continue;
        const existing = candidates.get(candidate.instanceId);
        if (
          existing &&
          existing.metaType === constants.CHANNEL_TYPE &&
          metaType === constants.TV_TYPE
        ) {
          candidates.set(candidate.instanceId, { ...candidate, metaType });
          continue;
        }
        if (existing) continue;
        candidates.set(candidate.instanceId, { ...candidate, metaType });
      }
    }
  };

  addCandidates(channelId);
  if (channelMapping?.canonicalAddonId) {
    addCandidates(channelId, channelMapping.canonicalAddonId);
  }
  for (const source of channelMapping?.streams ?? []) {
    if (isManualStreamSource(source)) continue;
    addCandidates(source.channelId ?? channelId, source.addonId);
  }

  return [...candidates.values()].sort((left, right) =>
    left.instanceId === channelMapping?.canonicalAddonId
      ? -1
      : right.instanceId === channelMapping?.canonicalAddonId
        ? 1
        : 0
  );
}

function getNextEpisode(
  currentSeason: number | undefined,
  currentEpisode: number,
  metadata?: Metadata
): { season: number | undefined; episode: number } {
  let season = currentSeason;
  let episode = currentEpisode + 1;
  if (!currentSeason) return { season, episode };
  const episodeCount = metadata?.seasons?.find(
    (s) => s.season_number === season
  )?.episode_count;

  if (episodeCount && currentEpisode === episodeCount) {
    const nextSeasonNumber = currentSeason + 1;
    if (metadata?.seasons?.find((s) => s.season_number === nextSeasonNumber)) {
      logger.debug(
        { currentSeason, nextSeason: nextSeasonNumber },
        'current episode is last of season, advancing to next'
      );
      season = nextSeasonNumber;
      episode = 1;
    }
  }
  return { season, episode };
}

export async function processStreams(
  ctx: AIOStreamsContext,
  streams: ParsedStream[],
  context: StreamContext,
  isMeta: boolean = false,
  nzbFailoverOpts?: {
    count: number;
    position: 'beforeLimiting' | 'beforeSEL' | 'last';
  }
): Promise<{
  streams: ParsedStream[];
  errors: AIOStreamsError[];
  timings: {
    metaFilterMs: number;
    serviceWrapMs: number;
    serviceWrapTimings?: Record<string, ServiceWrapServiceTiming>;
    filterMs: number;
    deduplicationMs: number;
    precomputeMs: number;
    precomputeSubTimings?: PrecomputeSubTimings;
    sortMs: number;
    limitMs: number;
    selMs: number;
  };
}> {
  const { type, id } = context;
  let processedStreams = streams;
  let errors: AIOStreamsError[] = [];

  let metaFilterMs = 0;
  let serviceWrapMs = 0;
  let serviceWrapTimings: Record<string, ServiceWrapServiceTiming> | undefined;
  let filterMs = 0;
  let deduplicationMs = 0;
  let precomputeMs = 0;
  let precomputeSubTimings: PrecomputeSubTimings | undefined;
  let sortMs = 0;
  let limitMs = 0;
  let selMs = 0;

  if (isMeta) {
    await ctx.precomputer.precomputeSeaDexOnly(processedStreams, context);
    const metaFilterStart = Date.now();
    processedStreams = await ctx.filterer.filter(processedStreams, context);
    metaFilterMs = Date.now() - metaFilterStart;
  }

  const preServiceWrapIds = new Set(processedStreams.map((s) => s.id));
  const serviceWrapStart = Date.now();
  const resolvedResults = await resolveServiceWrappedStreams(
    processedStreams,
    context,
    ctx.userData,
    ctx.addons
  );
  serviceWrapMs = Date.now() - serviceWrapStart;
  processedStreams = resolvedResults.streams;
  errors.push(...resolvedResults.errors);
  if (resolvedResults.serviceTimings) {
    serviceWrapTimings = resolvedResults.serviceTimings;
  }

  if (resolvedResults.hasNewStreams) {
    const filterStart = Date.now();
    processedStreams = await ctx.filterer.filter(processedStreams, context);
    filterMs = Date.now() - filterStart;
  }

  const dedupStart = Date.now();
  processedStreams = await ctx.deduplicator.deduplicate(processedStreams);
  deduplicationMs = Date.now() - dedupStart;

  if (isMeta || resolvedResults.hasNewStreams) {
    const skipPerStreamIds =
      !isMeta && resolvedResults.hasNewStreams ? preServiceWrapIds : undefined;
    const precomputeStart = Date.now();
    precomputeSubTimings = await ctx.precomputer.precomputePreferred(
      processedStreams,
      context,
      skipPerStreamIds
    );
    precomputeMs = Date.now() - precomputeStart;
  }

  const sortStart = Date.now();
  let finalStreams = await ctx.sorter.sort(processedStreams, context);
  sortMs = Date.now() - sortStart;

  if (nzbFailoverOpts?.position === 'beforeLimiting') {
    await populateNzbFallbacks(
      finalStreams,
      nzbFailoverOpts.count,
      ctx.userData.uuid
    ).catch((error) => {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          position: 'beforeLimiting',
        },
        'error during nzb failover population'
      );
    });
  }

  const limitStart = Date.now();
  finalStreams = await ctx.limiter.limit(finalStreams);
  limitMs = Date.now() - limitStart;

  if (
    ctx.userData.streamProbe?.enabled &&
    canRunFfprobe() &&
    isLiveChannelType(type)
  ) {
    finalStreams = await enrichStreamsWithProbe(finalStreams, ctx.userData);
    finalStreams = await applyLiveStreamWebHints(finalStreams, {
      probe: true,
      timeoutMs: ctx.userData.streamProbe.timeoutMs,
    });
  } else if (isLiveChannelType(type)) {
    finalStreams = await applyLiveStreamWebHints(finalStreams, {
      probe: false,
    });
  }

  if (nzbFailoverOpts?.position === 'beforeSEL') {
    await populateNzbFallbacks(
      finalStreams,
      nzbFailoverOpts.count,
      ctx.userData.uuid
    ).catch((error) => {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          position: 'beforeSEL',
        },
        'error during nzb failover population'
      );
    });
  }

  const selStart = Date.now();
  finalStreams = await ctx.filterer.applyStreamExpressionFilters(
    finalStreams,
    context
  );
  selMs = Date.now() - selStart;

  if (!nzbFailoverOpts?.position || nzbFailoverOpts.position === 'last') {
    if (nzbFailoverOpts) {
      await populateNzbFallbacks(
        finalStreams,
        nzbFailoverOpts.count,
        ctx.userData.uuid
      ).catch((error) => {
        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            position: 'last',
          },
          'error during nzb failover population'
        );
      });
    }
  }

  ctx.filterer.generateFilterSummary(streams, finalStreams, type, id);

  const { streams: proxiedStreams, error } =
    await ctx.proxifier.proxify(finalStreams);

  if (error) {
    errors.push({ title: `Proxifier Error`, description: error });
  }
  finalStreams = proxiedStreams.map((stream) => {
    if (stream.parsedFile) {
      stream.parsedFile.visualTags = stream.parsedFile.visualTags.filter(
        (tag) => !constants.FAKE_VISUAL_TAGS.includes(tag as any)
      );
      stream.parsedFile.languages = stream.parsedFile.languages.filter(
        (lang) => !['Original'].includes(lang as any)
      );
    }
    return stream;
  });

  if (ctx.userData.externalDownloads) {
    const streamsWithExternalDownloads: ParsedStream[] = [];
    for (const stream of finalStreams) {
      streamsWithExternalDownloads.push(stream);
      if (stream.url) {
        streamsWithExternalDownloads.push(
          StreamUtils.createDownloadableStream(stream)
        );
      }
    }
    logger.debug(
      { added: streamsWithExternalDownloads.length - finalStreams.length },
      'added external download streams'
    );
    finalStreams = streamsWithExternalDownloads;
  }

  return {
    streams: finalStreams,
    errors,
    timings: {
      metaFilterMs,
      serviceWrapMs,
      serviceWrapTimings,
      filterMs,
      deduplicationMs,
      precomputeMs,
      precomputeSubTimings,
      sortMs,
      limitMs,
      selMs,
    },
  };
}

async function precacheNextEpisode(
  ctx: AIOStreamsContext,
  context: StreamContext
): Promise<void> {
  const { type, id, parsedId } = context;
  if (!parsedId) return;

  const currentSeason = parsedId.season ? Number(parsedId.season) : undefined;
  const currentEpisode = parsedId.episode
    ? Number(parsedId.episode)
    : undefined;
  if (!currentEpisode) return;

  const metadata = await context.getMetadata();
  const { season: seasonToPrecache, episode: episodeToPrecache } =
    getNextEpisode(currentSeason, currentEpisode, metadata);

  const precacheId = parsedId.generator(
    parsedId.value,
    seasonToPrecache?.toString(),
    episodeToPrecache?.toString()
  );
  logger.debug(
    {
      titleId: parsedId.value,
      currentSeason,
      currentEpisode,
      episodeToPrecache,
      seasonToPrecache,
      precacheId,
    },
    'pre-caching next episode'
  );

  // Temporarily mutate userData to remove excludeUncached filter for background precache.
  // Preserve original to restore after getStreams returns.
  const originalUserData = ctx.userData;
  const userData = structuredClone(ctx.userData);
  userData.excludeUncached = false;
  userData.groups = undefined;
  userData.dynamicAddonFetching = { enabled: false };
  ctx.userData = userData;

  const nextStreamsResponse = await getStreams(ctx, precacheId, type, true);
  ctx.userData = originalUserData;

  if (!nextStreamsResponse.success) {
    logger.error(
      { id, errors: nextStreamsResponse.errors },
      'failed to get streams during precaching'
    );
    return;
  }

  const nextStreams = nextStreamsResponse.data.streams;

  let selectedStreams: ParsedStream[] = [];
  const selector =
    ctx.userData.precacheSelector || constants.DEFAULT_PRECACHE_SELECTOR;
  try {
    const streamSelector = new StreamSelector(context.toExpressionContext());
    selectedStreams = await streamSelector.select(nextStreams, selector);
    logger.debug(
      { selector, resultCount: selectedStreams.length },
      'precache selector evaluated'
    );
  } catch (error) {
    logger.error(
      { selector, err: error instanceof Error ? error.message : String(error) },
      'failed to evaluate precache selector'
    );
  }

  if (selectedStreams.length === 0) {
    logger.debug(
      { id },
      'skipping precaching, precache selector returned no streams'
    );
    return;
  }

  const singleStreamOnly = ctx.userData.precacheSingleStream !== false;
  const streamsToCache = selectedStreams
    .filter((s) => s.url)
    .slice(0, singleStreamOnly ? 1 : appConfig.userLimits.maxBackgroundPings);

  if (streamsToCache.length === 0) {
    logger.debug({ id }, 'skipping precaching, no selected stream had a url');
    return;
  }

  logger.debug(
    { count: streamsToCache.length, id, type },
    'precaching streams'
  );

  const cacheKey = `precache-${type}-${id}-${ctx.userData.uuid}`;
  await precacheCache.set(
    cacheKey,
    true,
    appConfig.resources.precache.nextEpisodeMinInterval
  );

  await pingStreamUrls(streamsToCache);

  logger.debug(
    { count: streamsToCache.length, id, type },
    'precaching complete'
  );
}

/**
 * Emit one `addon_contribution` event per addon for the current stream
 * request. Gated by the per-user analytics flag and only fires when the
 * request has an attributable user (no anonymous attribution). All work is
 * O(addons + finalStreams) and stays on the hot path's caller (no I/O).
 */
function emitAddonContributions(args: {
  ctx: AIOStreamsContext;
  dispositions: AddonDispositionMap;
  byManifestUrl: Map<string, ParsedStream[]>;
}): void {
  if (!userAnalyticsEnabled()) return;
  const uuid = args.ctx.userData?.uuid;
  if (!uuid) return; // anonymous/probe traffic — nothing to attribute
  let uuidHash: string;
  try {
    uuidHash = hmac(uuid);
  } catch {
    return;
  }

  for (const [manifestUrl, info] of args.dispositions) {
    const survivors = args.byManifestUrl.get(manifestUrl) ?? [];

    // Build per-service breakdown over the surviving streams.
    let serviceBreakdown: AnalyticsServiceBreakdown | null = null;
    if (survivors.length > 0) {
      const map: AnalyticsServiceBreakdown = {};
      for (const s of survivors) {
        const id = s.service?.id ?? 'none';
        const slot = map[id] ?? { ok: 0, cached: 0, uncached: 0 };
        slot.ok += 1;
        if (s.service) {
          if (s.service.cached) slot.cached += 1;
          else slot.uncached += 1;
        }
        map[id] = slot;
      }
      serviceBreakdown = map;
    }

    let addonName: string | null = null;
    if (info.addon.name) {
      addonName = info.addon.name;
      if (info.addon.displayIdentifier) {
        addonName += ` (${info.addon.displayIdentifier})`;
      }
    }
    track({
      event_type: 'addon_contribution',
      resource: 'stream',
      uuid_hash: uuidHash,
      preset_id: info.addon.preset?.type ?? null,
      addon_instance_hash: hmac(manifestUrl),
      addon_name: addonName,
      url_overridden: false,
      status: info.status,
      error_kind: info.errorKind ?? null,
      latency_ms: info.latencyMs || null,
      result_count: info.rawCount,
      final_count: survivors.length,
      disposition: info.disposition,
      service_breakdown: serviceBreakdown,
    });
  }
}

const LIVE_STREAM_CATALOG_SCAN_LIMIT = 500;

function getAllLiveStreamAddons(
  ctx: Pick<AIOStreamsContext, 'supportedResources' | 'addons'>,
  preferredType: string
): Addon[] {
  return ctx.addons.filter(
    (addon) =>
      !!addon.instanceId &&
      !!resolveAddonStreamType(ctx, addon.instanceId, preferredType)
  );
}

async function loadCanonicalChannelCandidate(
  ctx: AIOStreamsContext,
  type: string,
  channelId: string,
  channelMapping?: ReturnType<typeof getChannelMapping>
): Promise<ChannelMatchCandidate> {
  const mapped: ChannelMatchCandidate | undefined =
    channelMapping?.name || channelMapping?.poster || channelMapping?.group
      ? {
          id: channelId,
          name: decodeHtmlEntities(channelMapping.name ?? channelId),
          logo: channelMapping.poster ?? undefined,
          categories: channelMapping.group
            ? [channelMapping.group]
            : undefined,
        }
      : undefined;

  for (const candidate of collectLiveChannelMetaCandidates(
    ctx,
    type,
    channelId
  )) {
    try {
      const metaType =
        resolveAddonMetaType(ctx, candidate.instanceId, candidate.metaType) ??
        candidate.metaType;
      const meta = await new Wrapper(candidate.addon).getMeta(
        metaType,
        channelId
      );
      const group = getEffectiveChannelGroup(
        ctx.userData,
        channelId,
        Array.isArray(meta.genres) ? meta.genres[0] : mapped?.categories?.[0]
      );
      return {
        id: channelId,
        name: mapped?.name ?? decodeHtmlEntities(meta.name ?? channelId),
        tvgId: typeof meta.tvgId === 'string' ? meta.tvgId : undefined,
        aliases: Array.isArray(meta.aliases)
          ? meta.aliases.map((alias) => decodeHtmlEntities(alias))
          : undefined,
        country: typeof meta.country === 'string' ? meta.country : undefined,
        language: typeof meta.language === 'string' ? meta.language : undefined,
        categories: group ? [group] : undefined,
        logo: mapped?.logo ?? meta.poster ?? undefined,
        hasSchedule: Boolean(
          meta.behaviorHints?.hasScheduledVideos ||
          (Array.isArray(meta.videos) && meta.videos.length > 0)
        ),
      };
    } catch {
      continue;
    }
  }

  return mapped ?? { id: channelId, name: channelId };
}

async function resolveStreamChannelIdForAddon(
  ctx: AIOStreamsContext,
  channelId: string,
  addon: Addon,
  canonical: ChannelMatchCandidate
): Promise<string> {
  const streamResource = ctx.supportedResources[addon.instanceId!]?.find(
    (resource) => resource.name === 'stream'
  );
  if (
    streamResource?.idPrefixes?.length &&
    streamResource.idPrefixes.some((prefix) => channelId.startsWith(prefix))
  ) {
    return channelId;
  }

  if (addonProvidesResource(addon, constants.CATALOG_RESOURCE)) {
    return channelId;
  }

  const catalog = ctx.finalCatalogs.find(
    (entry) =>
      entry.id.startsWith(`${addon.instanceId}.`) &&
      isLiveChannelType(entry.type)
  );
  if (!catalog) return channelId;

  const response = await new Wrapper(addon).getCatalog(
    catalog.type,
    catalog.id.split('.').slice(1).join('.'),
    catalog.extra?.some((extra) => extra.name === 'skip') ? 'skip=0' : undefined
  );
  let best: { id: string; confidence: number } | undefined;
  for (const item of response.slice(0, LIVE_STREAM_CATALOG_SCAN_LIMIT)) {
    const confidence = getChannelMatchConfidence(
      {
        id: item.id,
        name: decodeHtmlEntities(item.name ?? item.id),
        tvgId: typeof item.tvgId === 'string' ? item.tvgId : undefined,
        aliases: Array.isArray(item.aliases)
          ? item.aliases.map((alias) => decodeHtmlEntities(alias))
          : undefined,
        country: typeof item.country === 'string' ? item.country : undefined,
        language: typeof item.language === 'string' ? item.language : undefined,
        categories: Array.isArray(item.genres) ? item.genres : undefined,
        logo: item.poster ?? undefined,
      },
      canonical
    );
    if (
      isHighConfidenceChannelMatch(confidence) &&
      (!best || confidence > best.confidence)
    ) {
      best = { id: item.id, confidence };
    }
  }

  return best?.id ?? channelId;
}

async function resolveLiveStreamFetchPlan(
  ctx: AIOStreamsContext,
  type: string,
  channelId: string
): Promise<{
  addons: Addon[];
  channelIds: Map<string, string[]>;
  streamTypes: Map<string, string>;
  canonical: ChannelMatchCandidate;
}> {
  const channelMapping = getChannelMapping(ctx.userData, channelId);
  const canonical = await loadCanonicalChannelCandidate(
    ctx,
    type,
    channelId,
    channelMapping
  );
  const explicitSources =
    channelMapping?.streams?.filter(
      (source) => !isManualStreamSource(source) && source.enabled !== false
    ) ?? [];

  const addons: Addon[] = [];
  const channelIds = new Map<string, string[]>();
  const seen = new Set<string>();

  // A channel can link several streams from the same source (e.g. BBC TWO,
  // BBC TWO HD and BBC TWO ENG from one addon). Fetch every linked stream,
  // not only the first, so the backups actually reach the player.
  const addAddon = (addon: Addon, mappedChannelId: string) => {
    if (!addon.instanceId) return;
    if (
      channelMapping?.streams?.length &&
      !isChannelAddonEnabled(
        ctx.userData,
        channelId,
        addon.instanceId,
        mappedChannelId
      )
    ) {
      return;
    }
    const ids = channelIds.get(addon.instanceId) ?? [];
    if (!ids.includes(mappedChannelId)) ids.push(mappedChannelId);
    channelIds.set(addon.instanceId, ids);
    if (seen.has(addon.instanceId)) return;
    seen.add(addon.instanceId);
    addons.push(addon);
  };

  for (const source of explicitSources) {
    const mappedId = source.channelId ?? channelId;
    const addon = findMappedStreamAddon(ctx, type, mappedId, source.addonId);
    if (addon) addAddon(addon, mappedId);
  }

  if (addons.length === 0) {
    for (const addon of getAllLiveStreamAddons(ctx, type)) {
      addAddon(
        addon,
        await resolveStreamChannelIdForAddon(ctx, channelId, addon, canonical)
      );
    }
  }

  if (channelMapping?.streams?.length) {
    const priority = new Map(
      channelMapping.streams.map((stream, index) => [stream.addonId, index])
    );
    addons.sort(
      (left, right) =>
        (priority.get(left.instanceId!) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.instanceId!) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  return {
    addons,
    channelIds,
    streamTypes: buildAddonStreamTypes(ctx, addons, type),
    canonical,
  };
}

export async function getStreams(
  ctx: AIOStreamsContext,
  id: string,
  type: string,
  preCaching: boolean = false
): Promise<
  AIOStreamsResponse<{
    streams: ParsedStream[];
    statistics: { title: string; description: string; forced?: boolean }[];
  }>
> {
  logger.debug({ type, id }, 'handling stream request');
  const statistics: { title: string; description: string; forced?: boolean }[] =
    [];

  const isLiveChannel = isLiveChannelType(type);
  const channelId = isLiveChannel ? getCanonicalChannelId(id) : id;
  const channelMapping = isLiveChannel
    ? getChannelMapping(ctx.userData, channelId)
    : undefined;
  const liveStreamPlan = isLiveChannel
    ? await resolveLiveStreamFetchPlan(ctx, type, channelId)
    : undefined;
  let supportedAddons =
    liveStreamPlan?.addons ?? getAddonsForResource(ctx, 'stream', type, id);

  logger.debug(
    {
      count: supportedAddons.length,
      addons: supportedAddons.map((a) => a.name),
    },
    'found addons for stream resource'
  );

  const context = StreamContext.create(type, channelId, ctx.userData);
  ctx.streamContext = context;

  if (isLiveChannel && !isLiveChannelVisible(ctx.userData, channelId)) {
    return {
      success: true,
      data: { streams: [], statistics: [] },
      errors: [],
    };
  }

  ctx.filterer.resetFilterTimings();
  ctx.precomputer.resetPrecomputeTimings();

  const fetchStart = Date.now();
  const channelAddonIds = isLiveChannel
    ? liveStreamPlan!.channelIds
    : undefined;
  const addonStreamTypes = isLiveChannel
    ? liveStreamPlan!.streamTypes
    : undefined;
  const {
    streams,
    errors,
    statistics: addonStatistics,
    dispositions,
  } = await ctx.fetcher.fetch(
    supportedAddons,
    context,
    channelAddonIds,
    addonStreamTypes
  );
  const fetchMs = Date.now() - fetchStart;

  const canonical = liveStreamPlan?.canonical;
  let fetchedStreams = isLiveChannel
    ? attachLiveMetadataToStreams(
        orderLiveStreamsByMapping(
          streams,
          buildManualParsedStreams(ctx.userData, channelId),
          channelMapping?.streams
        ),
        {
          channelId,
          channelName: channelMapping?.name ?? canonical?.name,
          canonicalName: canonical?.name,
          tvgId: canonical?.tvgId,
          country: canonical?.country,
          language: canonical?.language,
          group: getEffectiveChannelGroup(
            ctx.userData,
            channelId,
            canonical?.categories?.[0]
          ),
          logo: canonical?.logo ?? channelMapping?.poster,
          mapping: channelMapping,
          epgProvider: configurationProvidesNativeEpg(
            ctx.addons,
            ctx.manifests
          ),
          hasSchedule: canonical?.hasSchedule,
        }
      )
    : streams;

  if (
    ctx.userData.statistics?.enabled &&
    ctx.userData.statistics?.statsToShow?.includes('addon')
  ) {
    statistics.push(...addonStatistics);
  }

  errors.push(
    ...ctx.addonInitialisationErrors.map((e) => ({
      title: `[❌] ${getAddonName(e.addon)}`,
      description: e.error,
    }))
  );

  const processResults = await processStreams(
    ctx,
    fetchedStreams,
    context,
    false,
    ctx.userData.nzbFailover?.enabled && !preCaching
      ? {
          count: ctx.userData.nzbFailover.count ?? 3,
          position: ctx.userData.nzbFailover.position ?? 'last',
        }
      : undefined
  );
  let finalStreams = processResults.streams;
  const pipelineTimings = processResults.timings;
  errors.push(...processResults.errors);

  if (FeatureControl.disabledStreamTypes.size > 0) {
    const removedByType = new Map<string, number>();
    finalStreams = finalStreams.filter((stream) => {
      if (FeatureControl.disabledStreamTypes.has(stream.type)) {
        removedByType.set(
          stream.type,
          (removedByType.get(stream.type) ?? 0) + 1
        );
        return false;
      }
      return true;
    });
    if (removedByType.size > 0) {
      const total = [...removedByType.values()].reduce((a, b) => a + b, 0);
      const lines: string[] = [
        `⚠️ The following stream types have been disabled by the instance owner.`,
        `📌 Disabled Stream Types (${total})`,
      ];
      for (const [type, count] of removedByType.entries()) {
        lines.push(`    • ${count}× ${type}`);
      }
      statistics.push({
        title: '🚫 Removal Reasons',
        description: lines.join('\n').trim(),
        forced: true,
      });
    }
  }

  if (ctx.userData.precacheNextEpisode && !preCaching) {
    let precache = false;
    const cacheKey = `precache-${type}-${id}-${ctx.userData.uuid}`;
    const cachedNextEpisode = await precacheCache.get(cacheKey, false);
    if (cachedNextEpisode) {
      logger.debug(
        { type, id, ttl: precacheCache.getTTL(cacheKey) },
        'skipping precache, already precached recently'
      );
      precache = false;
    } else {
      precache = true;
    }
    if (precache) {
      setImmediate(() => {
        precacheNextEpisode(ctx, context).catch((error) => {
          logger.error('Error during precaching:', {
            error: error instanceof Error ? error.message : String(error),
            type,
            id,
          });
        });
      });
    }
  }

  if (ctx.userData.preloadStreams?.enabled && !preCaching) {
    let shouldPreload = true;
    if (appConfig.resources.preload.minInterval > 0) {
      const preloadCooldownKey = `preload-${type}-${id}-${ctx.userData.uuid}`;
      const recentlyPreloaded = await precacheCache.get(
        preloadCooldownKey,
        false
      );
      if (recentlyPreloaded) {
        logger.debug(
          { type, id, ttl: precacheCache.getTTL(preloadCooldownKey) },
          'preload skipped, within cooldown'
        );
        shouldPreload = false;
      } else {
        await precacheCache.set(
          preloadCooldownKey,
          true,
          appConfig.resources.preload.minInterval
        );
      }
    }

    if (shouldPreload) {
      const preloadSelector =
        ctx.userData.preloadStreams.selector ??
        constants.DEFAULT_PRELOAD_SELECTOR;
      const streamSelector = new StreamSelector(context.toExpressionContext());
      let streamsToPreload: ParsedStream[];
      const preloadSingleStream =
        ctx.userData.preloadStreams?.singleStream !== false;
      try {
        streamsToPreload = (
          await streamSelector.select(finalStreams, preloadSelector)
        )
          .filter((s) => s.url)
          .slice(
            0,
            preloadSingleStream ? 1 : appConfig.userLimits.maxBackgroundPings
          );
      } catch (selectorError) {
        logger.warn('Preload selector evaluation failed', {
          selector: preloadSelector,
          error:
            selectorError instanceof Error
              ? selectorError.message
              : String(selectorError),
        });
        streamsToPreload = [];
      }
      if (streamsToPreload.length > 0) {
        setImmediate(() => {
          pingStreamUrls(streamsToPreload).catch((error) => {
            logger.error('Error during stream preloading:', {
              error: error instanceof Error ? error.message : String(error),
              type,
              id,
            });
          });
        });
      }
    }
  }

  statistics.push(
    ...buildStatistics(
      {
        userData: ctx.userData,
        filterer: ctx.filterer,
        precomputer: ctx.precomputer,
      },
      finalStreams,
      fetchMs,
      pipelineTimings
    )
  );

  const byPresetType = new Map<string, ParsedStream[]>();
  const byManifestUrl = new Map<string, ParsedStream[]>();
  for (const s of finalStreams) {
    const t = s.addon?.preset?.type ?? '';
    if (t) {
      const list = byPresetType.get(t) ?? [];
      list.push(s);
      byPresetType.set(t, list);
    }
    const m = s.addon?.manifestUrl;
    if (m) {
      const list = byManifestUrl.get(m) ?? [];
      list.push(s);
      byManifestUrl.set(m, list);
    }
  }
  for (const [presetType, list] of byPresetType) {
    if (!PresetManager.has(presetType)) continue;
    const PresetClass = PresetManager.fromId(presetType);
    if (typeof PresetClass.onStreamsReady === 'function') {
      PresetClass.onStreamsReady(list);
    }
  }

  emitAddonContributions({
    ctx,
    dispositions,
    byManifestUrl,
  });

  if (ctx.userData?.uuid) {
    const serviceIds: string[] = [];
    for (const s of ctx.userData.services ?? []) {
      if (s.enabled !== false && s.id) serviceIds.push(s.id);
    }
    const presetTypes: string[] = [];
    for (const p of ctx.userData.presets ?? []) {
      if (p.enabled !== false && p.type) presetTypes.push(p.type);
    }
    sampleConfigFeatures({
      uuid: ctx.userData.uuid,
      serviceIds,
      formatterId: ctx.userData.formatter?.id ?? null,
      presetTypes,
    });
  }

  logger.debug(
    {
      streams: finalStreams.length,
      errors: errors.length,
      statistics: statistics.length,
    },
    'stream request complete'
  );
  return {
    success: true,
    data: { streams: finalStreams, statistics },
    errors,
  };
}

export async function getMeta(
  ctx: AIOStreamsContext,
  type: string,
  id: string
): Promise<AIOStreamsResponse<ParsedMeta | null>> {
  logger.debug({ type, id }, 'handling meta request');

  const isLiveChannel = isLiveChannelType(type);
  const channelId = isLiveChannel ? getCanonicalChannelId(id) : id;
  const channelMapping = isLiveChannel
    ? getChannelMapping(ctx.userData, channelId)
    : undefined;

  if (isLiveChannel && !isLiveChannelVisible(ctx.userData, channelId)) {
    return { success: false, data: null, errors: [] };
  }

  const candidates = isLiveChannel
    ? collectLiveChannelMetaCandidates(ctx, type, channelId)
    : getMetaCandidates(ctx, type, id).map((candidate) => ({
        ...candidate,
        metaType: type,
      }));

  if (candidates.length === 0) {
    logger.warn({ type, id }, 'no supported addon found for meta request');
    return { success: false, data: null, errors: [] };
  }

  const errors: Array<{ title: string; description: string }> = [];

  for (const candidate of candidates) {
    logger.debug(
      {
        addon: candidate.addon.name,
        instanceId: candidate.instanceId,
        reason: candidate.reason,
        metaType: candidate.metaType,
      },
      'trying addon for meta resource'
    );
    try {
      const mappedId =
        channelMapping?.streams?.find(
          (stream) => stream.addonId === candidate.instanceId
        )?.channelId ?? channelId;
      const metaType =
        resolveAddonMetaType(ctx, candidate.instanceId, candidate.metaType) ??
        candidate.metaType;
      const meta = await new Wrapper(candidate.addon).getMeta(
        metaType,
        mappedId
      );
      if (isLiveChannel) {
        meta.id = channelId;
        meta.videos = meta.videos?.map((video) =>
          video.startTime
            ? { ...video, id: `${channelId}:epg:${video.startTime}` }
            : video
        );
        const group = getEffectiveChannelGroup(
          ctx.userData,
          channelId,
          Array.isArray(meta.genres) ? meta.genres[0] : undefined
        );
        if (group) meta.genres = [group];
      }
      logger.debug(
        { addon: candidate.addon.name, instanceId: candidate.instanceId },
        'successfully got meta from addon'
      );
      if (ctx.userData.usePosterServiceForMeta) {
        await applyPosterModifications(ctx, [meta], type, true);
      } else {
        meta.links = convertDiscoverDeepLinks(ctx, meta.links);
      }
      if (isLiveChannel) {
        if (channelMapping?.name?.trim()) meta.name = channelMapping.name.trim();
        if (channelMapping?.poster?.trim()) {
          meta.poster = channelMapping.poster.trim();
          meta.logo = channelMapping.poster.trim();
        }
      }
      if (meta.videos) {
        meta.videos = await Promise.all(
          meta.videos.map(async (video) => {
            if (!video.streams || video.startTime) return video;
            const context = StreamContext.create(type, id, ctx.userData);
            ctx.streamContext = context;
            video.streams = (
              await processStreams(ctx, video.streams, context, true)
            ).streams;
            return video;
          })
        );
      }
      return { success: true, data: meta, errors: [] };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          addon: candidate.addon.name,
          err: errorMessage,
          reason: candidate.reason,
        },
        'failed to get meta from addon'
      );
      if (candidate.reason === 'general type support') continue;
      errors.push({
        title: `[❌] ${candidate.addon.name}`,
        description: errorMessage,
      });
    }
  }

  logger.error(
    { candidates: candidates.length, type, id },
    'all candidate addons failed for meta request'
  );
  return { success: false, data: null, errors };
}

export async function getSubtitles(
  ctx: AIOStreamsContext,
  type: string,
  id: string,
  extras?: string
): Promise<AIOStreamsResponse<Subtitle[]>> {
  logger.debug({ type, id, extras }, 'handling subtitle request');

  const supportedAddons = getAddonsForResource(ctx, 'subtitles', type, id);
  const parsedExtras = new ExtrasParser(extras);

  let errors: AIOStreamsError[] = ctx.addonInitialisationErrors.map(
    (error) => ({
      title: `[❌] ${getAddonName(error.addon)}`,
      description: error.error,
    })
  );
  let allSubtitles: Subtitle[] = [];

  await Promise.all(
    supportedAddons.map(async (addon) => {
      try {
        const subtitles = await new Wrapper(addon).getSubtitles(
          type,
          id,
          parsedExtras.toString()
        );
        if (subtitles) allSubtitles.push(...subtitles);
      } catch (error) {
        errors.push({
          title: `[❌] ${getAddonName(addon)}`,
          description: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );

  return { success: true, data: allSubtitles, errors };
}

export async function getAddonCatalog(
  ctx: AIOStreamsContext,
  type: string,
  id: string
): Promise<AIOStreamsResponse<AddonCatalog[]>> {
  logger.debug({ type, id }, 'handling addon catalog request');
  const addonInstanceId = id.split('.', 2)[0];
  const addon = ctx.addons.find((a) => a.instanceId === addonInstanceId);
  if (!addon) {
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `Addon ${addonInstanceId} not found`,
          description: 'Addon not found',
        },
      ],
    };
  }
  const actualAddonCatalogId = id.split('.').slice(1).join('.');
  let addonCatalogs: AddonCatalog[] = [];
  try {
    addonCatalogs = await new Wrapper(addon).getAddonCatalog(
      type,
      actualAddonCatalogId
    );
  } catch (error) {
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `[❌] ${getAddonName(addon)}`,
          description: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return { success: true, data: addonCatalogs, errors: [] };
}
