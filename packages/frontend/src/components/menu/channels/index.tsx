import React from 'react';
import { BiRefresh, BiUndo } from 'react-icons/bi';
import {
  LuArrowDownAZ,
  LuLayers,
  LuPower,
  LuPowerOff,
  LuSquareCheck,
  LuTrash2,
} from 'react-icons/lu';
import { SearchIcon } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageControls } from '@/components/shared/page-controls';
import { PageWrapper } from '@/components/shared/page-wrapper';
import { SettingsCard } from '@/components/shared/settings-card';
import { Button, IconButton } from '@/components/ui/button';
import { LoadingSpinner, Spinner } from '@/components/ui/loading-spinner';
import { TextInput } from '@/components/ui/text-input';
import { Select } from '@/components/ui/select';
import { StaticTabs } from '@/components/ui/tabs';
import { useUserData } from '@/context/userData';
import { useDisclosure } from '@/hooks/disclosure';
import { fetchChannels, type ChannelInfo, type ChannelsResponse } from '@/lib/api';
import { ChannelEditModal } from './_components/channel-edit-modal';
import { ChannelListItem } from './_components/channel-list-item';
import { ChannelMappingModal } from './_components/channel-mapping-modal';
import { ManualHlsModal } from './_components/manual-hls-modal';
import { NeedsReviewCard } from './_components/needs-review';
import { RemovedChannelsCard } from './_components/removed-channels';
import {
  type ChannelReviewFilter,
  type ChannelSortMode,
  countSuggestions,
  asChannelsResponse,
  filterChannelsByReview,
  findDuplicateGroups,
  getRemovedChannels,
  isChannelSuggestion,
  isManualStreamMapping,
  buildManualStreamChannelId,
  persistableManualStreamFields,
  declaredFromManualDetails,
  type ManualHlsDetails,
  sortChannels,
  groupChannelsBySource,
  channelHasPlayableStream,
  channelHasSchedule,
  MANUAL_STREAM_ADDON_ID,
  normalizeChannelGroup,
  parseStreamSourceKey,
} from './utils';

export function ChannelsMenu() {
  const { userData, setUserData } = useUserData();
  const [search, setSearch] = React.useState('');
  const [groupFilter, setGroupFilter] = React.useState('');
  const [sortMode, setSortMode] =
    React.useState<ChannelSortMode>('alphabetical');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [linkStreamTargets, setLinkStreamTargets] = React.useState<
    Record<string, string>
  >({});
  const [customizedIds, setCustomizedIds] = React.useState<Set<string>>(
    () =>
      new Set(
        (userData.channelMappings ?? [])
          .filter((mapping) => mapping.name || mapping.poster || mapping.group)
          .map((mapping) => mapping.id)
      )
  );
  const [mappingChannelId, setMappingChannelId] = React.useState<string | null>(
    null
  );
  const [editChannelId, setEditChannelId] = React.useState<string | null>(null);
  const [isMatchingStreams, setIsMatchingStreams] = React.useState(false);
  const [reviewFilter, setReviewFilter] =
    React.useState<ChannelReviewFilter>('all');
  const [channelsTab, setChannelsTab] = React.useState<'my' | 'removed'>('my');
  const mappingModal = useDisclosure(false);
  const editModal = useDisclosure(false);
  const manualHlsModal = useDisclosure(false);
  const [editingManualStream, setEditingManualStream] = React.useState<
    ChannelInfo['mappings'][number] | null
  >(null);
  const queryClient = useQueryClient();
  const userDataRef = React.useRef(userData);
  userDataRef.current = userData;
  const channelsConfigKey = JSON.stringify({
    presets: userData.presets,
    services: userData.services,
    parentConfig: userData.parentConfig,
  });
  const queryKey = ['channels', channelsConfigKey] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchChannels(userDataRef.current, { autoMatch: false, signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const refreshStreamMappings = React.useCallback(async () => {
    setIsMatchingStreams(true);
    setRefreshError(null);
    try {
      const data = await fetchChannels(userDataRef.current, {
        autoMatch: true,
      });
      queryClient.setQueryData(queryKey, data);
    } catch (error) {
      // Keep the channels already on screen; just say why the refresh failed.
      setRefreshError(
        error instanceof Error ? error.message : 'Channel refresh failed'
      );
    } finally {
      setIsMatchingStreams(false);
    }
  }, [queryClient, queryKey]);
  const channelsResponse = asChannelsResponse(query.data);
  const channels = channelsResponse.channels;
  const removedChannels = getRemovedChannels(
    userData.channelMappings,
    channelsResponse.removedChannels
  );
  const isInitialLoading = query.isPending && channels.length === 0;
  const sourceProblems = channelsResponse.sources.filter(
    (source) => !source.ok || source.truncated
  );
  const sourcesWithSkippedCatalogs = channelsResponse.sources.filter(
    (source) => (source.skippedCatalogs?.length ?? 0) > 0
  );
  const suggestionCount = countSuggestions(channels);
  const duplicateGroups = findDuplicateGroups(channels);
  const duplicateIds = React.useMemo(
    () => new Set(duplicateGroups.flatMap((group) => group.channelIds)),
    [duplicateGroups]
  );
  const noStreamCount = channels.filter(
    (channel) => channel.enabled && !channelHasPlayableStream(channel)
  ).length;
  const noScheduleCount = channels.filter(
    (channel) => channel.enabled && !channelHasSchedule(channel)
  ).length;

  const buildVisibleMappings = React.useCallback(
    (
      nextChannels: ChannelInfo[],
      currentMappings: typeof userData.channelMappings,
      extraCustomizedIds?: Iterable<string>
    ) => {
      const customized = new Set(customizedIds);
      for (const id of extraCustomizedIds ?? []) customized.add(id);

      return nextChannels.flatMap((channel) => {
        const existing = currentMappings?.find(
          (mapping) => mapping.id === channel.id
        );
        const isCustomized = Boolean(
          customized.has(channel.id) ||
            existing?.name ||
            existing?.poster ||
            existing?.group ||
            (channel.group && channel.group !== channel.sourceGroup)
        );
        const streams = channel.mappings
          .filter((mapping) => !isChannelSuggestion(mapping.confidence))
          .map((mapping) => ({
            addonId: mapping.addonId,
            channelId: mapping.channelId,
            confidence: mapping.confidence,
            enabled: mapping.enabled,
            ...(mapping.url
              ? persistableManualStreamFields({
                  url: mapping.url,
                  name: mapping.name,
                  headers: mapping.headers,
                  resolution: mapping.resolution,
                  encode: mapping.encode,
                  quality: mapping.quality,
                  languages: mapping.languages,
                  audioChannels: mapping.audioChannels,
                  visualTags: mapping.visualTags,
                })
              : {}),
          }));
        const rejectedStreams = channel.rejectedStreams?.length
          ? channel.rejectedStreams
          : undefined;
        if (
          channel.enabled &&
          streams.length === 0 &&
          !rejectedStreams?.length &&
          !isCustomized
        ) {
          return [];
        }
        return [
          {
            id: channel.id,
            canonicalAddonId: channel.canonicalAddonId,
            enabled: channel.enabled,
            ...(isCustomized
              ? {
                  name: channel.name,
                  poster: channel.poster ?? undefined,
                  ...(channel.group && channel.group !== channel.sourceGroup
                    ? { group: channel.group }
                    : {}),
                }
              : {}),
            rejectedStreams,
            streams,
          },
        ];
      });
    },
    [customizedIds]
  );

  const persistChannels = React.useCallback(
    (nextChannels: ChannelInfo[], extraCustomizedIds?: Iterable<string>) => {
      setUserData((current) => {
        const visibleMappings = buildVisibleMappings(
          nextChannels,
          current.channelMappings,
          extraCustomizedIds
        );
        const hidden = (current.channelMappings ?? []).filter(
          (mapping) =>
            mapping.hidden &&
            !visibleMappings.some((item) => item.id === mapping.id)
        );
        const channelMappings = [...visibleMappings, ...hidden];
        if (
          JSON.stringify(current.channelMappings ?? []) ===
          JSON.stringify(channelMappings)
        ) {
          return current;
        }
        return { ...current, channelMappings };
      });
    },
    [buildVisibleMappings, setUserData]
  );

  const setChannels = (
    update: (channels: ChannelInfo[]) => ChannelInfo[],
    extraCustomizedIds?: Iterable<string>
  ) => {
    const current = asChannelsResponse(
      queryClient.getQueryData<ChannelsResponse>(queryKey)
    );
    const nextChannels = update(current.channels);
    queryClient.setQueryData(queryKey, {
      ...current,
      channels: nextChannels,
    });
    persistChannels(nextChannels, extraCustomizedIds);
  };

  const acceptSuggestion = (
    channelId: string,
    addonId: string,
    streamChannelId: string
  ) => {
    setChannels((current) =>
      current.map((channel) =>
        channel.id === channelId
          ? {
              ...channel,
              mappings: channel.mappings.map((mapping) =>
                mapping.addonId === addonId &&
                mapping.channelId === streamChannelId
                  ? { ...mapping, confidence: 1 }
                  : mapping
              ),
            }
          : channel
      )
    );
  };

  const rejectSuggestion = (
    channelId: string,
    addonId: string,
    streamChannelId: string
  ) => {
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const mapping = channel.mappings.find(
          (item) =>
            item.addonId === addonId && item.channelId === streamChannelId
        );
        if (!mapping) return channel;
        return {
          ...channel,
          mappings: channel.mappings.filter(
            (item) =>
              !(item.addonId === addonId && item.channelId === streamChannelId)
          ),
          rejectedStreams: [
            ...(channel.rejectedStreams ?? []),
            { addonId, channelId: mapping.channelId },
          ],
        };
      })
    );
  };

  const acceptAllSuggestions = (channelId: string) => {
    setChannels((current) =>
      current.map((channel) =>
        channel.id === channelId
          ? {
              ...channel,
              mappings: channel.mappings.map((mapping) =>
                isChannelSuggestion(mapping.confidence)
                  ? { ...mapping, confidence: 1 }
                  : mapping
              ),
            }
          : channel
      )
    );
  };

  const rejectAllSuggestions = (channelId: string) => {
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const suggestions = channel.mappings.filter((mapping) =>
          isChannelSuggestion(mapping.confidence)
        );
        if (suggestions.length === 0) return channel;
        const existing = new Set(
          (channel.rejectedStreams ?? []).map(
            (rejected) => `${rejected.addonId}\0${rejected.channelId}`
          )
        );
        const rejectedStreams = [
          ...(channel.rejectedStreams ?? []),
          ...suggestions
            .filter(
              (mapping) =>
                !existing.has(`${mapping.addonId}\0${mapping.channelId}`)
            )
            .map((mapping) => ({
              addonId: mapping.addonId,
              channelId: mapping.channelId,
            })),
        ];
        return {
          ...channel,
          mappings: channel.mappings.filter(
            (mapping) => !isChannelSuggestion(mapping.confidence)
          ),
          rejectedStreams,
        };
      })
    );
  };

  const moveMapping = (channelId: string, index: number, direction: -1 | 1) => {
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const target = index + direction;
        if (target < 0 || target >= channel.mappings.length) return channel;
        const mappings = [...channel.mappings];
        [mappings[index], mappings[target]] = [
          mappings[target],
          mappings[index],
        ];
        return { ...channel, mappings };
      })
    );
  };

  const splitMapping = (
    channelId: string,
    addonId: string,
    streamChannelId: string
  ) => {
    setChannels((current) => {
      const channel = current.find((item) => item.id === channelId);
      const mapping = channel?.mappings.find(
        (item) => item.addonId === addonId && item.channelId === streamChannelId
      );
      if (!channel || !mapping || channel.mappings.length === 1) return current;
      const withoutMapping = (item: ChannelInfo) =>
        item.id === channelId
          ? {
              ...item,
              mappings: item.mappings.filter(
                (candidate) =>
                  !(
                    candidate.addonId === addonId &&
                    candidate.channelId === streamChannelId
                  )
              ),
            }
          : item;
      if (isManualStreamMapping(mapping)) {
        return current.map(withoutMapping);
      }
      return current.map((item) => {
        const next = withoutMapping(item);
        if (item.id !== channelId) return next;
        return {
          ...next,
          availableStreamSources: [
            {
              addonId: mapping.addonId,
              addonName: mapping.addonName,
              channelId: mapping.channelId,
              name: mapping.name,
              poster: mapping.poster,
              confidence: mapping.confidence,
            },
            ...(item.availableStreamSources ?? []).filter(
              (source) =>
                !(
                  source.addonId === addonId &&
                  source.channelId === streamChannelId
                )
            ),
          ],
        };
      });
    });
  };

  const linkStreamSource = (channelId: string) => {
    const sourceKey = linkStreamTargets[channelId];
    if (!sourceKey) return;
    const parsed = parseStreamSourceKey(sourceKey);
    if (!parsed) return;
    const { addonId, streamChannelId } = parsed;
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const source =
          channel.availableStreamSources?.find(
            (item) =>
              item.addonId === addonId && item.channelId === streamChannelId
          ) ??
          channelsResponse.streamCatalog?.find(
            (item) =>
              item.addonId === addonId && item.channelId === streamChannelId
          );
        if (!source) return channel;
        return {
          ...channel,
          mappings: [
            ...channel.mappings,
            {
              id: source.channelId,
              addonId: source.addonId,
              addonName: source.addonName,
              channelId: source.channelId,
              name: source.name,
              poster: source.poster,
              confidence: 0,
              enabled: true,
              epgProvider: false,
              canStream: true,
            },
          ],
          availableStreamSources: channel.availableStreamSources?.filter(
            (item) =>
              !(item.addonId === addonId && item.channelId === streamChannelId)
          ),
        };
      })
    );
    setLinkStreamTargets((current) => ({ ...current, [channelId]: '' }));
  };

  const saveManualStream = (
    channelId: string,
    details: ManualHlsDetails,
    previousChannelId?: string
  ) => {
    const streamChannelId = buildManualStreamChannelId(details.url);
    const fields = persistableManualStreamFields(details);
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const duplicate = channel.mappings.some(
          (mapping) =>
            isManualStreamMapping(mapping) &&
            mapping.url === details.url &&
            mapping.channelId !== previousChannelId
        );
        if (duplicate) return channel;
        const nextMapping = {
          id: streamChannelId,
          addonId: MANUAL_STREAM_ADDON_ID,
          addonName: 'Manual HLS',
          channelId: streamChannelId,
          poster: null as string | null,
          confidence: 0,
          enabled: true,
          epgProvider: false,
          canStream: true,
          ...fields,
          declared: declaredFromManualDetails(details),
        };
        if (previousChannelId) {
          return {
            ...channel,
            mappings: channel.mappings.map((mapping) =>
              mapping.channelId === previousChannelId
                ? {
                    ...nextMapping,
                    poster: mapping.poster ?? null,
                    enabled: mapping.enabled,
                  }
                : mapping
            ),
          };
        }
        return {
          ...channel,
          mappings: [...channel.mappings, nextMapping],
        };
      })
    );
  };

  const setCanonical = (channelId: string, addonId: string) => {
    setChannels((current) =>
      current.map((channel) => {
        if (channel.id !== channelId) return channel;
        const mapping = channel.mappings.find(
          (candidate) => candidate.addonId === addonId
        );
        return mapping
          ? {
              ...channel,
              id: mapping.channelId,
              name: mapping.name,
              poster: mapping.poster,
              canonicalAddonId: mapping.addonId,
            }
          : channel;
      })
    );
  };

  const updateChannel = (
    channelId: string,
    update: (channel: ChannelInfo) => ChannelInfo,
    extraCustomizedIds?: Iterable<string>
  ) => {
    setChannels(
      (current) =>
        current.map((channel) =>
          channel.id === channelId ? update(channel) : channel
        ),
      extraCustomizedIds
    );
  };

  const removeChannels = (channelIds: Iterable<string>) => {
    const ids = new Set(channelIds);
    const nextChannels = channels.filter((channel) => !ids.has(channel.id));
    const currentResponse = asChannelsResponse(
      queryClient.getQueryData<ChannelsResponse>(queryKey)
    );
    queryClient.setQueryData(queryKey, {
      ...currentResponse,
      channels: nextChannels,
      removedChannels: [
        ...currentResponse.removedChannels.filter(
          (channel) => !ids.has(channel.id)
        ),
        ...[...ids].flatMap((id) => {
          const channel = channels.find((item) => item.id === id);
          return channel
            ? [
                {
                  id,
                  name: channel.name,
                  poster: channel.poster ?? undefined,
                  sourceName: channel.sourceName,
                },
              ]
            : [];
        }),
      ],
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setUserData((current) => {
      const visibleMappings = buildVisibleMappings(
        nextChannels,
        current.channelMappings
      );
      const hidden = [
        ...(current.channelMappings ?? []).filter(
          (mapping) => mapping.hidden && !ids.has(mapping.id)
        ),
        ...[...ids].map((id) => {
          const previous = current.channelMappings?.find(
            (mapping) => mapping.id === id
          );
          const channel = channels.find((item) => item.id === id);
          return {
            ...previous,
            id,
            hidden: true as const,
            enabled: false,
            name: channel?.name ?? previous?.name,
            poster: channel?.poster ?? previous?.poster ?? undefined,
            canonicalAddonId:
              channel?.canonicalAddonId ?? previous?.canonicalAddonId,
          };
        }),
      ];
      return { ...current, channelMappings: [...visibleMappings, ...hidden] };
    });
  };

  const restoreChannels = (channelIds: Iterable<string>) => {
    const ids = new Set(channelIds);
    const nextUserData = {
      ...userData,
      channelMappings: (userData.channelMappings ?? []).map((mapping) =>
        ids.has(mapping.id)
          ? { ...mapping, hidden: false, enabled: true }
          : mapping
      ),
    };
    userDataRef.current = nextUserData;
    setUserData(() => nextUserData);
    void queryClient.invalidateQueries({ queryKey });
  };

  const removeChannel = (channelId: string) => {
    removeChannels([channelId]);
  };

  const saveChannelEdit = (
    channelId: string,
    name: string,
    poster: string,
    group: string
  ) => {
    setCustomizedIds((current) => new Set(current).add(channelId));
    updateChannel(
      channelId,
      (channel) => ({
        ...channel,
        name,
        poster: poster || null,
        group: normalizeChannelGroup(group) || channel.sourceGroup,
      }),
      [channelId]
    );
  };

  const reviewedChannels = filterChannelsByReview(
    channels,
    reviewFilter,
    duplicateIds
  );
  const knownGroups = React.useMemo(() => {
    const groups = new Set<string>();
    for (const channel of channels) {
      if (channel.group) groups.add(channel.group);
    }
    return [...groups].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
  }, [channels]);
  const filteredChannels = sortChannels(
    reviewedChannels.filter((channel) => {
      if (
        search.trim() &&
        !channel.name.toLowerCase().includes(search.trim().toLowerCase())
      ) {
        return false;
      }
      if (groupFilter && channel.group !== groupFilter) return false;
      return true;
    }),
    sortMode
  );
  const groupedChannels =
    sortMode === 'source' ? groupChannelsBySource(filteredChannels) : null;
  const visibleIds = filteredChannels.map((channel) => channel.id);
  const isAllSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const hasSelection = selectedIds.size > 0;
  const selectedChannels = channels.filter((channel) =>
    selectedIds.has(channel.id)
  );
  const toggleWillEnable = selectedChannels.some((channel) => !channel.enabled);
  const mappingChannel =
    channels.find((channel) => channel.id === mappingChannelId) ?? null;
  const editChannel =
    channels.find((channel) => channel.id === editChannelId) ?? null;

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(visibleIds));
  };

  const toggleSelection = (channelId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const batchToggleEnabled = () => {
    const nextValue = toggleWillEnable;
    setChannels((current) =>
      current.map((channel) =>
        selectedIds.has(channel.id)
          ? { ...channel, enabled: nextValue }
          : channel
      )
    );
  };

  const batchRemove = () => {
    removeChannels(selectedIds);
    setSelectedIds(new Set());
  };

  const openMappings = (channelId: string) => {
    setMappingChannelId(channelId);
    mappingModal.open();
  };

  const openEdit = (channelId: string) => {
    setEditChannelId(channelId);
    editModal.open();
  };

  const renderChannel = (channel: ChannelInfo) => (
    <ChannelListItem
      key={channel.id}
      channel={channel}
      isSelected={selectedIds.has(channel.id)}
      onToggleSelect={() => toggleSelection(channel.id)}
      onToggleEnabled={(enabled) => {
        updateChannel(channel.id, (item) => ({ ...item, enabled }));
      }}
      onOpenMappings={() => openMappings(channel.id)}
      onEdit={() => openEdit(channel.id)}
      onRemove={() => removeChannel(channel.id)}
    />
  );

  return (
    <PageWrapper className="space-y-4 p-4 sm:p-8">
      <div className="flex w-full items-center">
        <div>
          <h2>Channels</h2>
          <p className="text-[--muted]">
            Channels load from your metadata provider. Use refresh to scan stream
            sources and generate mapping suggestions.
          </p>
        </div>
        <div className="hidden lg:ml-auto lg:block">
          <PageControls />
        </div>
      </div>

      <SettingsCard
        title="Channels"
        description={
          channelsTab === 'removed'
            ? 'These channels are hidden from the catalog. Restore one to put it back in My Channels.'
            : 'Manage channels, review mappings, and control stream priority.'
        }
        action={
          channelsTab === 'removed' ? (
            <Button
              size="sm"
              intent="primary-subtle"
              leftIcon={<BiUndo />}
              onClick={() =>
                restoreChannels(removedChannels.map((channel) => channel.id))
              }
              disabled={removedChannels.length === 0}
            >
              Restore all
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <IconButton
                rounded
                intent={sortMode === 'source' ? 'primary' : 'primary-subtle'}
                icon={<LuLayers className="h-5 w-5" />}
                onClick={() => setSortMode('source')}
                disabled={channels.length === 0}
                title="Group by source"
              />
              <IconButton
                rounded
                intent={
                  sortMode === 'alphabetical' ? 'primary' : 'primary-subtle'
                }
                icon={<LuArrowDownAZ className="h-5 w-5" />}
                onClick={() => setSortMode('alphabetical')}
                disabled={channels.length === 0}
                title="Sort alphabetically"
              />
              <IconButton
                rounded
                intent={isAllSelected ? 'primary' : 'primary-subtle'}
                icon={<LuSquareCheck className="h-5 w-5" />}
                onClick={toggleSelectAll}
                disabled={filteredChannels.length === 0}
                title={isAllSelected ? 'Deselect all' : 'Select all'}
              />
              <IconButton
                rounded
                intent="primary-subtle"
                icon={
                  isMatchingStreams ? (
                    <Spinner className="h-5 w-5" />
                  ) : (
                    <BiRefresh className="h-5 w-5" />
                  )
                }
                onClick={() => void refreshStreamMappings()}
                disabled={isMatchingStreams || isInitialLoading}
                title="Scan stream sources and match channels"
              />
            </div>
          )
        }
      >
        <StaticTabs
          className="mb-4 h-10 w-fit max-w-full rounded-full border"
          triggerClass="px-3 py-1 text-xs"
          items={[
            {
              name: `My Channels (${channels.length})`,
              isCurrent: channelsTab === 'my',
              onClick: () => setChannelsTab('my'),
            },
            {
              name: `Removed (${removedChannels.length})`,
              isCurrent: channelsTab === 'removed',
              onClick: () => setChannelsTab('removed'),
            },
          ]}
        />

        {channelsTab === 'removed' ? (
          <RemovedChannelsCard
            channels={removedChannels}
            onRestore={restoreChannels}
          />
        ) : (
          <>
            {channels.length > 0 ? (
              <div className="mb-4">
                <NeedsReviewCard
                  filter={reviewFilter}
                  onFilterChange={setReviewFilter}
                  channels={channels}
                  noStreamCount={noStreamCount}
                  duplicateGroups={duplicateGroups}
                  unavailableStreams={channelsResponse.unavailableStreams}
                  noScheduleCount={noScheduleCount}
                />
              </div>
            ) : null}
            {channels.length > 0 ? (
              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[140px] flex-1">
                    <TextInput
                      value={search}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setSearch(e.target.value)
                      }
                      placeholder="Search channels..."
                      leftIcon={<SearchIcon className="h-4 w-4" />}
                      aria-label="Search channels"
                    />
                  </div>
                  {knownGroups.length > 0 ? (
                    <div className="w-full sm:w-56">
                      <Select
                        options={[
                          { value: 'all', label: 'All groups' },
                          ...knownGroups.map((group) => ({
                            value: group,
                            label: group,
                          })),
                        ]}
                        value={groupFilter || 'all'}
                        onValueChange={(value) =>
                          setGroupFilter(value === 'all' ? '' : value)
                        }
                        placeholder="Filter by group"
                        aria-label="Filter by group"
                      />
                    </div>
                  ) : null}
                  {hasSelection ? (
                    <div className="flex animate-in fade-in items-center gap-1.5 duration-150">
                      <span className="whitespace-nowrap text-xs font-semibold text-[--brand]">
                        {selectedIds.size} selected
                      </span>
                      <IconButton
                        size="sm"
                        rounded
                        intent="primary-subtle"
                        icon={
                          toggleWillEnable ? (
                            <LuPower className="h-3.5 w-3.5" />
                          ) : (
                            <LuPowerOff className="h-3.5 w-3.5" />
                          )
                        }
                        onClick={batchToggleEnabled}
                        title={
                          toggleWillEnable
                            ? 'Enable selected'
                            : 'Disable selected'
                        }
                      />
                      <IconButton
                        size="sm"
                        rounded
                        intent="alert-subtle"
                        icon={<LuTrash2 className="h-3.5 w-3.5" />}
                        onClick={batchRemove}
                        title="Remove selected"
                      />
                    </div>
                  ) : null}
                </div>
                {isMatchingStreams ? (
                  <p className="text-xs text-[--muted]">
                    Scanning stream sources and matching channels...
                  </p>
                ) : null}
                {suggestionCount > 0 ? (
                  <p className="text-xs text-amber-400">
                    {suggestionCount} mapping suggestion
                    {suggestionCount === 1 ? '' : 's'} pending review across all
                    channels.
                  </p>
                ) : null}
              </div>
            ) : null}

            {refreshError ? (
              <p className="rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-400">
                Refresh failed: {refreshError}
              </p>
            ) : null}

            {!isInitialLoading &&
            (channelsResponse.scan?.truncated ||
              sourceProblems.length > 0 ||
              sourcesWithSkippedCatalogs.length > 0) ? (
              <div className="space-y-1 rounded-md border border-amber-500/40 px-3 py-2 text-xs">
                {channelsResponse.scan?.truncated ? (
                  <p className="text-amber-400">
                    {channelsResponse.scan.matchingTruncated
                      ? 'Matching ran out of time, so some channels have no stream suggestions this time. Press refresh to try again.'
                      : `The scan hit its time limit and returned partial results after ${Math.round(channelsResponse.scan.durationMs / 1000)}s.`}
                  </p>
                ) : null}
                {sourceProblems.map((source) => (
                  <p key={source.instanceId} className="text-amber-400">
                    <span className="font-semibold">{source.name}</span> (
                    {Math.round(source.durationMs / 1000)}s,{' '}
                    {source.channelCount + source.streamCount > 0
                      ? `${Math.max(source.channelCount, source.streamCount)} found`
                      : 'nothing found'}
                    ): {source.error ?? 'stopped early'}
                  </p>
                ))}
                {sourcesWithSkippedCatalogs.map((source) => (
                  <p
                    key={`${source.instanceId}-skipped`}
                    className="text-[--muted]"
                  >
                    {source.name}: skipped{' '}
                    {source.skippedCatalogs?.join(', ')}
                  </p>
                ))}
              </div>
            ) : null}

            {isInitialLoading ? (
              <div className="flex flex-col items-center gap-3 py-16">
                <LoadingSpinner />
                <p className="text-xs text-[--muted]">
                  Scanning sources. This can take a few minutes with large
                  guides; it will stop on its own if a source is too slow.
                </p>
              </div>
            ) : query.error ? (
              <p className="py-8 text-center text-red-400">
                {query.error.message}
              </p>
            ) : filteredChannels.length === 0 ? (
              <p className="py-8 text-center text-[--muted]">
                {channels.length === 0
                  ? 'Add a Live TV addon, XMLTV guide, or M3U playlist on the Addons page.'
                  : reviewedChannels.length === 0
                    ? 'No channels in this review list.'
                    : 'No channels match your search.'}
              </p>
            ) : groupedChannels ? (
              <div className="space-y-5">
                {groupedChannels.map(([source, sourceChannels]) => (
                  <div key={source} className="space-y-2">
                    <div className="flex items-center gap-2 px-1">
                      <span className="h-2 w-2 rounded-full bg-blue-500" />
                      <p className="text-xs font-semibold uppercase tracking-widest text-[--muted]">
                        {source} ({sourceChannels.length})
                      </p>
                    </div>
                    <ul className="space-y-2">
                      {sourceChannels.map(renderChannel)}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="space-y-2">
                {filteredChannels.map(renderChannel)}
              </ul>
            )}
          </>
        )}
      </SettingsCard>

      <ChannelMappingModal
        channel={mappingChannel}
        allStreamSources={channelsResponse.streamCatalog}
        open={mappingModal.isOpen}
        onOpenChange={(open) => {
          if (open) mappingModal.open();
          else {
            if (manualHlsModal.isOpen) return;
            mappingModal.close();
            setMappingChannelId(null);
          }
        }}
        linkStreamTarget={
          mappingChannelId ? (linkStreamTargets[mappingChannelId] ?? '') : ''
        }
        onLinkStreamTargetChange={(value) => {
          if (!mappingChannelId) return;
          setLinkStreamTargets((current) => ({
            ...current,
            [mappingChannelId]: value,
          }));
        }}
        onAcceptSuggestion={(addonId, streamChannelId) => {
          if (!mappingChannelId) return;
          acceptSuggestion(mappingChannelId, addonId, streamChannelId);
        }}
        onRejectSuggestion={(addonId, streamChannelId) => {
          if (!mappingChannelId) return;
          rejectSuggestion(mappingChannelId, addonId, streamChannelId);
        }}
        onAcceptAllSuggestions={() => {
          if (!mappingChannelId) return;
          acceptAllSuggestions(mappingChannelId);
        }}
        onRejectAllSuggestions={() => {
          if (!mappingChannelId) return;
          rejectAllSuggestions(mappingChannelId);
        }}
        onMoveMapping={(index, direction) => {
          if (!mappingChannelId) return;
          moveMapping(mappingChannelId, index, direction);
        }}
        onSplitMapping={(addonId, streamChannelId) => {
          if (!mappingChannelId) return;
          splitMapping(mappingChannelId, addonId, streamChannelId);
        }}
        onLinkStreamSource={() => {
          if (!mappingChannelId) return;
          linkStreamSource(mappingChannelId);
        }}
        onAddManualStream={() => {
          setEditingManualStream(null);
          manualHlsModal.open();
        }}
        onEditManualStream={(mapping) => {
          setEditingManualStream(mapping);
          manualHlsModal.open();
        }}
        preventDismiss={manualHlsModal.isOpen}
        onSetCanonical={(addonId) => {
          if (!mappingChannelId) return;
          setCanonical(mappingChannelId, addonId);
        }}
        onToggleStream={(addonId, enabled, streamChannelId) => {
          if (!mappingChannelId) return;
          updateChannel(mappingChannelId, (item) => ({
            ...item,
            mappings: item.mappings.map((candidate) =>
              candidate.addonId === addonId &&
              candidate.channelId === streamChannelId
                ? { ...candidate, enabled }
                : candidate
            ),
          }));
        }}
      />

      <ManualHlsModal
        open={manualHlsModal.isOpen}
        channelName={mappingChannel?.name}
        initial={editingManualStream}
        onOpenChange={(open) => {
          if (open) manualHlsModal.open();
          else {
            manualHlsModal.close();
            setEditingManualStream(null);
          }
        }}
        onSave={(details, previousChannelId) => {
          if (!mappingChannelId) return;
          saveManualStream(mappingChannelId, details, previousChannelId);
        }}
      />

      <ChannelEditModal
        channel={editChannel}
        groups={knownGroups}
        open={editModal.isOpen}
        onOpenChange={(open) => {
          if (open) editModal.open();
          else {
            editModal.close();
            setEditChannelId(null);
          }
        }}
        onSave={saveChannelEdit}
      />
    </PageWrapper>
  );
}
