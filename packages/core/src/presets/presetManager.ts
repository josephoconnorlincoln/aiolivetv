import { PresetMetadata, PresetMinimalMetadata } from '../db/index.js';
import { CustomPreset } from './custom.js';
import { DebridioTvPreset } from './debridioTv.js';
import { FrostViewPreset } from './frostView.js';
import { FenixTvPreset } from './fenixTv.js';
import { MinhaTvPreset } from './minhaTv.js';
import { ArgentinaTVPreset } from './argentinaTv.js';
import { USATVPreset } from './usaTv.js';
import { Preset } from './preset.js';
import {
  M3uPreset,
  ClaroTvPreset,
  MiTvPreset,
  VivoTvPreset,
  MovistarTvPreset,
  TvpPreset,
  DirectvPreset,
  XmltvPreset,
  XtreamPreset,
} from './liveTv.js';

const PRESETS = {
  m3u: M3uPreset,
  xmltv: XmltvPreset,
  xtream: XtreamPreset,
  'vivo-tv': VivoTvPreset,
  'movistar-tv': MovistarTvPreset,
  tvp: TvpPreset,
  directv: DirectvPreset,
  'claro-tv': ClaroTvPreset,
  'mi-tv': MiTvPreset,
  custom: CustomPreset,
  'frost-view': FrostViewPreset,
  'fenix-tv': FenixTvPreset,
  'minha-tv': MinhaTvPreset,
  'usa-tv': USATVPreset,
  'argentina-tv': ArgentinaTVPreset,
  'debridio-tv': DebridioTvPreset,
} as const satisfies Record<string, typeof Preset>;

const PRESET_LIST: string[] = Object.keys(PRESETS);

export class PresetManager {
  static getPresetList(): PresetMinimalMetadata[] {
    return PRESET_LIST.map((presetId) => this.fromId(presetId).METADATA).map(
      (metadata: PresetMetadata) => ({
        ID: metadata.ID,
        NAME: metadata.NAME,
        LOGO: metadata.LOGO,
        DESCRIPTION: metadata.DESCRIPTION,
        SUPPORTED_RESOURCES: metadata.SUPPORTED_RESOURCES,
        SUPPORTED_STREAM_TYPES: metadata.SUPPORTED_STREAM_TYPES,
        SUPPORTED_SERVICES: metadata.SUPPORTED_SERVICES,
        OPTIONS: metadata.OPTIONS,
        BUILTIN: metadata.BUILTIN,
        DISABLED: metadata.DISABLED,
        CATEGORY: metadata.CATEGORY,
      })
    );
  }

  static has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(PRESETS, id);
  }

  static fromId(id: string): typeof Preset {
    const preset = PRESETS[id as keyof typeof PRESETS];
    if (!preset) {
      throw new Error(`Preset ${id} not found`);
    }
    return preset;
  }
}
