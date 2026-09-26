import type { MenuId } from '../../../core/src/utils/fieldMeta';

/** Top-level configure pages for the AIOLiveTV scope (see AGENTS.md). */
export const CONFIGURE_VISIBLE_MENUS = [
  'about',
  'addons',
  'channels',
  'formatter',
  'miscellaneous',
  'save-install',
] as const satisfies readonly MenuId[];

const VISIBLE_MENU_SET = new Set<string>(CONFIGURE_VISIBLE_MENUS);

export function isConfigureMenuVisible(menu: MenuId): boolean {
  return VISIBLE_MENU_SET.has(menu);
}

/** Miscellaneous sub-tabs kept for Live TV (hide vod preload/background tuning). */
export const CONFIGURE_VISIBLE_MISC_SUB_TABS = [
  'playback',
  'display',
  'parent',
] as const;

export const CONFIGURE_DEFAULT_MISC_SUB_TAB = 'playback' as const;

/** Presets shown in the Addons marketplace for AIOLiveTV. */
export const LIVE_TV_MARKETPLACE_PRESET_IDS = [
  'm3u',
  'xmltv',
  'xtream',
  'vivo-tv',
  'movistar-tv',
  'tvp',
  'directv',
  'claro-tv',
  'mi-tv',
  'custom',
  'frost-view',
  'fenix-tv',
  'usa-tv',
  'argentina-tv',
  'debridio-tv',
] as const;

const MARKETPLACE_PRESET_SET = new Set<string>(LIVE_TV_MARKETPLACE_PRESET_IDS);

export function isLiveTvMarketplacePreset(presetId: string): boolean {
  return MARKETPLACE_PRESET_SET.has(presetId);
}
