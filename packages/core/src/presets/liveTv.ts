import type {
  Addon,
  Option,
  ParsedStream,
  Stream,
  UserData,
} from '../db/index.js';
import { MI_TV_COUNTRIES } from '../builtins/mitv/index.js';
import { MOVISTAR_COUNTRIES } from '../builtins/movistartv/index.js';
import StreamParser from '../parser/streams.js';
import { appConfig, constants, toUrlSafeBase64 } from '../utils/index.js';
import { Preset } from './preset.js';

class LiveTvStreamParser extends StreamParser {
  protected override getStreamType(
    _stream: Stream,
    _service: ParsedStream['service'],
    _currentParsedStream: ParsedStream
  ): ParsedStream['type'] {
    return constants.LIVE_STREAM_TYPE;
  }
}

const epgTimeShiftOption = (): Option => ({
  id: 'timeShiftMinutes',
  name: 'EPG Time Shift (minutes)',
  description:
    'Shift all program start and end times by this amount. Use positive values if the guide runs ahead of the broadcast, or negative if it lags.',
  type: 'number',
  required: false,
  showInSimpleMode: true,
  default: 0,
  constraints: {
    min: -720,
    max: 720,
    forceInUi: false,
  },
});

const sourceOptions = (
  name: string,
  resources: ('catalog' | 'meta' | 'stream')[]
): Option[] => [
  {
    id: 'resources',
    name: 'Resources',
    description:
      'Choose what to use from this source. Select only Stream to match streams to channels from other providers without listing its channels.',
    type: 'multi-select',
    required: false,
    showInSimpleMode: true,
    default: resources,
    options: resources.map((resource) => ({
      label: constants.RESOURCE_LABELS[resource],
      value: resource,
    })),
  },
  {
    id: 'name',
    name: 'Name',
    description: 'What to call this addon',
    type: 'string',
    required: true,
    default: name,
  },
  {
    id: 'sourceUrl',
    name: `${name} URL`,
    description: `URL of the ${name} source`,
    type: 'url',
    required: true,
  },
  {
    id: 'timeout',
    name: 'Timeout (ms)',
    description: 'Timeout for fetching the source',
    type: 'number',
    required: true,
    default: appConfig.presets.defaultTimeout,
    constraints: {
      min: appConfig.userLimits.timeouts.minTimeout,
      max: appConfig.userLimits.timeouts.maxTimeout,
      forceInUi: false,
    },
  },
];

function generateAddon(
  type: 'xmltv' | 'm3u',
  name: string,
  resources: ('catalog' | 'meta' | 'stream')[],
  options: Record<string, any>
): Addon {
  const config = {
    sourceUrl: options.sourceUrl,
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || name,
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/${type}/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || resources,
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type, options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

export class XmltvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'xmltv',
      NAME: 'XMLTV',
      LOGO: '',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/xmltv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION: 'Channel metadata and catalogs from an XMLTV guide.',
      OPTIONS: [...sourceOptions('XMLTV', resources), epgTimeShiftOption()],
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [
      generateAddon(
        'xmltv',
        this.METADATA.NAME,
        this.METADATA.SUPPORTED_RESOURCES,
        options
      ),
    ];
  }
}

function generateVivoAddon(
  options: Record<string, any>
): Addon {
  const config = {
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || 'Vivo TV',
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/vivo-tv/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ],
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'vivo-tv', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function vivoTvOptions(
  resources: ('catalog' | 'meta')[]
): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description:
        'Choose what to use from this source. Select only Stream to match streams to channels from other providers without listing its channels.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'Vivo TV',
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class VivoTvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'vivo-tv',
      NAME: 'Vivo TV',
      LOGO: '/assets/vivotv_logo.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/vivo-tv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from Vivo Play via the Telefónica Brazil API.',
      OPTIONS: vivoTvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateVivoAddon(options)];
  }
}

function movistarCountryLabel(code: string | undefined): string {
  return (
    MOVISTAR_COUNTRIES.find((country) => country.code === code)?.name ?? 'Chile'
  );
}

function generateMovistarAddon(options: Record<string, any>): Addon {
  const country = options.country || 'cl';
  const config = {
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    country,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  const customName =
    typeof options.name === 'string' ? options.name.trim() : '';
  const name =
    customName && customName !== 'Movistar'
      ? customName
      : `Movistar (${movistarCountryLabel(country)})`;
  return {
    name,
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/movistar-tv/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ],
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'movistar-tv', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function movistarTvOptions(resources: ('catalog' | 'meta')[]): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description: 'Choose catalog and/or metadata from this source.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'Movistar',
    },
    {
      id: 'country',
      name: 'Country',
      description:
        'Movistar publishes a separate guide per Latin American country. Add one instance per country.',
      type: 'select',
      required: true,
      showInSimpleMode: true,
      default: 'cl',
      options: MOVISTAR_COUNTRIES.map((country) => ({
        label: country.name,
        value: country.code,
      })),
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class MovistarTvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'movistar-tv',
      NAME: 'Movistar',
      LOGO: '/assets/movistar_logo.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/movistar-tv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from Movistar via the Telefónica API (Chile, Peru, Colombia and Argentina).',
      OPTIONS: movistarTvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateMovistarAddon(options)];
  }
}

function generateTvpAddon(options: Record<string, any>): Addon {
  const timeout = Math.max(
    options.timeout || appConfig.presets.defaultTimeout,
    15_000
  );
  const config = {
    timeout,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || 'TVP',
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/tvp/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: (options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ]).filter(
      (resource: string) =>
        resource === constants.CATALOG_RESOURCE ||
        resource === constants.META_RESOURCE
    ),
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'tvp', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function tvpTvOptions(resources: ('catalog' | 'meta')[]): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description: 'Choose catalog and/or metadata from this source.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'TVP',
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

function generateDirectvAddon(options: Record<string, any>): Addon {
  const timeout = Math.max(
    options.timeout || appConfig.presets.defaultTimeout,
    15_000
  );
  const config = {
    timeout,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || 'DIRECTV',
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/directv/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: (options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ]).filter(
      (resource: string) =>
        resource === constants.CATALOG_RESOURCE ||
        resource === constants.META_RESOURCE
    ),
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'directv', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function directvOptions(resources: ('catalog' | 'meta')[]): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description: 'Choose catalog and/or metadata from this source.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'DIRECTV',
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class DirectvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'directv',
      NAME: 'DIRECTV',
      LOGO: '/assets/directv.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/directv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from DIRECTV (US).\n\nLogos and programme images are geo-blocked and only load when the viewer is in the United States.',
      OPTIONS: directvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateDirectvAddon(options)];
  }
}

export class TvpPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'tvp',
      NAME: 'TVP',
      LOGO: '/assets/tvp_logo.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/tvp`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from TVP (Poland). Catalog and metadata only.',
      OPTIONS: tvpTvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateTvpAddon(options)];
  }
}

function generateClaroTvAddon(options: Record<string, any>): Addon {
  const config = {
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    location: options.location || 'SAO PAULO,SAO PAULO',
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || 'Claro TV+',
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/claro-tv/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ],
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'claro-tv', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function claroTvOptions(resources: ('catalog' | 'meta')[]): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description:
        'Choose what to use from this source. Select only Stream to match streams to channels from other providers without listing its channels.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'Claro TV+',
    },
    {
      id: 'location',
      name: 'Location',
      description:
        'Claro TV+ region in CITY,STATE format (for example SAO PAULO,SAO PAULO).',
      type: 'string',
      required: true,
      default: 'SAO PAULO,SAO PAULO',
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class ClaroTvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'claro-tv',
      NAME: 'Claro TV+',
      LOGO: '/assets/clarotv_logo.webp',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/claro-tv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from Claro TV+ via clarotvmais.com.br.',
      OPTIONS: claroTvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateClaroTvAddon(options)];
  }
}

function miTvCountryLabel(code: string | undefined): string {
  return (
    MI_TV_COUNTRIES.find((country) => country.code === code)?.name ?? 'Brazil'
  );
}

function generateMiTvAddon(options: Record<string, any>): Addon {
  const country = options.country || 'br';
  const config = {
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    country,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  const customName =
    typeof options.name === 'string' ? options.name.trim() : '';
  const name =
    customName && customName !== 'Mi.tv'
      ? customName
      : `Mi.tv (${miTvCountryLabel(country)})`;
  return {
    name,
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/mi-tv/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
    ],
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'mi-tv', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function miTvOptions(resources: ('catalog' | 'meta')[]): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description:
        'Choose what to use from this source. Select only Stream to match streams to channels from other providers without listing its channels.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'Mi.tv',
    },
    {
      id: 'country',
      name: 'Country',
      description:
        'Mi.tv publishes a separate guide per Latin American country. Add one instance per country.',
      type: 'select',
      required: true,
      showInSimpleMode: true,
      default: 'br',
      options: MI_TV_COUNTRIES.map((country) => ({
        label: country.name,
        value: country.code,
      })),
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class MiTvPreset extends Preset {
  static override get METADATA() {
    const resources = [constants.CATALOG_RESOURCE, constants.META_RESOURCE];
    return {
      ID: 'mi-tv',
      NAME: 'Mi.tv',
      LOGO: '/assets/mitv_logo.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/mi-tv`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live channels and EPG from Mi.tv (Argentina, Brazil, Chile, Colombia, Mexico and other Latin American countries).',
      OPTIONS: miTvOptions(resources),
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateMiTvAddon(options)];
  }
}

export class M3uPreset extends Preset {
  static override getParser(): typeof StreamParser {
    return LiveTvStreamParser;
  }

  static override get METADATA() {
    const resources = [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.STREAM_RESOURCE,
    ];
    return {
      ID: 'm3u',
      NAME: 'M3U',
      LOGO: '',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/m3u`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION: 'Live TV channels and streams from an M3U playlist.',
      OPTIONS: sourceOptions('M3U', resources),
      SUPPORTED_STREAM_TYPES: [constants.LIVE_STREAM_TYPE],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.STREAMS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [
      generateAddon(
        'm3u',
        this.METADATA.NAME,
        this.METADATA.SUPPORTED_RESOURCES,
        options
      ),
    ];
  }
}

function generateXtreamAddon(options: Record<string, any>): Addon {
  const config = {
    url: options.url,
    username: options.username,
    password: options.password,
    timeout: options.timeout || appConfig.presets.defaultTimeout,
    preferredFormat: options.preferredFormat || 'm3u8',
    categoryId: options.categoryId || undefined,
    timeShiftMinutes: options.timeShiftMinutes ?? 0,
  };
  return {
    name: options.name || 'Xtream Codes',
    manifestUrl: `${appConfig.bootstrap.internalUrl}/builtins/live-tv/xtream/${toUrlSafeBase64(JSON.stringify(config))}/manifest.json`,
    enabled: true,
    resources: options.resources || [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.STREAM_RESOURCE,
    ],
    timeout: config.timeout,
    resultPassthrough: true,
    preset: { id: '', type: 'xtream', options },
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  };
}

function xtreamOptions(
  resources: ('catalog' | 'meta' | 'stream')[]
): Option[] {
  return [
    {
      id: 'resources',
      name: 'Resources',
      description:
        'Choose what to use from this source. Select only Stream to match streams to channels from other providers without listing its channels.',
      type: 'multi-select',
      required: false,
      showInSimpleMode: true,
      default: resources,
      options: resources.map((resource) => ({
        label: constants.RESOURCE_LABELS[resource],
        value: resource,
      })),
    },
    {
      id: 'name',
      name: 'Name',
      description: 'What to call this addon',
      type: 'string',
      required: true,
      default: 'Xtream Codes',
    },
    {
      id: 'url',
      name: 'Server URL',
      description: 'Xtream Codes server URL (for example http://example.com:8080)',
      type: 'url',
      required: true,
    },
    {
      id: 'username',
      name: 'Username',
      description: 'Xtream Codes account username',
      type: 'string',
      required: true,
    },
    {
      id: 'password',
      name: 'Password',
      description: 'Xtream Codes account password',
      type: 'password',
      required: true,
    },
    {
      id: 'preferredFormat',
      name: 'Stream format',
      description: 'Preferred container for live channel URLs',
      type: 'select',
      required: true,
      default: 'm3u8',
      options: [
        { label: 'HLS (m3u8)', value: 'm3u8' },
        { label: 'MPEG-TS (ts)', value: 'ts' },
        { label: 'RTMP', value: 'rtmp' },
      ],
    },
    {
      id: 'categoryId',
      name: 'Category ID',
      description:
        'Optional live category ID to limit imported channels. Leave empty to import all categories.',
      type: 'string',
      required: false,
    },
    {
      id: 'timeout',
      name: 'Timeout (ms)',
      description: 'Timeout for API requests',
      type: 'number',
      required: true,
      default: appConfig.presets.defaultTimeout,
      constraints: {
        min: appConfig.userLimits.timeouts.minTimeout,
        max: appConfig.userLimits.timeouts.maxTimeout,
        forceInUi: false,
      },
    },
    epgTimeShiftOption(),
  ];
}

export class XtreamPreset extends Preset {
  static override getParser(): typeof StreamParser {
    return LiveTvStreamParser;
  }

  static override get METADATA() {
    const resources = [
      constants.CATALOG_RESOURCE,
      constants.META_RESOURCE,
      constants.STREAM_RESOURCE,
    ];
    return {
      ID: 'xtream',
      NAME: 'Xtream Codes',
      LOGO: '',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/live-tv/xtream`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Live TV channels, EPG and streams from an Xtream Codes provider.',
      OPTIONS: xtreamOptions(resources),
      SUPPORTED_STREAM_TYPES: [constants.LIVE_STREAM_TYPE],
      SUPPORTED_RESOURCES: resources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.STREAMS,
    };
  }

  static override async generateAddons(
    _userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [generateXtreamAddon(options)];
  }
}
