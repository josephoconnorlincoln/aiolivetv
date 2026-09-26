import { useState } from 'react';
import { BiEdit, BiTrash } from 'react-icons/bi';
import { LuLink } from 'react-icons/lu';
import { IconButton } from '../../../ui/button';
import { Switch } from '../../../ui/switch';
import type { ChannelInfo } from '@/lib/api';
import { getChannelSourceLabel, getMappingStats } from '../utils';
import {
  ConfirmationDialog,
  useConfirmationDialog,
} from '../../../shared/confirmation-dialog';

type ChannelListItemProps = {
  channel: ChannelInfo;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenMappings: () => void;
  onEdit: () => void;
  onRemove: () => void;
};

function MappingBadge({
  accepted,
  pending,
  total,
  onClick,
}: {
  accepted: number;
  pending: number;
  total: number;
  onClick: () => void;
}) {
  const tone =
    total === 0
      ? 'bg-gray-500/15 text-gray-400 border-gray-500/30'
      : pending > 0
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
        : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        pending > 0
          ? `${accepted} accepted, ${pending} to review`
          : `${accepted} mapping${accepted === 1 ? '' : 's'}`
      }
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors hover:brightness-110 ${tone}`}
    >
      <LuLink className="h-3.5 w-3.5" />
      {total > 0 ? `${accepted}/${total}` : '0'}
    </button>
  );
}

export function ProviderChip({ label }: { label?: string }) {
  const name = label?.trim();
  if (!name || name === 'Other') return null;
  return (
    <span
      title={name}
      className="max-w-[5.5rem] flex-shrink-0 truncate rounded-full border border-blue-500/30 bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-300 sm:max-w-[9rem]"
    >
      {name}
    </span>
  );
}

export function ChannelListItem({
  channel,
  isSelected,
  onToggleSelect,
  onToggleEnabled,
  onOpenMappings,
  onEdit,
  onRemove,
}: ChannelListItemProps) {
  const { accepted, pending, total } = getMappingStats(channel);
  const sourceLabel = getChannelSourceLabel(channel);
  const [logoFailed, setLogoFailed] = useState(false);

  const confirmDelete = useConfirmationDialog({
    title: 'Remove Channel',
    description: `Remove "${channel.name}" from your channel list? You can restore it later from Removed channels.`,
    actionText: 'Remove',
    actionIntent: 'alert',
    onConfirm: onRemove,
  });

  return (
    <li>
      <div
        className={`flex items-center gap-2 rounded-[--radius-md] border px-2.5 py-2 transition-colors sm:gap-3 ${
          isSelected
            ? 'border-brand-500/50 bg-brand-500/10'
            : 'border-[--border] bg-[var(--background)]'
        }`}
      >
        <button
          type="button"
          onClick={onToggleSelect}
          className="flex flex-shrink-0 items-center justify-center"
        >
          <div
            className={`flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${
              isSelected
                ? 'border-brand-600 bg-brand-600'
                : 'border-gray-500 hover:border-gray-400'
            }`}
          >
            {isSelected ? (
              <svg
                className="h-3 w-3 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : null}
          </div>
        </button>

        <div className="relative hidden h-8 w-8 flex-shrink-0 sm:block">
          {channel.poster && !logoFailed ? (
            <img
              src={channel.poster}
              alt=""
              className="absolute inset-0 h-full w-full rounded-md object-contain"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-md bg-gray-950">
              <p className="text-lg font-bold">
                {channel.name.trim()[0]?.toUpperCase() ?? '?'}
              </p>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="min-w-0 truncate text-base">{channel.name}</p>
          <ProviderChip label={sourceLabel} />
        </div>
        {channel.group ? (
          <span className="hidden max-w-[8rem] flex-shrink-0 truncate rounded-full bg-[--subtle] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[--muted] sm:inline">
            {channel.group}
          </span>
        ) : null}

        <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
          <MappingBadge
            accepted={accepted}
            pending={pending}
            total={total}
            onClick={onOpenMappings}
          />
          <Switch
            value={channel.enabled}
            onValueChange={onToggleEnabled}
            className="h-5 w-9 md:h-6 md:w-11"
            aria-label={`Enable ${channel.name}`}
          />
          <IconButton
            className="h-8 w-8 rounded-full md:h-10 md:w-10"
            icon={<BiEdit />}
            intent="primary-subtle"
            onClick={onEdit}
            title="Edit name, logo or group"
          />
          <IconButton
            className="h-8 w-8 rounded-full md:h-10 md:w-10"
            icon={<BiTrash />}
            intent="alert-subtle"
            onClick={() => confirmDelete.open()}
            title="Remove channel"
          />
        </div>
      </div>
      <ConfirmationDialog {...confirmDelete} />
    </li>
  );
}
