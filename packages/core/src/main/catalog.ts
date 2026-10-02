import {
  createLogger,
  getTimeTakenSincePoint,
  ExtrasParser,
  getSimpleTextHash,
  maskSensitiveInfo,
  constants,
} from '../utils/index.js';
import { Wrapper } from './wrapper.js';
import { createPosterService } from '../poster/index.js';
import { getAddonName } from '../utils/general.js';
import type {
  MetaPreview,
  MergedCatalog,
  Meta,
  Preset,
} from '../db/schemas.js';
import type { Manifest } from '../db/index.js';
import type {
  AIOStreamsContext,
  AIOStreamsCatalogResponse,
  AIOStreamsResponse,
} from './types.js';
import {
  applyLiveChannelGroupOverlay,
  deduplicateLiveTvItems,
  isLiveChannelType,
  isLiveChannelVisible,
  sortLiveCatalogItems,
} from './channelMappings.js';
import { normalizeChannelGroup } from '../utils/channelName.js';
import {
  shuffleCache,
  mergedCatalogCache,
  type MergedCatalogSkipState,
} from './caches.js';

import { isMergedCatalogId } from './liveTvMergedCatalog.js';

export {
  LIVE_TV_MERGED_CATALOG_ID,
  buildLiveTvMergedCatalog,
  isMergedCatalogId,
} from './liveTvMergedCatalog.js';

const logger = createLogger('core');
const MAX_LIVE_TV_SOURCE_PAGES = 50;
const MAX_LIVE_TV_SOURCE_ITEMS = 10_000;

export function convertDiscoverDeepLinks(
  ctx: Pick<AIOStreamsContext, 'addons' | 'manifestUrl'>,
  items: Meta['links']
): Meta['links'] {
  if (!items) {
    return items;
  }
  return items.map((link) => {
    try {
      if (link.url.startsWith('stremio:///discover/')) {
        const linkUrl = new URL(decodeURIComponent(link.url.split('/')[4]));
        const addon = ctx.addons.find(
          (a) => new URL(a.manifestUrl).hostname === linkUrl.hostname
        );
        if (addon) {
          const [_, linkType, catalogIdAndQuery] = link.url
            .replace('stremio:///discover/', '')
            .split('/');
          const newCatalogId = `${addon.instanceId}.${catalogIdAndQuery}`;
          const newTransportUrl = encodeURIComponent(ctx.manifestUrl);
          link.url = `stremio:///discover/${newTransportUrl}/${linkType}/${newCatalogId}`;
        }
      }
    } catch {}
    return link;
  });
}

export async function fetchRawCatalogItems(
  ctx: AIOStreamsContext,
  addonInstanceId: string,
  catalogId: string,
  type: string,
  parsedExtras?: ExtrasParser
): Promise<{
  success: boolean;
  items: MetaPreview[];
  metasDetailed?: Meta[];
  error?: { title: string; description: string };
}> {
  const addon = ctx.addons.find((a) => a.instanceId === addonInstanceId);

  if (!addon) {
    const initError = (
      ctx.addonInitialisationErrors as { addon: Preset; error: string }[]
    ).find((e) => addonInstanceId.startsWith(e.addon.instanceId || ''));
    if (initError) {
      return {
        success: false,
        items: [],
        error: {
          title: `[❌] ${initError.error}`,
          description: `Addon ${addonInstanceId} failed to initialise. Try reinstalling/disabling/uninstalling the addon.`,
        },
      };
    }
    return {
      success: false,
      items: [],
      error: {
        title: `Addon ${addonInstanceId} not found. Try reinstalling the addon.`,
        description: 'Addon not found',
      },
    };
  }

  // Check for type override in modifications
  let actualType = type;
  const modification = ctx.userData.catalogModifications?.find(
    (mod) =>
      mod.id === `${addonInstanceId}.${catalogId}` &&
      (mod.type === type || mod.overrideType === type)
  );
  if (modification?.overrideType) {
    actualType = modification.type;
  }

  if (parsedExtras?.genre === 'None') {
    parsedExtras.genre = undefined;
  }
  const extrasString = parsedExtras?.toString();

  try {
    const start = Date.now();
    const catalog = await new Wrapper(addon).getCatalogResponse(
      actualType,
      catalogId,
      extrasString
    );
    logger.debug(
      {
        addon: addon.name,
        catalogId,
        type: actualType,
        took: getTimeTakenSincePoint(start),
        guide: Boolean(catalog.metasDetailed),
      },
      'received catalog'
    );
    if (catalog.metasDetailed) {
      return { success: true, items: [], metasDetailed: catalog.metasDetailed };
    }
    return { success: true, items: catalog.metas ?? [] };
  } catch (error) {
    return {
      success: false,
      items: [],
      error: {
        title: `[❌] ${addon.name}`,
        description: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function fetchAllLiveCatalogPages(
  ctx: AIOStreamsContext,
  addonInstanceId: string,
  catalogId: string,
  type: string,
  extras: ExtrasParser
): Promise<{
  success: boolean;
  items: MetaPreview[];
  metasDetailed?: Meta[];
  error?: { title: string; description: string };
}> {
  const items: MetaPreview[] = [];
  const metasDetailed: Meta[] = [];
  let skip = 0;
  let page = 0;
  let firstError: { title: string; description: string } | undefined;

  while (
    page < MAX_LIVE_TV_SOURCE_PAGES &&
    items.length + metasDetailed.length < MAX_LIVE_TV_SOURCE_ITEMS
  ) {
    page += 1;
    const pageExtras = new ExtrasParser(extras.toString());
    pageExtras.skip = skip > 0 ? skip : undefined;
    const result = await fetchRawCatalogItems(
      ctx,
      addonInstanceId,
      catalogId,
      type,
      pageExtras
    );
    if (!result.success) {
      firstError = result.error;
      if (page === 1) return result;
      break;
    }
    const batch = result.metasDetailed?.length
      ? result.metasDetailed
      : result.items;
    if (batch.length === 0) break;
    if (result.metasDetailed?.length) {
      metasDetailed.push(...result.metasDetailed);
    } else {
      items.push(...result.items);
    }
    skip += batch.length;
  }

  if (page === 1 && firstError && items.length + metasDetailed.length === 0) {
    return { success: false, items: [], error: firstError };
  }

  return {
    success: true,
    items,
    metasDetailed: metasDetailed.length ? metasDetailed : undefined,
  };
}

/**
 * Gets the extras configuration for a specific catalog from an addon's manifest.
 * Used to determine what extras (search, genre, etc.) a catalog supports.
 */
export function getCatalogExtras(
  ctx: Pick<AIOStreamsContext, 'manifests'>,
  addonInstanceId: string,
  catalogId: string,
  catalogType: string
): Manifest['catalogs'][number]['extra'] | undefined {
  const manifest = ctx.manifests[addonInstanceId];
  if (!manifest) return undefined;

  const catalog = manifest.catalogs?.find(
    (c) => c.id === catalogId && c.type === catalogType
  );
  return catalog?.extra;
}

export function catalogSupportsSkip(
  extras: Manifest['catalogs'][number]['extra'] | undefined
): boolean {
  return extras?.some((extra) => extra.name === 'skip') ?? false;
}

function itemMatchesCatalogGenre(
  item: { genres?: string[] | null },
  genre?: string
): boolean {
  if (!genre || genre === 'None') return true;
  const wanted = normalizeChannelGroup(genre);
  return (
    Boolean(wanted) &&
    Array.isArray(item.genres) &&
    item.genres.some((value) => normalizeChannelGroup(value) === wanted)
  );
}

function applyLiveTvCatalogOverlay<
  T extends {
    id: string;
    name?: string | null;
    poster?: string | null;
    logo?: string | null;
    genres?: string[] | null;
  },
>(
  ctx: Pick<AIOStreamsContext, 'userData'>,
  type: string,
  items: T[],
  genre?: string,
  sortByName = true
): T[] {
  if (!isLiveChannelType(type)) return items;
  const overlaid = applyLiveChannelGroupOverlay(ctx.userData, items).filter(
    (item) => itemMatchesCatalogGenre(item, genre)
  );
  return sortByName ? sortLiveCatalogItems(overlaid) : overlaid;
}

/**
 * Applies poster modifications to catalog items.
 */
export async function applyPosterModifications(
  ctx: AIOStreamsContext,
  items: MetaPreview[],
  type: string,
  applyPosterService: boolean = true
): Promise<MetaPreview[]> {
  const posterApi = applyPosterService
    ? createPosterService(ctx.userData)
    : null;

  return Promise.all(
    items.map(async (item) => {
      if (posterApi && item.poster) {
        let posterUrl = item.poster;
        if (posterApi.isPosterFromThisService(posterUrl)) {
          // already a poster from this service, do nothing
        } else if (ctx.userData.usePosterRedirectApi) {
          const itemId = (item as any).imdb_id || item.id;
          posterUrl = posterApi.buildRedirectUrl(itemId, type, item.poster);
        } else {
          const servicePosterUrl = await posterApi.getPosterUrl(
            type,
            (item as any).imdb_id || item.id,
            false
          );
          if (servicePosterUrl) {
            posterUrl = servicePosterUrl;
          }
        }
        item.poster = posterUrl;
      }

      if (item.links) {
        item.links = convertDiscoverDeepLinks(ctx, item.links);
      }
      return item;
    })
  );
}

/**
 * Applies catalog modifications like shuffle, reverse, poster service, etc.
 * Used by getCatalog for standalone catalogs and getMergedCatalog for source catalogs.
 */
export async function applyCatalogModifications(
  ctx: AIOStreamsContext,
  items: MetaPreview[],
  catalogId: string,
  type: string,
  parsedExtras?: ExtrasParser,
  shuffleCacheKey?: string
): Promise<MetaPreview[]> {
  let catalog = [...items];
  const isSearch = parsedExtras?.search;

  const modification = ctx.userData.catalogModifications?.find(
    (mod) =>
      mod.id === catalogId && (mod.type === type || mod.overrideType === type)
  );
  const applyShuffle = modification?.shuffle && !isSearch && shuffleCacheKey;
  const applyReverse = !applyShuffle && modification?.reverse && !isSearch;

  logger.debug(
    {
      catalogId,
      type,
      modificationFound: !!modification,
      shuffle: !!applyShuffle,
      reverse: !!applyReverse,
    },
    'applying catalog modifications'
  );

  if (applyShuffle) {
    const cachedShuffle = await shuffleCache.get(shuffleCacheKey);
    if (cachedShuffle) {
      catalog = cachedShuffle;
    } else {
      for (let i = catalog.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [catalog[i], catalog[j]] = [catalog[j], catalog[i]];
      }
      if (modification.persistShuffleFor) {
        await shuffleCache.set(
          shuffleCacheKey,
          catalog,
          modification.persistShuffleFor * 3600
        );
      }
    }
  } else if (applyReverse) {
    catalog = catalog.reverse();
  }

  const applyPosterService = modification?.usePosterService === true;
  catalog = await applyPosterModifications(
    ctx,
    catalog,
    type,
    applyPosterService
  );

  return catalog;
}

/**
 * Extracts a year from releaseInfo which can be a number (year) or string (year or year-year range).
 * For ranges like "2020-2024", returns the first year.
 */
function extractYear(releaseInfo: number | string | undefined | null): number {
  if (releaseInfo === undefined || releaseInfo === null) return 0;
  if (typeof releaseInfo === 'number') return releaseInfo;
  const match = String(releaseInfo).match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Applies merge method to combine items from multiple source catalogs.
 */
function applyMergeMethod(
  itemsBySource: MetaPreview[][],
  method?: MergedCatalog['mergeMethod']
): MetaPreview[] {
  const mergeMethod = method || 'sequential';

  switch (mergeMethod) {
    case 'interleave': {
      const result: MetaPreview[] = [];
      const maxLength = Math.max(0, ...itemsBySource.map((arr) => arr.length));
      for (let i = 0; i < maxLength; i++) {
        for (const sourceItems of itemsBySource) {
          if (i < sourceItems.length) {
            result.push(sourceItems[i]);
          }
        }
      }
      return result;
    }

    case 'imdbRating': {
      const allItems = itemsBySource.flat();
      return allItems.sort((a, b) => {
        const ratingA = parseFloat(a.imdbRating?.toString() ?? '0');
        const ratingB = parseFloat(b.imdbRating?.toString() ?? '0');
        if (isNaN(ratingA) && isNaN(ratingB)) return 0;
        if (isNaN(ratingA)) return 1;
        if (isNaN(ratingB)) return -1;
        return ratingB - ratingA;
      });
    }

    case 'releaseDateAsc': {
      const allItems = itemsBySource.flat();
      return allItems.sort(
        (a, b) => extractYear(a.releaseInfo) - extractYear(b.releaseInfo)
      );
    }

    case 'releaseDateDesc': {
      const allItems = itemsBySource.flat();
      return allItems.sort(
        (a, b) => extractYear(b.releaseInfo) - extractYear(a.releaseInfo)
      );
    }

    case 'sequential':
    default:
      return itemsBySource.flat();
  }
}

function deduplicateMergedCatalog(
  items: MetaPreview[],
  methods?: ('id' | 'title')[]
): MetaPreview[] {
  if (!methods || methods.length === 0) {
    return items;
  }

  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();

  return items.filter((item) => {
    const itemIds = [item.id, (item as any).imdb_id].filter(Boolean);
    const title = (item.name || item.id).toLowerCase();

    const isDuplicateById =
      methods.includes('id') && itemIds.some((id) => seenIds.has(id));
    const isDuplicateByTitle =
      methods.includes('title') && seenTitles.has(title);

    if (isDuplicateById || isDuplicateByTitle) {
      return false;
    }

    itemIds.forEach((id) => seenIds.add(id));
    seenTitles.add(title);
    return true;
  });
}

export async function getMergedCatalog(
  ctx: AIOStreamsContext,
  type: string,
  id: string,
  extras?: string
): Promise<AIOStreamsCatalogResponse> {
  const start = Date.now();
  const mergedCatalog = ctx.userData.mergedCatalogs?.find((mc) => mc.id === id);

  if (!mergedCatalog) {
    logger.error({ id }, 'merged catalog not found');
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `Merged catalog ${id} not found`,
          description: 'Try reinstalling the addon.',
        },
      ],
    };
  }

  if (mergedCatalog.type !== type) {
    logger.error(
      { id, expected: mergedCatalog.type, got: type },
      'merged catalog type mismatch'
    );
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `Type mismatch for merged catalog ${id}`,
          description: `Expected ${mergedCatalog.type}, got ${type}`,
        },
      ],
    };
  }

  const parsedExtras = new ExtrasParser(extras);
  const requestedSkip = parsedExtras.skip || 0;
  const isSearchRequest = !!parsedExtras.search;
  const requestedGenre = parsedExtras.genre;
  const isLiveMerged = type === constants.TV_TYPE;

  const extrasForCacheKey = new ExtrasParser(extras);
  extrasForCacheKey.skip = undefined;
  const extrasCacheKeyPart = extrasForCacheKey.toString();

  const configHash = getSimpleTextHash(
    JSON.stringify({
      catalogIds: mergedCatalog.catalogIds,
      deduplicationMethods: mergedCatalog.deduplicationMethods,
      mergeMethod: mergedCatalog.mergeMethod,
    })
  );
  const baseCacheKey = `${id}-${ctx.userData.uuid}-${configHash}${extrasCacheKeyPart ? `-${extrasCacheKeyPart}` : ''}`;
  const skipCacheKey = `${baseCacheKey}-skip=${requestedSkip}`;

  let skipState: MergedCatalogSkipState | undefined;

  if (isLiveMerged || requestedSkip === 0) {
    skipState = { sourceSkips: {} };
    for (const encodedCatalogId of mergedCatalog.catalogIds) {
      skipState.sourceSkips[encodedCatalogId] = 0;
    }
  } else {
    skipState = await mergedCatalogCache.get(skipCacheKey);
    if (!skipState) {
      logger.warn(
        { id, skip: requestedSkip },
        'no cached skip state for merged catalog — cache may have expired or skip is invalid'
      );
      return { success: true, data: [], errors: [] };
    }
  }

  const nextSourceSkips: Record<string, number> = {
    ...skipState.sourceSkips,
  };

  const fetchPromises = mergedCatalog.catalogIds.map(
    async (encodedCatalogId: string) => {
      logger.debug({ encodedCatalogId }, 'handling merged catalog source');
      const params = new URLSearchParams(encodedCatalogId);
      const catalogId = params.get('id');
      const catalogType = params.get('type');
      if (!catalogId || !catalogType) {
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: false,
          skipped: false,
        };
      }

      const addonInstanceId = catalogId.split('.', 2)[0];
      const actualCatalogId = catalogId.split('.').slice(1).join('.');

      const catalogExtras = getCatalogExtras(
        ctx,
        addonInstanceId,
        actualCatalogId,
        catalogType
      );

      if (isSearchRequest && !catalogExtras?.some((e) => e.name === 'search')) {
        logger.debug(
          { encodedCatalogId, catalog: mergedCatalog.name },
          'skipping merged catalog source: no search support'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: true,
          skipped: true,
        };
      }

      if (
        requestedGenre &&
        requestedGenre !== 'None' &&
        type !== constants.TV_TYPE
      ) {
        const genreExtra = catalogExtras?.find((e) => e.name === 'genre');
        if (!genreExtra) {
          logger.debug(
            { encodedCatalogId, catalog: mergedCatalog.name },
            'skipping merged catalog source: no genre extra support'
          );
          return {
            encodedCatalogId,
            items: [],
            fetched: 0,
            success: true,
            skipped: true,
          };
        }
        if (genreExtra.options && genreExtra.options.length > 0) {
          const hasGenre = genreExtra.options.some(
            (opt) => opt === requestedGenre || opt === null
          );
          if (!hasGenre) {
            logger.debug(
              {
                encodedCatalogId,
                catalog: mergedCatalog.name,
                genre: requestedGenre,
              },
              'skipping merged catalog source: genre not offered'
            );
            return {
              encodedCatalogId,
              items: [],
              fetched: 0,
              success: true,
              skipped: true,
            };
          }
        }
      }

      const sourceSkip = skipState!.sourceSkips[encodedCatalogId] || 0;
      const supportsSkip = catalogSupportsSkip(catalogExtras);

      if (!supportsSkip && sourceSkip > 0) {
        logger.debug(
          { encodedCatalogId, catalog: mergedCatalog.name },
          'skipping merged catalog source: no skip support and already exhausted'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: true,
          skipped: true,
        };
      }

      const sourceExtras = new ExtrasParser(extras);
      if (type === constants.TV_TYPE) {
        sourceExtras.genre = undefined;
      }
      if (supportsSkip) {
        sourceExtras.skip = sourceSkip > 0 ? sourceSkip : undefined;
      } else {
        sourceExtras.skip = undefined;
      }

      const requiredExtras = catalogExtras?.filter((e) => e.isRequired);
      if (requiredExtras && requiredExtras.length > 0) {
        for (const reqExtra of requiredExtras) {
          if (!sourceExtras.has(reqExtra.name)) {
            logger.debug(
              {
                encodedCatalogId,
                catalog: mergedCatalog.name,
                extra: reqExtra.name,
              },
              'skipping merged catalog source: missing required extra'
            );
            return {
              encodedCatalogId,
              items: [],
              fetched: 0,
              success: true,
              skipped: true,
            };
          }
        }
      }

      logger.debug(
        {
          encodedCatalogId,
          addonInstanceId,
          catalogType,
          extras: sourceExtras.toString(),
        },
        'fetching merged catalog source'
      );

      const result =
        type === constants.TV_TYPE && supportsSkip
          ? await fetchAllLiveCatalogPages(
              ctx,
              addonInstanceId,
              actualCatalogId,
              catalogType,
              sourceExtras
            )
          : await fetchRawCatalogItems(
              ctx,
              addonInstanceId,
              actualCatalogId,
              catalogType,
              sourceExtras
            );

      if (!result.success) {
        logger.warn(
          {
            encodedCatalogId,
            catalog: mergedCatalog.name,
            skip: requestedSkip,
            err: result.error
              ? maskSensitiveInfo(result.error.description || '')
              : 'unknown',
          },
          'failed to fetch merged catalog source'
        );
        return {
          encodedCatalogId,
          items: [],
          fetched: 0,
          success: false,
          skipped: false,
        };
      }

      return {
        encodedCatalogId,
        items: result.items,
        metasDetailed: result.metasDetailed,
        fetched: result.metasDetailed?.length || result.items.length,
        success: true,
        skipped: false,
      };
    }
  );

  logger.debug(
    {
      catalog: mergedCatalog.name,
      skip: requestedSkip,
      sources: fetchPromises.length,
    },
    'fetching merged catalog'
  );

  const fetchResults = await Promise.all(fetchPromises);

  const nonSkippedResults = fetchResults.filter((r) => !r.skipped);
  const allFailed =
    nonSkippedResults.length > 0 && nonSkippedResults.every((r) => !r.success);
  if (allFailed) {
    logger.error(
      { catalog: mergedCatalog.name },
      'all sources failed for merged catalog'
    );
    return {
      success: false,
      data: [],
      errors: [
        {
          title: `All sources failed for merged catalog ${mergedCatalog.name}`,
          description:
            'Unable to fetch items from any source catalog. Please try again later.',
        },
      ],
    };
  }

  const itemsBySource: MetaPreview[][] = [];
  const detailedBySource: Meta[][] = [];
  const isGuide = type === constants.TV_TYPE && Boolean(parsedExtras.date);
  for (const {
    encodedCatalogId,
    items,
    metasDetailed,
    fetched,
    skipped,
  } of fetchResults) {
    if (skipped) continue;
    nextSourceSkips[encodedCatalogId] =
      (skipState.sourceSkips[encodedCatalogId] || 0) + fetched;
    if (isGuide) {
      detailedBySource.push(
        metasDetailed?.length ? metasDetailed : (items as Meta[])
      );
    } else {
      itemsBySource.push(items);
    }
  }

  if (isGuide) {
    let allDetailed = applyMergeMethod(
      detailedBySource,
      mergedCatalog.mergeMethod
    ) as Meta[];
    allDetailed = deduplicateLiveTvItems(ctx.userData, allDetailed);
    allDetailed = applyLiveTvCatalogOverlay(
      ctx,
      type,
      allDetailed,
      requestedGenre
    );
    if (isLiveMerged) {
      allDetailed = allDetailed.slice(requestedSkip);
    }
    const nextSkip = requestedSkip + allDetailed.length;
    if (allDetailed.length > 0) {
      await mergedCatalogCache.set(
        `${baseCacheKey}-skip=${nextSkip}`,
        { sourceSkips: nextSourceSkips },
        3600,
        true
      );
    }
    return {
      success: true,
      data: [],
      metasDetailed: allDetailed,
      errors: [],
    };
  }

  let allItems: MetaPreview[] = applyMergeMethod(
    itemsBySource,
    mergedCatalog.mergeMethod
  );

  logger.debug(
    { catalog: mergedCatalog.name, count: allItems.length },
    'merged catalog items before deduplication'
  );

  allItems = deduplicateMergedCatalog(
    allItems,
    mergedCatalog.deduplicationMethods
  );
  if (type === constants.TV_TYPE) {
    allItems = deduplicateLiveTvItems(ctx.userData, allItems);
  }

  const shuffleCacheKey = `${baseCacheKey}-skip=${requestedSkip}-shuffle`;

  allItems = await applyCatalogModifications(
    ctx,
    allItems,
    id,
    type,
    parsedExtras,
    shuffleCacheKey
  );

  if (type === constants.TV_TYPE) {
    const modification = ctx.userData.catalogModifications?.find(
      (mod) =>
        mod.id === id && (mod.type === type || mod.overrideType === type)
    );
    allItems = applyLiveTvCatalogOverlay(
      ctx,
      type,
      allItems,
      requestedGenre,
      !modification?.shuffle && !modification?.reverse
    );
    if (isLiveMerged) {
      allItems = allItems.slice(requestedSkip);
    }
  }

  const nextSkip = requestedSkip + allItems.length;

  if (allItems.length > 0) {
    const nextSkipCacheKey = `${baseCacheKey}-skip=${nextSkip}`;
    await mergedCatalogCache.set(
      nextSkipCacheKey,
      { sourceSkips: nextSourceSkips },
      3600,
      true
    );
  }

  logger.debug(
    {
      catalog: mergedCatalog.name,
      count: allItems.length,
      skip: requestedSkip,
      nextSkip,
      took: getTimeTakenSincePoint(start),
    },
    'merged catalog complete'
  );

  return { success: true, data: allItems, errors: [] };
}

export interface GetCatalogOptions {
  /**
   * Report upstream failures even on paginated (`skip`) requests. By default a
   * failed `skip` page is treated as the end of the list, which is right for
   * Stremio but hides real errors from the Channels scanner.
   */
  strictErrors?: boolean;
}

export async function getCatalog(
  ctx: AIOStreamsContext,
  type: string,
  id: string,
  extras?: string,
  options?: GetCatalogOptions
): Promise<AIOStreamsCatalogResponse> {
  logger.debug({ type, id, extras }, 'handling catalog request');

  if (isMergedCatalogId(id)) {
    const merged = await getMergedCatalog(ctx, type, id, extras);
    return {
      success: merged.success,
      data: merged.data,
      metasDetailed: merged.metasDetailed,
      errors: merged.errors,
    };
  }

  const addonInstanceId = id.split('.', 2)[0];
  const actualCatalogId = id.split('.').slice(1).join('.');

  const parsedExtras = new ExtrasParser(extras);
  const guideDate = parsedExtras.date;

  if (type === constants.TV_TYPE && guideDate) {
    const result = await fetchRawCatalogItems(
      ctx,
      addonInstanceId,
      actualCatalogId,
      type,
      parsedExtras
    );
    if (!result.success) {
      return {
        success: false,
        data: [],
        errors: result.error ? [result.error] : [],
      };
    }
    return {
      success: true,
      data: [],
      metasDetailed: applyLiveTvCatalogOverlay(
        ctx,
        type,
        (result.metasDetailed ?? []).filter((meta) =>
          isLiveChannelVisible(ctx.userData, meta.id)
        ),
        parsedExtras.genre
      ),
      errors: [],
    };
  }

  const result = await fetchRawCatalogItems(
    ctx,
    addonInstanceId,
    actualCatalogId,
    type,
    parsedExtras
  );

  if (!result.success) {
    if (!options?.strictErrors && extras && extras.includes('skip')) {
      return { success: true, data: [], errors: [] };
    }
    return {
      success: false,
      data: [],
      errors: result.error ? [result.error] : [],
    };
  }

  const shuffleCacheKey = `${type}-${actualCatalogId}-${parsedExtras?.toString() || ''}-${ctx.userData.uuid}`;

  const catalog = await applyCatalogModifications(
    ctx,
    result.items,
    id,
    type,
    parsedExtras,
    shuffleCacheKey
  );

  const modification = ctx.userData.catalogModifications?.find(
    (mod) =>
      mod.id === id && (mod.type === type || mod.overrideType === type)
  );

  return {
    success: true,
    data: isLiveChannelType(type)
      ? applyLiveTvCatalogOverlay(
          ctx,
          type,
          catalog.filter((item) => isLiveChannelVisible(ctx.userData, item.id)),
          parsedExtras.genre,
          !modification?.shuffle && !modification?.reverse
        )
      : catalog,
    errors: [],
  };
}
