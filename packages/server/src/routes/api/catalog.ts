import { Router, Request, Response, NextFunction } from 'express';
import { createResponse } from '../../utils/responses.js';
import { catalogApiRateLimiter } from '../../middlewares/ratelimit.js';
import { attachSession, injectAccessKey } from '../../middlewares/auth.js';
import {
  createLogger,
  UserData,
  AIOStreams,
  UserDataSchema,
  validateConfig,
  APIError,
  constants,
  UserRepository,
  mergeConfigs,
  getChannelMatchConfidence,
  isHighConfidenceChannelMatch,
  CHANNEL_LINK_STREAM_CONFIDENCE,
  bindsOwnCatalogStreams,
  findPossibleDuplicateChannels,
  catalogSupportsSkip,
  addonProvidesResource,
  decodeHtmlEntities,
  MANUAL_STREAM_ADDON_ID,
  isManualStreamSource,
  isLiveChannelType,
  normalizeChannelGroup,
  parseDeclaredStreamInfo,
  type DeclaredStreamInfo,
} from '@aiolivetv/core';

const router: Router = Router();

const logger = createLogger('server');
const MAX_CHANNELS_PER_CATALOG = 10_000;
const MAX_STREAM_ONLY_CANDIDATES = 2_000;
const MAX_CATALOG_PAGES = 50;
const MAX_AUTO_MATCH_PAIRS = 5_000_000;

type CatalogPageItem = {
  id: string;
  name?: string | null;
  poster?: string | null;
  tvgId?: string;
  aliases?: string[];
  country?: string;
  language?: string;
  genres?: string[] | null;
  videos?: Array<unknown> | null;
};

function catalogPageItems(response: {
  data: unknown[];
  metasDetailed?: unknown[];
}): CatalogPageItem[] {
  const items = response.metasDetailed?.length
    ? response.metasDetailed
    : response.data;
  return items as CatalogPageItem[];
}

function catalogErrorMessage(response: {
  errors: Array<{ title?: string; description?: string }>;
}) {
  const error = response.errors[0];
  return error?.description || error?.title || 'Catalog fetch failed';
}

router.use(catalogApiRateLimiter);
router.use(attachSession);

async function validateDraft(req: Request, userData: UserData) {
  let configToValidate: UserData = userData;
  if (userData.parentConfig?.uuid) {
    let parent: UserData;
    try {
      const rawParent = await UserRepository.getRawUser(
        userData.parentConfig.uuid,
        userData.parentConfig.password
      );
      if (!rawParent) throw new Error('Parent config not found');
      parent = rawParent;
    } catch (error) {
      throw new APIError(
        constants.ErrorCode.PARENT_CONFIG_UNAVAILABLE,
        undefined,
        error instanceof APIError ? error.message : String(error)
      );
    }
    const merged = mergeConfigs(parent, userData);
    merged.trusted = parent.trusted || userData.trusted;
    configToValidate = merged;
  }

  injectAccessKey(req, configToValidate);

  try {
    return await validateConfig(configToValidate, {
      skipErrorsFromAddonsOrProxies: false,
      decryptValues: true,
      increasedManifestTimeout: true,
      bypassManifestCache: true,
    });
  } catch (error) {
    if (
      error instanceof APIError &&
      error.code === constants.ErrorCode.ADDON_PASSWORD_INVALID
    ) {
      throw new APIError(
        constants.ErrorCode.ADDON_PASSWORD_INVALID,
        undefined,
        'Please make sure the addon password is provided and correct by attempting to create/save a user first'
      );
    }
    throw new APIError(
      constants.ErrorCode.USER_INVALID_CONFIG,
      undefined,
      error instanceof Error ? error.message : undefined
    );
  }
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const { userData } = req.body;
  try {
    const validatedUserData = await validateDraft(req, userData);
    validatedUserData.catalogModifications = undefined;

    const aio = new AIOStreams(validatedUserData);
    await aio.initialise();
    // return minimal catalog data
    const catalogs = aio.getCatalogs().map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      type: catalog.type,
      addonName: aio.getAddon(catalog.id.split('.')[0])?.name,

      hideable: catalog.extra
        ? catalog.extra.every((e) => !e.isRequired)
        : true,
      searchable: catalog.extra
        ? catalog.extra?.findIndex(
            (e) => e.name === 'search' && !e.isRequired
          ) !== -1
        : false,
    }));
    res.status(200).json(createResponse({ success: true, data: catalogs }));
  } catch (error) {
    if (error instanceof APIError) {
      next(error);
    } else {
      next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
    }
  }
});

router.post(
  '/channels',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const autoMatch = req.body.autoMatch === true;
      const validatedUserData = await validateDraft(req, req.body.userData);
      const configuredMappings = validatedUserData.channelMappings ?? [];
      validatedUserData.channelMappings = undefined;
      const hiddenChannelIds = new Set(
        configuredMappings.filter((mapping) => mapping.hidden).map((mapping) => mapping.id)
      );

      const aio = await new AIOStreams(validatedUserData).initialise();
      type Candidate = {
        id: string;
        name: string;
        poster?: string | null;
        addonId: string;
        addonName: string;
        epgProvider: boolean;
        canStream: boolean;
        contributesChannels: boolean;
        tvgId?: string;
        aliases?: string[];
        country?: string;
        language?: string;
        categories?: string[];
      };
      type Channel = {
        id: string;
        name: string;
        poster?: string | null;
        canonicalAddonId: string;
        enabled: boolean;
        epgProvider: boolean;
        group?: string;
        sourceGroup?: string;
        rejectedStreams: Array<{ addonId: string; channelId: string }>;
        mappings: Array<
          Candidate & {
            channelId: string;
            confidence: number;
            enabled: boolean;
            url?: string;
            headers?: Record<string, string>;
            resolution?: string;
            encode?: string;
            quality?: string;
            languages?: string[];
            audioChannels?: string[];
            visualTags?: string[];
            declared?: DeclaredStreamInfo | null;
          }
        >;
        availableStreamSources: Array<{
          addonId: string;
          addonName: string;
          channelId: string;
          name: string;
          poster?: string | null;
          confidence: number;
        }>;
      };
      type SourceDiagnostic = {
        instanceId: string;
        name: string;
        presetType?: string;
        contributesChannels: boolean;
        canStream: boolean;
        epgProvider: boolean;
        ok: boolean;
        error?: string;
        durationMs: number;
        fetchedAt: string;
        channelCount: number;
        streamCount: number;
        programCount?: number;
      };
      type UnavailableStream = {
        channelId: string;
        channelName: string;
        addonId: string;
        addonName: string;
        streamChannelId: string;
        name: string;
        reason: string;
      };
      const candidates = new Map<string, Candidate>();
      const rejectedPairs = new Set(
        configuredMappings.flatMap((mapping) =>
          (mapping.rejectedStreams ?? []).map(
            (rejected) =>
              `${mapping.id}\0${rejected.addonId}\0${rejected.channelId}`
          )
        )
      );
      const isRejected = (channelId: string, candidate: Candidate) =>
        rejectedPairs.has(
          `${channelId}\0${candidate.addonId}\0${candidate.id}`
        );

      const sources = new Map<string, SourceDiagnostic>();
      const todayUtc = new Date().toISOString().slice(0, 10);

      for (const addon of aio.getAddons()) {
        const instanceId = addon.instanceId;
        if (!instanceId) continue;
        const startedAt = Date.now();
        const manifest = aio.getManifest(instanceId);
        if (!manifest) continue;
        const contributesChannels = addonProvidesResource(addon, 'catalog');
        const supportsStream = manifest.resources.some((resource) =>
          typeof resource === 'string'
            ? resource === 'stream'
            : resource.name === 'stream'
        );
        const canStream =
          supportsStream && addonProvidesResource(addon, 'stream');
        if (!contributesChannels && !canStream) continue;
        const epgProvider = manifest.behaviorHints?.epgProvider === true;
        const includeGuide =
          epgProvider &&
          addon.preset.type === 'xmltv' &&
          manifest.catalogs.some((item) =>
            item.extra?.some((extra) => extra.name === 'date')
          );
        const diagnostic: SourceDiagnostic = {
          instanceId,
          name: addon.name,
          presetType: addon.preset.type,
          contributesChannels,
          canStream,
          epgProvider,
          ok: true,
          durationMs: 0,
          fetchedAt: new Date().toISOString(),
          channelCount: 0,
          streamCount: 0,
        };
        sources.set(instanceId, diagnostic);

        for (const catalog of manifest.catalogs.filter((item) =>
          isLiveChannelType(item.type)
        )) {
          const addonId = instanceId;
          const catalogId = `${addonId}.${catalog.id}`;
          const paginated = catalogSupportsSkip(catalog.extra);
          const maxCandidates = contributesChannels
            ? MAX_CHANNELS_PER_CATALOG
            : MAX_STREAM_ONLY_CANDIDATES;
          const catalogHasDate = catalog.extra?.some(
            (extra) => extra.name === 'date'
          );
          let skip = 0;
          let page = 0;
          let addonCandidateCount = 0;
          const seenCatalogItems = new Set<string>();
          while (true) {
            page++;
            if (page > MAX_CATALOG_PAGES || addonCandidateCount >= maxCandidates) {
              break;
            }
            const extras = [
              paginated ? `skip=${skip}` : undefined,
              includeGuide && catalogHasDate ? `date=${todayUtc}` : undefined,
            ]
              .filter(Boolean)
              .join('&');
            const response = await aio.getCatalog(
              catalog.type,
              catalogId,
              extras || undefined
            );
            if (!response.success) {
              diagnostic.ok = false;
              diagnostic.error = catalogErrorMessage(response);
              break;
            }
            const items = catalogPageItems(response);
            let added = 0;
            for (const item of items) {
              if (addonCandidateCount >= maxCandidates) break;
              if (seenCatalogItems.has(item.id)) continue;
              seenCatalogItems.add(item.id);
              added++;
              if (Array.isArray(item.videos) && item.videos.length > 0) {
                diagnostic.programCount =
                  (diagnostic.programCount ?? 0) + item.videos.length;
              }
              const key = `${addonId}\0${item.id}`;
              if (candidates.has(key)) continue;
              addonCandidateCount++;
              candidates.set(key, {
                id: item.id,
                name: decodeHtmlEntities(item.name ?? item.id),
                poster: item.poster,
                addonId,
                addonName: addon.name,
                epgProvider,
                canStream,
                contributesChannels,
                tvgId: typeof item.tvgId === 'string' ? item.tvgId : undefined,
                aliases: Array.isArray(item.aliases)
                  ? item.aliases.map((alias) => decodeHtmlEntities(alias))
                  : undefined,
                country:
                  typeof item.country === 'string' ? item.country : undefined,
                language:
                  typeof item.language === 'string' ? item.language : undefined,
                categories: Array.isArray(item.genres) ? item.genres : undefined,
              });
            }
            if (
              !paginated ||
              items.length === 0 ||
              added === 0 ||
              addonCandidateCount >= maxCandidates ||
              skip + items.length >= MAX_CHANNELS_PER_CATALOG
            )
              break;
            skip += items.length;
          }
          if (!diagnostic.ok) break;
        }
        diagnostic.durationMs = Date.now() - startedAt;
        diagnostic.fetchedAt = new Date().toISOString();
      }

      for (const entry of aio.getInitialisationErrors()) {
        const instanceId = entry.addon.instanceId;
        if (!instanceId || sources.has(instanceId)) continue;
        const presetType =
          'preset' in entry.addon
            ? entry.addon.preset.type
            : 'type' in entry.addon
              ? entry.addon.type
              : undefined;
        sources.set(instanceId, {
          instanceId,
          name:
            'name' in entry.addon && entry.addon.name
              ? entry.addon.name
              : presetType || instanceId,
          presetType,
          contributesChannels: false,
          canStream: false,
          epgProvider: false,
          ok: false,
          error: entry.error,
          durationMs: 0,
          fetchedAt: new Date().toISOString(),
          channelCount: 0,
          streamCount: 0,
        });
      }

      const streamCandidates = [...candidates.values()].filter(
        (candidate) => candidate.canStream
      );
      for (const candidate of candidates.values()) {
        const source = sources.get(candidate.addonId);
        if (!source) continue;
        if (candidate.contributesChannels) source.channelCount += 1;
        if (candidate.canStream) source.streamCount += 1;
      }
      const channels: Channel[] = [];
      const unavailableStreams: UnavailableStream[] = [];
      const assigned = new Set<string>();
      const candidateKey = (addonId: string, channelId: string) =>
        `${addonId}\0${channelId}`;
      const resolveCanonical = (
        channel: Pick<Channel, 'id' | 'name' | 'poster' | 'canonicalAddonId'>
      ): Candidate => {
        const fromCatalog = candidates.get(
          candidateKey(channel.canonicalAddonId, channel.id)
        );
        if (fromCatalog) return fromCatalog;
        const addon = aio.getAddon(channel.canonicalAddonId);
        return {
          id: channel.id,
          name: channel.name,
          poster: channel.poster,
          addonId: channel.canonicalAddonId,
          addonName: addon?.name ?? channel.canonicalAddonId,
          epgProvider: false,
          canStream: false,
          contributesChannels: true,
        };
      };
      const declaredForCandidate = (candidate: Pick<Candidate, 'name' | 'categories'>) =>
        parseDeclaredStreamInfo({
          name: candidate.name,
          group: candidate.categories?.[0],
        }) ?? null;
      const addStreamSource = (
        channel: Channel,
        candidate: Candidate,
        confidence: number,
        enabled = true
      ) => {
        if (!candidate.canStream) return;
        channel.mappings.push({
          ...candidate,
          channelId: candidate.id,
          confidence,
          enabled,
          declared: declaredForCandidate(candidate),
        });
        assigned.add(candidateKey(candidate.addonId, candidate.id));
      };
      const addManualStreamSource = (
        channel: Channel,
        source: {
          channelId: string;
          url: string;
          name?: string;
          confidence?: number;
          enabled?: boolean;
          headers?: Record<string, string>;
          resolution?: string;
          encode?: string;
          quality?: string;
          languages?: string[];
          audioChannels?: string[];
          visualTags?: string[];
        }
      ) => {
        const label = source.name ?? 'Manual HLS';
        const declared =
          parseDeclaredStreamInfo({
            name: [label, source.resolution, source.encode]
              .filter(Boolean)
              .join(' '),
          }) ?? null;
        channel.mappings.push({
          id: source.channelId,
          addonId: MANUAL_STREAM_ADDON_ID,
          addonName: 'Manual HLS',
          channelId: source.channelId,
          name: label,
          url: source.url,
          poster: null,
          epgProvider: false,
          canStream: true,
          contributesChannels: false,
          confidence: source.confidence ?? 0,
          enabled: source.enabled !== false,
          headers: source.headers,
          resolution: source.resolution,
          encode: source.encode,
          quality: source.quality,
          languages: source.languages,
          audioChannels: source.audioChannels,
          visualTags: source.visualTags,
          declared,
        });
      };
      const markChannelAssigned = (candidate: Candidate) => {
        assigned.add(candidateKey(candidate.addonId, candidate.id));
      };
      const addConfiguredStreamSource = (
        channel: Channel,
        source: {
          addonId: string;
          channelId: string;
          name?: string;
          confidence?: number;
          enabled?: boolean;
        },
        candidate?: Candidate
      ) => {
        if (candidate?.canStream) {
          addStreamSource(
            channel,
            candidate,
            source.confidence ?? 0,
            source.enabled !== false
          );
          return;
        }
        const addon = aio.getAddon(source.addonId);
        channel.mappings.push({
          id: source.channelId,
          addonId: source.addonId,
          addonName: addon?.name ?? source.addonId,
          channelId: source.channelId,
          name: source.name ?? source.channelId,
          poster: null,
          epgProvider: false,
          canStream: true,
          contributesChannels: false,
          confidence: source.confidence ?? 1,
          enabled: source.enabled !== false,
          declared: source.name
            ? (parseDeclaredStreamInfo({ name: source.name }) ?? null)
            : null,
        });
      };
      const buildAvailableStreamSources = (channel: Channel) => {
        const used = new Set(
          channel.mappings.map(
            (mapping) => `${mapping.addonId}\0${mapping.channelId}`
          )
        );
        const canonical = resolveCanonical(channel);
        return streamCandidates
          .flatMap((candidate) => {
            if (
              used.has(`${candidate.addonId}\0${candidate.id}`) ||
              isRejected(channel.id, candidate)
            ) {
              return [];
            }
            const confidence = getChannelMatchConfidence(
              { ...candidate, logo: candidate.poster ?? undefined },
              { ...canonical, logo: canonical.poster ?? undefined }
            );
            if (confidence < CHANNEL_LINK_STREAM_CONFIDENCE) return [];
            return [
              {
                addonId: candidate.addonId,
                addonName: candidate.addonName,
                channelId: candidate.id,
                name: candidate.name,
                poster: candidate.poster,
                confidence,
              },
            ];
          })
          .sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            return a.name.localeCompare(b.name, undefined, {
              sensitivity: 'base',
            });
          });
      };

      for (const configured of configuredMappings) {
        if (configured.hidden) continue;
        const manualSources =
          configured.streams?.filter((source) => isManualStreamSource(source)) ??
          [];
        const streamSources =
          configured.streams?.flatMap((source) => {
            if (isManualStreamSource(source)) return [];
            const candidate = source.channelId
              ? candidates.get(candidateKey(source.addonId, source.channelId))
              : undefined;
            return candidate?.canStream ? [{ candidate, source }] : [];
          }) ?? [];
        for (const source of configured.streams ?? []) {
          if (isManualStreamSource(source) || !source.channelId) continue;
          const candidate = candidates.get(
            candidateKey(source.addonId, source.channelId)
          );
          if (candidate?.canStream) continue;
          const sourceDiag = sources.get(source.addonId);
          unavailableStreams.push({
            channelId: configured.id,
            channelName: configured.name ?? configured.id,
            addonId: source.addonId,
            addonName:
              sourceDiag?.name ??
              aio.getAddon(source.addonId)?.name ??
              source.addonId,
            streamChannelId: source.channelId,
            name: source.name ?? source.channelId,
            reason: sourceDiag?.error
              ? sourceDiag.error
              : candidate
                ? 'Source does not provide streams'
                : 'Stream was not returned by the source',
          });
        }
        const canonical =
          (configured.canonicalAddonId
            ? candidates.get(
                candidateKey(configured.canonicalAddonId, configured.id)
              )
            : undefined) ??
          streamSources.find(
            ({ candidate }) => candidate.id === configured.id
          )?.candidate;
        if (!canonical && manualSources.length === 0) continue;
        const channel: Channel = {
          id: configured.id,
          name: configured.name ?? canonical?.name ?? configured.id,
          poster: configured.poster ?? canonical?.poster,
          canonicalAddonId:
            configured.canonicalAddonId ?? canonical?.addonId ?? configured.id,
          enabled: configured.enabled !== false,
          epgProvider: canonical?.epgProvider === true,
          rejectedStreams: configured.rejectedStreams ?? [],
          mappings: [],
          availableStreamSources: [],
        };
        for (const source of manualSources) {
          if (!source.url || !source.channelId) continue;
          addManualStreamSource(channel, {
            channelId: source.channelId,
            url: source.url,
            name: source.name,
            confidence: source.confidence,
            enabled: source.enabled,
            headers: source.headers,
            resolution: source.resolution,
            encode: source.encode,
            quality: source.quality,
            languages: source.languages,
            audioChannels: source.audioChannels,
            visualTags: source.visualTags,
          });
        }
        for (const { candidate, source } of streamSources) {
          addConfiguredStreamSource(channel, source, candidate);
        }
        markChannelAssigned(canonical ?? {
          id: configured.id,
          name: channel.name,
          poster: channel.poster,
          addonId: channel.canonicalAddonId,
          addonName: aio.getAddon(channel.canonicalAddonId)?.name ?? 'Channel',
          epgProvider: false,
          canStream: false,
          contributesChannels: true,
        });
        channels.push(channel);
      }

      // ponytail: O(n²) is adequate for configuration-time channel lists;
      // index normalized fields only if real guides make this measurably slow.
      // Pass 1: catalog-defined channels stay separate so the user can hide
      // duplicates per provider. Catalog+stream builtins already bind playback
      // to the same channel id — skip name/tvg proximity.
      for (const candidate of candidates.values()) {
        if (hiddenChannelIds.has(candidate.id)) continue;
        if (!candidate.contributesChannels) continue;
        if (assigned.has(candidateKey(candidate.addonId, candidate.id))) continue;
        const channel: Channel = {
          id: candidate.id,
          name: candidate.name,
          poster: candidate.poster,
          canonicalAddonId: candidate.addonId,
          enabled: true,
          epgProvider: candidate.epgProvider,
          rejectedStreams: [],
          mappings: [],
          availableStreamSources: [],
        };
        if (
          bindsOwnCatalogStreams(candidate) &&
          !isRejected(candidate.id, candidate)
        ) {
          addStreamSource(channel, candidate, 1);
        } else {
          markChannelAssigned(candidate);
        }
        channels.push(channel);
      }

      // Pass 2: stream-only sources. Match those onto existing channels.
      if (autoMatch) {
        const autoMatchStreams =
          streamCandidates.length * channels.length <= MAX_AUTO_MATCH_PAIRS;
        for (const candidate of streamCandidates.sort(
          (a, b) => Number(b.epgProvider) - Number(a.epgProvider)
        )) {
          if (hiddenChannelIds.has(candidate.id)) continue;
          if (bindsOwnCatalogStreams(candidate)) continue;
          if (assigned.has(candidateKey(candidate.addonId, candidate.id))) continue;
          let best: { channel: Channel; confidence: number } | undefined;
          let suggestion: { channel: Channel; confidence: number } | undefined;
          if (autoMatchStreams) {
            for (const channel of channels) {
              if (
                channel.mappings.some(
                  (mapping) =>
                    mapping.addonId === candidate.addonId &&
                    mapping.channelId === candidate.id
                )
              )
                continue;
              const canonical = resolveCanonical(channel);
              const confidence = getChannelMatchConfidence(
                { ...candidate, logo: candidate.poster ?? undefined },
                { ...canonical, logo: canonical.poster ?? undefined }
              );
              if (
                confidence > 0 &&
                (!suggestion || confidence > suggestion.confidence)
              ) {
                suggestion = { channel, confidence };
              }
              if (
                isHighConfidenceChannelMatch(confidence) &&
                (!best || confidence > best.confidence)
              )
                best = { channel, confidence };
            }
          }
          if (best) {
            if (!isRejected(best.channel.id, candidate)) {
              addStreamSource(best.channel, candidate, 1);
            }
          } else if (
            suggestion &&
            suggestion.confidence > 0 &&
            !isRejected(suggestion.channel.id, candidate)
          ) {
            addStreamSource(
              suggestion.channel,
              candidate,
              suggestion.confidence
            );
          } else if (candidate.contributesChannels) {
            const channel: Channel = {
              id: candidate.id,
              name: candidate.name,
              poster: candidate.poster,
              canonicalAddonId: candidate.addonId,
              enabled: true,
              epgProvider: candidate.epgProvider,
              rejectedStreams: [],
              mappings: [],
              availableStreamSources: [],
            };
            addStreamSource(channel, candidate, 1);
            channels.push(channel);
          }
        }
      }

      const catalogById = new Map<string, Candidate>();
      for (const candidate of candidates.values()) {
        if (!catalogById.has(candidate.id)) {
          catalogById.set(candidate.id, candidate);
        }
      }
      const removedChannels = configuredMappings
        .filter((mapping) => mapping.hidden)
        .map((mapping) => {
          const candidate = catalogById.get(mapping.id);
          return {
            id: mapping.id,
            name:
              mapping.name?.trim() ||
              candidate?.name?.trim() ||
              mapping.id,
            poster: mapping.poster || candidate?.poster || undefined,
            sourceName: candidate?.addonName,
          };
        })
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );

      const visibleChannels = channels
        .filter((channel) => !hiddenChannelIds.has(channel.id))
        .map((channel) => {
          const canonical = resolveCanonical(channel);
          const configured = configuredMappings.find(
            (mapping) => mapping.id === channel.id
          );
          const sourceGroup = normalizeChannelGroup(
            canonical.categories?.[0] ??
              channel.mappings.find((mapping) => mapping.categories?.[0])
                ?.categories?.[0]
          );
          return {
            ...channel,
            sourceName:
              canonical.addonName ||
              sources.get(channel.canonicalAddonId)?.name ||
              undefined,
            sourceGroup,
            group: normalizeChannelGroup(configured?.group) ?? sourceGroup,
            epgProvider:
              canonical.epgProvider ||
              channel.mappings.some((mapping) => mapping.epgProvider),
            availableStreamSources: buildAvailableStreamSources(channel),
          };
        })
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );
      res.status(200).json(
        createResponse({
          success: true,
          data: {
            channels: visibleChannels,
            sources: [...sources.values()].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
            ),
            unmatchedStreams: [],
            unavailableStreams,
            duplicates: findPossibleDuplicateChannels(visibleChannels),
            removedChannels,
          },
        })
      );
    } catch (error) {
      next(
        error instanceof APIError
          ? error
          : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
      );
    }
  }
);

export default router;
