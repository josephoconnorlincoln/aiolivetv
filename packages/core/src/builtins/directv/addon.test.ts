import { beforeEach, describe, expect, it, vi } from 'vitest';

const { httpConfig } = vi.hoisted(() => ({
  httpConfig: {
    addonProxy: ['http://127.0.0.1:8888'] as string[],
    addonProxyConfig: {} as Record<string, boolean | number>,
  },
}));

const cacheStores = new Map<string, Map<string, unknown>>();

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cacheStore(name: string) {
  let store = cacheStores.get(name);
  if (!store) {
    store = new Map();
    cacheStores.set(name, store);
  }
  return store;
}

vi.mock('../../config/index.js', () => ({
  config: { http: httpConfig },
}));

vi.mock('../../utils/index.js', () => ({
  Cache: {
    getInstance: (name: string) => ({
      get: async (key: string) => cacheStore(name).get(key),
      set: async (key: string, value: unknown) => {
        cacheStore(name).set(key, jsonClone(value));
      },
    }),
  },
  decodeHtmlEntities: (value: string) => value,
  fromUrlSafeBase64: (value: string) =>
    Buffer.from(value, 'base64url').toString(),
  makeRequest: vi.fn(),
  toUrlSafeBase64: (value: string) => Buffer.from(value).toString('base64url'),
}));

const { DirectvAddon } = await import('./addon.js');
const { makeRequest } = await import('../../utils/index.js');

const PROXY = 'http://127.0.0.1:8888';
const CHANNEL = {
  resourceId: '123',
  channelName: 'ESPN',
  callSign: 'ESPNHD',
  imageList: [{ imageUrl: 'https://img.example/espn.png' }],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Awaited<ReturnType<typeof makeRequest>>;
}

describe('DIRECTV builtin', () => {
  beforeEach(() => {
    cacheStores.clear();
    httpConfig.addonProxy = [PROXY];
    httpConfig.addonProxyConfig = {};
    vi.mocked(makeRequest).mockReset();
  });

  it('exposes catalog and EPG metadata', () => {
    const manifest = new DirectvAddon({ timeout: 1000 }).getManifest();
    expect(manifest.behaviorHints?.epgProvider).toBe(true);
    expect(
      manifest.resources.map((resource) =>
        typeof resource === 'string' ? resource : resource.name
      )
    ).toEqual(['catalog', 'meta']);
    expect(manifest.catalogs[0]?.extra).toEqual([
      { name: 'skip' },
      { name: 'date' },
    ]);
  });

  it('loads channels through the dashboard HTTP proxy', async () => {
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      if (String(url).includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      if (String(url).includes('/allchannels')) {
        return jsonResponse({ channelInfoList: [CHANNEL] });
      }
      return jsonResponse({}, 404);
    });

    const catalog = await new DirectvAddon({ timeout: 1000 }).getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: 'ESPN',
      type: 'tv',
      country: 'US',
      language: 'en',
      tvgId: 'ESPNHD',
      poster: 'https://img.example/espn.png',
    });

    const calls = vi.mocked(makeRequest).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((call) => call[1]?.forceProxy === PROXY)
    ).toBe(true);
    expect(calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer tok',
    });
  });

  it('keeps one entry for HD, SD and alternate feeds of the same channel', async () => {
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      if (String(url).includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({
        channelInfoList: [
          { resourceId: '1', channelName: 'A&E', callSign: 'AETV' },
          { resourceId: '2', channelName: 'A&E HD', callSign: 'AETVHD' },
          { resourceId: '3', channelName: 'ACC Network', callSign: 'ACC' },
          { resourceId: '4', channelName: 'ACC Network HD', callSign: 'ACCHD' },
          {
            resourceId: '5',
            channelName: 'Altitude Sports',
            callSign: 'ALT',
          },
          {
            resourceId: '6',
            channelName: 'Altitude Sports (Alternate)',
            callSign: 'ALT2',
          },
          {
            resourceId: '7',
            channelName: 'Altitude Sports HD (Alternate)',
            callSign: 'ALT2HD',
          },
          { resourceId: '8', channelName: 'ESPN', callSign: 'ESPN' },
          { resourceId: '9', channelName: 'ESPN2', callSign: 'ESPN2' },
          { resourceId: '10', channelName: 'HBO East', callSign: 'HBOE' },
          { resourceId: '11', channelName: 'HBO West HD', callSign: 'HBOWHD' },
          {
            resourceId: '12',
            channelName: 'MLB Extra Innings 730',
            callSign: 'MLB730',
          },
          {
            resourceId: '13',
            channelName: 'MLB Extra Innings HD 731',
            callSign: 'MLB731',
          },
          {
            resourceId: '14',
            channelName: 'NBC Sports California',
            callSign: 'NBCSCA',
          },
          {
            resourceId: '15',
            channelName: 'NBC Sports California Plus',
            callSign: 'NBCSCAP',
          },
          { resourceId: '16', channelName: 'ASPIRE (HD)', callSign: 'ASPIRE' },
          { resourceId: '17', channelName: 'FOX (103A)', callSign: 'FOXDEP' },
        ],
      });
    });

    const names = (await new DirectvAddon({ timeout: 1000 }).getCatalog()).map(
      (channel) => channel.name
    );
    expect(names).toEqual([
      'A&E',
      'ACC Network',
      'Altitude Sports',
      'ESPN',
      'ESPN2',
      'HBO East',
      'HBO West',
      'MLB Extra Innings 730',
      'MLB Extra Innings 731',
      'NBC Sports California',
      'NBC Sports California Plus',
      'ASPIRE',
      'FOX (103A)',
    ]);
  });

  it('uses the series image when the episode still may be missing and reads the TV rating', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    const seriesEditId = '42df0f3e-b723-4618-bb7a-170890de7e4f';
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      const href = String(url);
      if (href.includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      if (href.includes('/allchannels')) {
        return jsonResponse({ channelInfoList: [CHANNEL] });
      }
      if (href.includes('/schedule')) {
        return jsonResponse({
          schedules: [
            {
              channelId: '123',
              contents: [
                {
                  programID: 'abc',
                  title: '20/20',
                  seriesId: 'f95949d9-807e-8584-e299-ad8c19f23b6f',
                  seriesEditId,
                  editId: 'd752e5ef-8dd4-4e2a-94fb-3ea9295f339a',
                  description: 'Scott Peterson may receive a new trial.',
                  genres: ['News'],
                  consumables: [
                    {
                      startTime: '2026-09-17T12:00:00.000Z',
                      endTime: '2026-09-17T13:00:00.000Z',
                      parentalRating: 'TVPG',
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const addon = new DirectvAddon({ timeout: 1000 });
    const catalog = await addon.getCatalog();
    const meta = await addon.getMeta(catalog[0]!.id);
    vi.useRealTimers();

    expect(meta.videos?.[0]).toMatchObject({
      title: '20/20',
      thumbnail: `https://dfwfis.prod.dtvcdn.com/catalog/image/imageserver/v1/service/series/${seriesEditId}/iconic-ci/640/360`,
      ratings: [
        {
          value: 'TV-PG',
          system: 'tv-pg',
          icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/tv-pg/tv-pg.svg',
        },
      ],
    });
  });

  it('uses a proxied logo when DIRECTV does not send an external image', async () => {
    const id = '0ceb396e-86d0-417f-99a2-5de1f3366743';
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      if (String(url).includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({
        channelInfoList: [{ resourceId: id, channelName: '20/20', callSign: '2020' }],
      });
    });

    const catalog = await new DirectvAddon({ timeout: 1000 }).getCatalog();
    expect(catalog[0]?.poster).toBe(
      `https://dfwfis.prod.dtvcdn.com/catalog/image/imageserver/v1/service/channel/${id}/chlogo-bwdb-player/120/91`
    );
  });

  it('uses the dashboard wildcard proxy index', async () => {
    httpConfig.addonProxy = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
    httpConfig.addonProxyConfig = { '*': 1 };
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      if (String(url).includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({ channelInfoList: [CHANNEL] });
    });

    await new DirectvAddon({ timeout: 1000 }).getCatalog();
    expect(vi.mocked(makeRequest).mock.calls[0]?.[1]?.forceProxy).toBe(
      'http://127.0.0.1:2'
    );
  });

  it('uses the proxy index configured for the DIRECTV host', async () => {
    httpConfig.addonProxy = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
    httpConfig.addonProxyConfig = { 'api.cld.dtvce.com': 1 };
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      if (String(url).includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({ channelInfoList: [CHANNEL] });
    });

    await new DirectvAddon({ timeout: 1000 }).getCatalog();
    expect(vi.mocked(makeRequest).mock.calls[0]?.[1]?.forceProxy).toBe(
      'http://127.0.0.1:2'
    );
  });

  it('returns programme videos for a UTC day and skips filler slots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
    vi.mocked(makeRequest).mockImplementation(async (url: string) => {
      const href = String(url);
      if (href.includes('/tokens')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      if (href.includes('/allchannels')) {
        return jsonResponse({ channelInfoList: [CHANNEL] });
      }
      if (href.includes('/schedule')) {
        expect(href).toContain('channelIds=123');
        expect(href).toContain(`startTime=${Date.parse('2026-09-17T00:00:00.000Z')}`);
        return jsonResponse({
          schedules: [
            {
              channelId: '123',
              contents: [
                {
                  programID: '-1',
                  title: 'Gap',
                },
                {
                  programID: 'abc',
                  title: 'SportsCenter',
                  episodeTitle: 'Late Night',
                  description: 'Highlights',
                  parentalRating: 'TV-PG',
                  releaseYear: 2024,
                  genres: ['Sports'],
                  seasonNumber: 2,
                  episodeNumber: 5,
                  images: [{ defaultImageUrl: 'https://img.example/sc.jpg' }],
                  consumables: [
                    {
                      startTime: '2026-09-17T12:00:00.000Z',
                      endTime: '2026-09-17T13:00:00.000Z',
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const addon = new DirectvAddon({ timeout: 1000 });
    const catalog = await addon.getCatalog();
    const meta = await addon.getMeta(catalog[0]!.id);
    vi.useRealTimers();

    expect(meta.videos).toHaveLength(1);
    expect(meta.videos?.[0]).toMatchObject({
      title: 'SportsCenter',
      subtitle: 'S2E5 · Late Night',
      overview: 'Highlights',
      thumbnail: 'https://img.example/sc.jpg',
      genres: ['Sports'],
      releaseInfo: '2024',
      ratings: [
        {
          value: 'TV-PG',
          system: 'tv-pg',
          icon: 'https://cdn.jsdelivr.net/gh/mrcanelas/age-rating-kit@latest/icons/tv-pg/tv-pg.svg',
        },
      ],
    });
    expect(
      vi.mocked(makeRequest).mock.calls.filter((call) =>
        String(call[0]).includes('/tokens')
      )
    ).toHaveLength(1);
  });

  it('explains a geo-block when DIRECTV rejects the token', async () => {
    vi.mocked(makeRequest).mockResolvedValue(jsonResponse({}, 403));
    await expect(
      new DirectvAddon({ timeout: 1000 }).getCatalog()
    ).rejects.toThrow(/Dashboard settings/);
  });
});
