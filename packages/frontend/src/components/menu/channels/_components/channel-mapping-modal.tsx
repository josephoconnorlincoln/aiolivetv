import React from 'react';
import {
  BiCheck,
  BiChevronDown,
  BiChevronUp,
  BiLink,
  BiPencil,
  BiPlus,
  BiUnlink,
  BiX,
} from 'react-icons/bi';
import { Modal } from '../../../ui/modal';
import { Button } from '../../../ui/button';
import { Combobox } from '../../../ui/combobox';
import { Switch } from '../../../ui/switch';
import type { ChannelInfo } from '@/lib/api';
import {
  isChannelSuggestion,
  isManualStreamMapping,
  streamSourceKey,
} from '../utils';
import { formatDeclaredSummary } from '../declared-summary';
import { cn } from '@/components/ui/core/styling';

type ChannelMappingModalProps = {
  channel: ChannelInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkStreamTarget: string;
  onLinkStreamTargetChange: (value: string) => void;
  onAcceptSuggestion: (addonId: string, streamChannelId: string) => void;
  onRejectSuggestion: (addonId: string, streamChannelId: string) => void;
  onAcceptAllSuggestions: () => void;
  onRejectAllSuggestions: () => void;
  onMoveMapping: (index: number, direction: -1 | 1) => void;
  onSplitMapping: (addonId: string, streamChannelId: string) => void;
  onLinkStreamSource: () => void;
  onAddManualStream: () => void;
  onEditManualStream: (mapping: ChannelInfo['mappings'][number]) => void;
  onSetCanonical: (addonId: string) => void;
  preventDismiss?: boolean;
  onToggleStream: (
    addonId: string,
    enabled: boolean,
    streamChannelId: string
  ) => void;
};

export function ChannelMappingModal({
  channel,
  open,
  onOpenChange,
  linkStreamTarget,
  onLinkStreamTargetChange,
  onAcceptSuggestion,
  onRejectSuggestion,
  onAcceptAllSuggestions,
  onRejectAllSuggestions,
  onMoveMapping,
  onSplitMapping,
  onLinkStreamSource,
  onAddManualStream,
  onEditManualStream,
  onSetCanonical,
  onToggleStream,
  preventDismiss = false,
}: ChannelMappingModalProps) {
  if (!channel) return null;

  const pendingCount = channel.mappings.filter((mapping) =>
    isChannelSuggestion(mapping.confidence)
  ).length;

  const streamSourceOptions =
    channel.availableStreamSources?.map((source) => ({
      value: streamSourceKey(source.addonId, source.channelId),
      label: `${source.addonName} · ${source.name}`,
      textValue: `${source.addonName} ${source.name}`,
    })) ?? [];

  const mappingStatus = (mapping: ChannelInfo['mappings'][number]) => {
    const suggestion = isChannelSuggestion(mapping.confidence);
    if (mapping.confidence === 0) return 'manual';
    if (suggestion) return `${Math.round(mapping.confidence * 100)}% match`;
    return 'accepted';
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={channel.name}
      description="Review stream mappings and suggestions for this channel."
      contentClass="max-w-2xl w-[calc(100vw-2rem)] min-w-0 max-h-[90vh] overflow-x-hidden overflow-y-auto"
      onInteractOutside={(event) => {
        if (preventDismiss) event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        if (preventDismiss) event.preventDefault();
      }}
    >
      <div className="min-w-0 space-y-4">
        {pendingCount > 0 ? (
          <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-sm text-amber-300">
              {pendingCount} suggestion{pendingCount === 1 ? '' : 's'} pending
              review
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                size="sm"
                intent="alert-subtle"
                leftIcon={<BiX />}
                onClick={onRejectAllSuggestions}
              >
                Reject all
              </Button>
              <Button
                size="sm"
                leftIcon={<BiCheck />}
                onClick={onAcceptAllSuggestions}
              >
                Accept all
              </Button>
            </div>
          </div>
        ) : null}

        {streamSourceOptions.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Combobox
                label="Link stream source"
                placeholder="Search stream channels..."
                value={linkStreamTarget ? [linkStreamTarget] : []}
                onValueChange={(value) =>
                  onLinkStreamTargetChange(value[value.length - 1] ?? '')
                }
                options={streamSourceOptions}
                emptyMessage="No matching stream channels"
                keepOpenOnSelect={false}
              />
            </div>
            <Button
              size="md"
              className="shrink-0"
              leftIcon={<BiLink />}
              disabled={!linkStreamTarget}
              onClick={onLinkStreamSource}
            >
              Link
            </Button>
          </div>
        ) : (
          <p className="text-xs text-[--muted]">
            No unlinked stream channels available. Add a stream addon such as
            FrostView, Fenix TV or M3U, or add a manual HLS link below.
          </p>
        )}

        <Button
          size="sm"
          leftIcon={<BiPlus />}
          onClick={onAddManualStream}
        >
          Add HLS stream
        </Button>

        <div className="min-w-0 space-y-2">
          {channel.mappings.length === 0 ? (
            <p className="rounded border border-[--border] p-3 text-sm text-[--muted]">
              No stream sources linked yet.
            </p>
          ) : null}
          {channel.mappings.map((mapping, index) => {
            const suggestion = isChannelSuggestion(mapping.confidence);
            const manual = isManualStreamMapping(mapping);
            const declaredSummary = formatDeclaredSummary(mapping.declared);
            const headerCount = mapping.headers
              ? Object.keys(mapping.headers).length
              : 0;
            const detail = (manual ? mapping.url : mapping.name) ?? undefined;
            return (
              <div
                key={`${mapping.addonId}:${mapping.channelId}`}
                className={cn(
                  'min-w-0 space-y-3 rounded border p-3',
                  suggestion
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-[--border]'
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {manual ? mapping.name : mapping.addonName}
                      </p>
                      {mapping.addonId === channel.canonicalAddonId ? (
                        <span className="text-xs text-blue-400">Canonical</span>
                      ) : null}
                      {manual ? (
                        <span className="text-xs text-purple-400">
                          Manual HLS
                        </span>
                      ) : null}
                      {mapping.epgProvider ? (
                        <span className="text-xs text-emerald-400">EPG</span>
                      ) : null}
                      {suggestion ? (
                        <span className="text-xs text-amber-400">
                          Suggested
                        </span>
                      ) : null}
                    </div>
                    <p
                      className="mt-1 break-all text-xs text-[--muted]"
                      title={detail}
                    >
                      {detail}
                    </p>
                    <p className="mt-0.5 text-xs text-[--muted]">
                      {mappingStatus(mapping)}
                      {mapping.canStream ? ' · streams' : ''}
                    </p>
                    {declaredSummary ? (
                      <p className="mt-0.5 truncate text-xs text-sky-400/90">
                        {declaredSummary}
                      </p>
                    ) : null}
                    {headerCount > 0 ? (
                      <p className="mt-0.5 text-xs text-[--muted]">
                        {headerCount} request header
                        {headerCount === 1 ? '' : 's'}
                      </p>
                    ) : null}
                  </div>
                  {mapping.canStream && !suggestion ? (
                    <Switch
                      className="shrink-0"
                      aria-label={`Enable ${mapping.addonName} for ${channel.name}`}
                      value={mapping.enabled}
                      disabled={!channel.enabled}
                      onValueChange={(enabled) =>
                        onToggleStream(
                          mapping.addonId,
                          enabled,
                          mapping.channelId
                        )
                      }
                    />
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {suggestion ? (
                    <>
                      <Button
                        size="sm"
                        leftIcon={<BiCheck />}
                        onClick={() =>
                          onAcceptSuggestion(mapping.addonId, mapping.channelId)
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<BiX />}
                        onClick={() =>
                          onRejectSuggestion(mapping.addonId, mapping.channelId)
                        }
                      >
                        Reject
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        aria-label={`Move ${mapping.addonName} up`}
                        disabled={index === 0}
                        onClick={() => onMoveMapping(index, -1)}
                      >
                        <BiChevronUp />
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Move ${mapping.addonName} down`}
                        disabled={index === channel.mappings.length - 1}
                        onClick={() => onMoveMapping(index, 1)}
                      >
                        <BiChevronDown />
                      </Button>
                      {manual ? (
                        <Button
                          size="sm"
                          leftIcon={<BiPencil />}
                          onClick={() => onEditManualStream(mapping)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {!manual &&
                      mapping.addonId !== channel.canonicalAddonId ? (
                        <Button
                          size="sm"
                          onClick={() => onSetCanonical(mapping.addonId)}
                        >
                          Canonical
                        </Button>
                      ) : null}
                      {channel.mappings.length > 1 &&
                      !manual &&
                      mapping.addonId !== channel.canonicalAddonId ? (
                        <Button
                          size="sm"
                          aria-label={`Unlink ${mapping.addonName} from ${channel.name}`}
                          leftIcon={<BiUnlink />}
                          onClick={() =>
                            onSplitMapping(mapping.addonId, mapping.channelId)
                          }
                        >
                          Unlink
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
