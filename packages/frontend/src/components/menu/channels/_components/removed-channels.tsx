import React from 'react';
import { BiUndo } from 'react-icons/bi';
import { SearchIcon } from 'lucide-react';
import { IconButton } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { getRemovedChannels } from '../utils';
import { ProviderChip } from './channel-list-item';

type RemovedChannel = ReturnType<typeof getRemovedChannels>[number];

type RemovedChannelsCardProps = {
  channels: RemovedChannel[];
  onRestore: (channelIds: string[]) => void;
};

export function RemovedChannelsCard({
  channels,
  onRestore,
}: RemovedChannelsCardProps) {
  const [search, setSearch] = React.useState('');
  const query = search.trim().toLocaleLowerCase('pt-BR');
  const filtered = query
    ? channels.filter((channel) => {
        const haystack = `${channel.name} ${channel.sourceName ?? ''} ${channel.id}`;
        return haystack.toLocaleLowerCase('pt-BR').includes(query);
      })
    : channels;

  return (
    <div className="space-y-3">
      {channels.length > 0 ? (
        <TextInput
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          placeholder="Search removed channels..."
          leftIcon={<SearchIcon className="h-4 w-4" />}
          aria-label="Search removed channels"
        />
      ) : null}
      {channels.length === 0 ? (
        <p className="py-8 text-center text-[--muted]">
          No removed channels. Hidden channels will appear here.
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[--muted]">
          No removed channels match your search.
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((channel) => (
            <li
              key={channel.id}
              className="flex items-center gap-3 rounded-[--radius-md] border border-[--border] bg-[var(--background)] px-2.5 py-2"
            >
              <div className="relative hidden h-8 w-8 flex-shrink-0 sm:block">
                {channel.poster ? (
                  <img
                    src={channel.poster}
                    alt=""
                    className="absolute inset-0 h-full w-full rounded-md object-contain"
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
                <ProviderChip label={channel.sourceName} />
              </div>
              <IconButton
                className="h-8 w-8 rounded-full md:h-10 md:w-10"
                icon={<BiUndo />}
                intent="primary-subtle"
                onClick={() => onRestore([channel.id])}
                title={`Restore ${channel.name}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
