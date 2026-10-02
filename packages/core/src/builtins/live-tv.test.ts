import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserData } from '../db/index.js';

vi.mock('../utils/index.js', () => ({
  Cache: { getInstance: () => ({ get: vi.fn(), set: vi.fn() }) },
  fromUrlSafeBase64: (value: string) =>
    Buffer.from(value, 'base64url').toString(),
  makeRequest: vi.fn(),
  toUrlSafeBase64: (value: string) => Buffer.from(value).toString('base64url'),
}));

const {
  encodeChannelId,
  M3uAddon,
  parseM3u,
  XmltvAddon,
  parseXmltv,
  parseXmltvData,
  clearXmltvSourceCache,
} = await Promise.all([
  import('./live-tv/index.js'),
  import('./m3u-reader/index.js'),
  import('./xmltv-reader/index.js'),
]).then(([liveTv, m3u, xmltv]) => ({
  ...liveTv,
  ...m3u,
  ...xmltv,
}));
const { applyEpgTimeShift, parseCatalogExtras, toContentRatings } = await import('./live-tv/epg.js');
const { normalizeChannelGroup } = await import('../utils/channelName.js');
const {
  getChannelMapping,
  getChannelMatchConfidence,
  isChannelAddonEnabled,
  isHighConfidenceChannelMatch,
  isChannelMappingSuggestion,
} = await import('../main/channelMappings.js');
const { makeRequest } = await import('../utils/index.js');

beforeEach(() => {
  // Parsed XMLTV guides are cached in-process; keep tests independent.
  clearXmltvSourceCache();
});

describe('live TV sources', () => {
  it('parses catalog extras including optional genre', () => {
    expect(parseCatalogExtras('skip=50/genre=VARIEDADES')).toMatchObject({
      skip: 50,
      genre: 'VARIEDADES',
    });
    expect(parseCatalogExtras('skip=0&date=2026-06-28&genre=News')).toMatchObject(
      {
        skip: 0,
        date: '2026-06-28',
        genre: 'News',
      }
    );
  });

  it('cleans channel group labels', () => {
    expect(normalizeChannelGroup('VARIEDADES')).toBe('Variedades');
    expect(normalizeChannelGroup('ESPORTES FHD')).toBe('Esportes');
    expect(normalizeChannelGroup('CANAIS | FILMES HD')).toBe('Filmes');
    expect(normalizeChannelGroup('CANAIS HD')).toBeUndefined();
    expect(normalizeChannelGroup('News, UK')).toBe('News Uk');
  });

  it('shifts EPG program times by configured minutes', () => {
    expect(
      applyEpgTimeShift(
        '2026-06-28T12:00:00.000Z',
        '2026-06-28T13:00:00.000Z',
        30
      )
    ).toEqual({
      startTime: '2026-06-28T12:30:00.000Z',
      endTime: '2026-06-28T13:30:00.000Z',
    });
  });

  it('fills missing content rating icons from age-rating-kit', () => {
    expect(
      toContentRatings([{ value: '12', system: 'ClassInd' }])
    ).toEqual([
      {
        value: '12',
        system: 'ClassInd',
        icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/classind/12.svg',
      },
    ]);
    expect(
      toContentRatings([{ value: 'PG-13', system: 'MPAA' }])
    ).toEqual([
      {
        value: 'PG-13',
        system: 'MPAA',
        icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/mpa/pg-13.svg',
      },
    ]);
    expect(
      toContentRatings([
        {
          value: 'L',
          system: 'ClassInd',
          icon: 'https://cdn.example/cover-l.png',
        },
      ])
    ).toEqual([
      {
        value: 'L',
        system: 'ClassInd',
        icon: 'https://cdn.example/cover-l.png',
      },
    ]);
    expect(toContentRatings([{ value: 12, system: 'ClassInd' }])).toEqual([
      {
        value: '12',
        system: 'ClassInd',
        icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/classind/12.svg',
      },
    ]);
    expect(
      toContentRatings([{ value: { code: 12 }, system: 'ClassInd' }])
    ).toEqual([
      {
        value: '12',
        system: 'ClassInd',
        icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/classind/12.svg',
      },
    ]);
    expect(toContentRatings([{ value: '0', system: 'TVP' }])).toEqual([
      {
        value: '0',
        system: 'TVP',
        icon: 'https://s.tvp.pl/files/portale-v4/tvp-pl/default/assets/images/elements/smile_green.svg',
      },
    ]);
    expect(toContentRatings([{ value: 'JM', system: 'TVP' }])).toEqual([
      {
        value: 'JM',
        system: 'TVP',
        icon: 'https://s.tvp.pl/files/portale-v4/tvp-pl/default/assets/images/elements/jm.svg',
      },
    ]);
    expect(toContentRatings([{ value: 'N', system: 'TVP' }])).toEqual([
      {
        value: 'N',
        system: 'TVP',
        icon: 'https://s.tvp.pl/files/portale-v4/tvp-pl/default/assets/images/elements/N.svg',
      },
    ]);
    expect(toContentRatings([{ value: 'AD', system: 'TVP' }])).toEqual([
      {
        value: 'AD',
        system: 'TVP',
        icon: 'https://s.tvp.pl/files/portale-v4/tvp-pl/default/assets/images/elements/AD.svg',
      },
    ]);
    expect(toContentRatings([{ value: '18', system: 'TVP' }])).toEqual([
      {
        value: '18',
        system: 'TVP',
        icon: 'https://s.tvp.pl/files/portale-v4/tvp-pl/default/assets/images/elements/adult.svg',
      },
    ]);
  });

  it('uses the same channel ID for XMLTV and M3U identifiers', async () => {
    const [channel] = await parseXmltv(
      '<tv><channel id="BBC.ONE"><display-name>BBC One</display-name></channel></tv>'
    );
    const [stream] = parseM3u(
      '#EXTM3U\n#EXTINF:-1 tvg-id="bbc.one" tvg-name="BBC One" group-title="News, UK",BBC One\nhttps://example.com/live.m3u8'
    );

    expect(channel.name).toBe('BBC One');
    expect(stream.group).toBe('News Uk');
    expect(encodeChannelId(channel.id)).toBe(encodeChannelId(stream.channelId));
  });

  it('parses extra XMLTV display-names as aliases and indexes programs by tvg-id', async () => {
    const data = await parseXmltvData(`<tv>
      <channel id="rtp1">
        <display-name>RTP 1</display-name>
        <display-name>RTP1</display-name>
      </channel>
      <programme channel="RTP1" start="20260628120000 +0000" stop="20260628130000 +0000">
        <title>Jornal</title>
      </programme>
    </tv>`);
    expect(data.channels[0]).toMatchObject({
      id: 'rtp1',
      name: 'RTP 1',
      aliases: ['RTP1'],
    });
    expect(data.programsByChannelId.get('rtp1')?.[0]?.title).toBe('Jornal');
  });

  it('returns XMLTV programs only from channel meta', async () => {
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<tv><channel id="bbc.one"><display-name>BBC One</display-name></channel><programme channel="bbc.one" start="20260628120000 +0000" stop="20260628130000 +0000"><title>News</title><sub-title>Evening</sub-title><desc>Latest news</desc><category>News</category><credits><actor>Jane Doe</actor><director>John Doe</director></credits><icon src="https://example.com/news.jpg" /><rating system="MPAA"><value>PG</value><icon src="https://example.com/pg.png" /></rating></programme></tv>',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new XmltvAddon({
      sourceUrl: 'https://example.com/guide.xml',
      timeout: 1000,
    });

    expect(addon.getManifest().behaviorHints?.epgProvider).toBe(true);
    expect(addon.getManifest().catalogs[0].extra).toEqual([
      { name: 'skip' },
      { name: 'date' },
    ]);
    expect(await addon.getCatalog()).toHaveLength(1);
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<tv><channel id="bbc.one"><display-name>BBC One</display-name></channel><programme channel="bbc.one" start="20260628120000 +0000" stop="20260628130000 +0000"><title>News</title><sub-title>Evening</sub-title><desc>Latest news</desc><category>News</category><credits><actor>Jane Doe</actor><director>John Doe</director></credits><icon src="https://example.com/news.jpg" /><rating system="MPAA"><value>PG</value><icon src="https://example.com/pg.png" /></rating></programme></tv>',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    const meta = await addon.getMeta(encodeChannelId('bbc.one'));
    vi.useRealTimers();
    expect(meta.videos?.[0]).toMatchObject({
      title: 'News',
      subtitle: 'Evening',
      overview: 'Latest news',
      thumbnail: 'https://example.com/news.jpg',
      startTime: '2026-06-28T12:00:00.000Z',
      endTime: '2026-06-28T13:00:00.000Z',
      released: '2026-06-28T12:00:00.000Z',
      releaseInfo: '2026',
      runtime: '60 min',
      genres: ['News'],
      cast: ['Jane Doe'],
      directors: ['John Doe'],
      ratings: [
        {
          value: 'PG',
          system: 'MPAA',
          icon: 'https://example.com/pg.png',
        },
      ],
    });
  });

  it('applies XMLTV time shift to program videos', async () => {
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<tv><channel id="bbc.one"><display-name>BBC One</display-name></channel><programme channel="bbc.one" start="20260628120000 +0000" stop="20260628130000 +0000"><title>News</title></programme></tv>',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new XmltvAddon({
      sourceUrl: 'https://example.com/guide.xml',
      timeout: 1000,
      timeShiftMinutes: -15,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    const meta = await addon.getMeta(encodeChannelId('bbc.one'));
    vi.useRealTimers();
    expect(meta.videos?.[0]?.startTime).toBe('2026-06-28T11:45:00.000Z');
    expect(meta.videos?.[0]?.endTime).toBe('2026-06-28T12:45:00.000Z');
  });

  it('uses an M3U as catalog and channel metadata without program videos', async () => {
    vi.mocked(makeRequest).mockResolvedValue({
      ok: true,
      text: async () =>
        '#EXTM3U\n#EXTINF:-1 tvg-name="BBC One" group-title="News",BBC One\nhttps://example.com/live.m3u8',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new M3uAddon({
      sourceUrl: 'https://example.com/list.m3u',
      timeout: 1000,
    });
    const manifest = await addon.getManifest();
    expect(manifest.behaviorHints?.epgProvider).toBeUndefined();
    expect(manifest).toMatchObject({
      resources: [{ name: 'catalog' }, { name: 'meta' }, { name: 'stream' }],
    });
    expect(manifest.catalogs[0].extra).toEqual(
      expect.arrayContaining([
        { name: 'skip' },
        expect.objectContaining({ name: 'genre', isRequired: false }),
      ])
    );
    const [channel] = await addon.getCatalog();
    const meta = await addon.getMeta(channel.id);

    expect(channel.name).toBe('BBC One');
    expect(channel.genres).toEqual(['News']);
    expect(meta.name).toBe('BBC One');
    expect(meta.genres).toEqual(['News']);
    expect(meta.videos).toBeUndefined();
  });

  it('returns guide catalog with programs when date extra is present', async () => {
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<tv><channel id="bbc.one"><display-name>BBC One</display-name></channel><programme channel="bbc.one" start="20260628120000 +0000" stop="20260628130000 +0000"><title>News</title></programme></tv>',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new XmltvAddon({
      sourceUrl: 'https://example.com/guide.xml',
      timeout: 1000,
    });

    const response = await addon.getCatalogResponse(0, '2026-06-28');
    expect(response.metas).toBeUndefined();
    expect(response.metasDetailed).toHaveLength(1);
    expect(response.metasDetailed?.[0]).toMatchObject({
      name: 'BBC One',
      type: 'tv',
      behaviorHints: { hasScheduledVideos: true },
    });
    expect(response.metasDetailed?.[0]?.videos?.[0]).toMatchObject({
      title: 'News',
      released: '2026-06-28T12:00:00.000Z',
      startTime: '2026-06-28T12:00:00.000Z',
    });
  });

  it('paginates Live TV catalogs in groups of fifty channels', async () => {
    const playlist = [
      '#EXTM3U',
      ...Array.from({ length: 55 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0');
        return `#EXTINF:-1 tvg-id="channel.${number}",Channel ${number}\nhttps://example.com/${number}.m3u8`;
      }),
    ].join('\n');
    vi.mocked(makeRequest).mockResolvedValue({
      ok: true,
      text: async () => playlist,
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new M3uAddon({
      sourceUrl: 'https://example.com/large.m3u',
      timeout: 1000,
    });

    expect(await addon.getCatalog()).toHaveLength(50);
    expect(await addon.getCatalog(50)).toHaveLength(5);
  });

  it('falls back program released to startTime when XMLTV date is missing', async () => {
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<tv><channel id="bbc.one"><display-name>BBC One</display-name></channel><programme channel="bbc.one" start="20260628120000 +0000" stop="20260628130000 +0000"><title>News</title></programme></tv>',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);
    const addon = new XmltvAddon({
      sourceUrl: 'https://example.com/guide.xml',
      timeout: 1000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    const meta = await addon.getMeta(encodeChannelId('bbc.one'));
    vi.useRealTimers();
    expect(meta.videos?.[0]?.released).toBe('2026-06-28T12:00:00.000Z');
  });
});

describe('channel mappings', () => {
  const userData = {
    channelMappings: [
      {
        id: 'channel-1',
        enabled: false,
        streams: [{ addonId: 'm3u-1', enabled: false }],
      },
    ],
  } as UserData;

  it('defaults unknown mappings to enabled and preserves explicit disables', () => {
    expect(getChannelMapping(userData, 'channel-1')?.enabled).toBe(false);
    expect(isChannelAddonEnabled(userData, 'channel-1', 'm3u-1')).toBe(false);
    expect(isChannelAddonEnabled(userData, 'channel-1', 'm3u-2')).toBe(true);
  });

  it('matches equivalent channels by tvg-id before comparing names', () => {
    expect(
      getChannelMatchConfidence(
        { id: 'xmltv:bbc', name: 'BBC One', tvgId: 'bbc.one' },
        { id: 'm3u:bbc-hd', name: 'BBC HD', tvgId: 'BBC.ONE' }
      )
    ).toBe(1);
    expect(
      getChannelMatchConfidence(
        { id: 'xmltv:bbc', name: 'BBC One', tvgId: 'bbc.one' },
        { id: 'm3u:cnn', name: 'CNN', tvgId: 'cnn' }
      )
    ).toBe(0);
    expect(
      getChannelMatchConfidence(
        { id: 'rtp1', name: 'RTP Internacional' },
        { id: 'other', name: 'CNN', tvgId: 'rtp1' }
      )
    ).toBe(1);
  });

  it('automatically matches only high-confidence channel metadata', () => {
    const confidence = getChannelMatchConfidence(
      { id: 'one', name: 'RTP 1', country: 'PT' },
      { id: 'two', name: 'RTP-1', country: 'PT' }
    );
    expect(confidence).toBe(0.93);
    expect(isHighConfidenceChannelMatch(confidence)).toBe(true);
    expect(
      isHighConfidenceChannelMatch(
        getChannelMatchConfidence(
          { id: 'vivo:globo', name: 'Globo', country: 'BR' },
          { id: 'mitv:globo', name: 'Rede Globo', country: 'BR' }
        )
      )
    ).toBe(true);
    expect(
      isHighConfidenceChannelMatch(
        getChannelMatchConfidence(
          { id: 'vivo:globosat', name: 'Globosat', country: 'BR' },
          { id: 'mitv:globosat', name: '+ Globosat', country: 'BR' }
        )
      )
    ).toBe(true);
    expect(
      isHighConfidenceChannelMatch(
        getChannelMatchConfidence(
          { id: 'vivo:globo', name: 'Globo', country: 'BR' },
          { id: 'mitv:globo-hd', name: 'Globo HD', country: 'BR' }
        )
      )
    ).toBe(true);
  });

  it('treats partial matches below 90% as suggestions', () => {
    const aliasConfidence = getChannelMatchConfidence(
      { id: 'one', name: 'News', aliases: ['World News'] },
      { id: 'two', name: 'World News' }
    );
    expect(aliasConfidence).toBe(0.88);
    expect(isChannelMappingSuggestion(aliasConfidence)).toBe(true);
    expect(isChannelMappingSuggestion(1)).toBe(false);
    expect(isChannelMappingSuggestion(0)).toBe(false);
  });

  it('matches channels when one side uses encoded HTML entities', () => {
    const confidence = getChannelMatchConfidence(
      { id: 'one', name: 'A&amp;E' },
      { id: 'two', name: 'A&E' }
    );
    expect(confidence).toBeGreaterThanOrEqual(0.9);
    expect(isHighConfidenceChannelMatch(confidence)).toBe(true);
  });

  it('matches streams with resolution and language suffixes to the base channel', () => {
    const channel = { id: 'amc', name: 'AMC' };
    for (const streamName of [
      'AMC 4K',
      'AMC FHD',
      'AMC HD',
      'AMC HD2',
      'AMC LEG FHD',
      'AMC LEG HD',
      'AMC LEG SD',
      'AMC SD',
      'Minha TV · AMC LEG FHD',
    ]) {
      const confidence = getChannelMatchConfidence(
        { id: 'stream', name: streamName },
        channel
      );
      expect(
        isHighConfidenceChannelMatch(confidence),
        `expected auto-match for ${streamName}`
      ).toBe(true);
    }
  });

  it('does not suggest unrelated channels for short names like A&E', () => {
    const channel = { id: 'a-and-e', name: 'A&E' };
    for (const streamName of [
      'Record TV Franca e Ribeirão Preto',
      'Record Tv Tv Vitória ESPIRITO SANTO',
      'NBA EXTRA',
      'Pestinha e Feroz',
      'A Vaca e o Frango',
    ]) {
      const confidence = getChannelMatchConfidence(
        { id: 'stream', name: streamName },
        channel
      );
      expect(confidence, `expected no match for ${streamName}`).toBe(0);
    }
    for (const streamName of ['A&E FHD', 'A&E HD', 'A&E SD']) {
      const confidence = getChannelMatchConfidence(
        { id: 'stream', name: streamName },
        channel
      );
      expect(isHighConfidenceChannelMatch(confidence)).toBe(true);
    }
  });

  it('matches streams with codec suffixes to the base channel', () => {
    const channel = { id: 'axn', name: 'AXN' };
    for (const streamName of [
      'AXN H265',
      'AXN H264',
      'AXN HEVC',
      'AXN x265',
      'Minha TV · AXN H265',
    ]) {
      const confidence = getChannelMatchConfidence(
        { id: 'stream', name: streamName },
        channel
      );
      expect(
        isHighConfidenceChannelMatch(confidence),
        `expected auto-match for ${streamName}`
      ).toBe(true);
    }
  });

  it('rejects oversized live TV source downloads', async () => {
    const { fetchSourceText } = await import('./live-tv/shared.js');
    vi.mocked(makeRequest).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length'
            ? String(60 * 1024 * 1024)
            : null,
      },
      text: async () => '',
    } as unknown as Awaited<ReturnType<typeof makeRequest>>);

    await expect(
      fetchSourceText({
        sourceUrl: 'https://example.com/huge.m3u',
        timeout: 1000,
        timeShiftMinutes: 0,
      })
    ).rejects.toThrow(/maximum size/);
  });
});

describe('channel matching with guide country suffixes and numbers', () => {
  const score = (stream: string, channel: string) =>
    getChannelMatchConfidence(
      { id: 'stream', name: stream },
      { id: 'channel', name: channel }
    );

  it('ignores the XMLTV country suffix', () => {
    expect(isHighConfidenceChannelMatch(score('CHANNEL 4', 'Channel 4.uk'))).toBe(true);
    expect(isHighConfidenceChannelMatch(score('CHANNEL 5 HD', '5.uk'))).toBe(true);
    expect(isHighConfidenceChannelMatch(score('Sky Sports+', 'Sky Sports+.uk'))).toBe(true);
  });

  it('never matches channels with different numbers', () => {
    expect(score('PREMIER SPORTS 1', 'Premier Sports 2.uk')).toBe(0);
    expect(score('TNT SPORTS 1', 'TNT Sports 10.uk')).toBe(0);
    expect(score('CHANNEL 44', 'Channel 4.uk')).toBe(0);
    expect(score('PREMIER SPORTS 1', 'Premier Sports 1.uk')).toBeGreaterThan(
      score('PREMIER SPORTS 1', 'Premier Sports 2.uk')
    );
  });

  it('keeps +1 channels apart from the main channel', () => {
    expect(score('CHANNEL 4+1', 'Channel 4.uk')).toBe(0);
    expect(score('CHANNEL 4', 'Channel 4 +1.uk')).toBe(0);
    expect(isHighConfidenceChannelMatch(score('CHANNEL 4+1', 'Channel 4 +1.uk'))).toBe(true);
    expect(isHighConfidenceChannelMatch(score('ITV +1', 'ITV1.uk'))).toBe(false);
  });
});
