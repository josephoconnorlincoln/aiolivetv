import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  APIError,
  config as appConfig,
  constants,
  UserData,
} from '@aiolivetv/core';
import { Manifest } from '@aiolivetv/core';
import { createLogger } from '@aiolivetv/core';
import { corsMiddleware } from '../../middlewares/cors.js';
import { stremioManifestRateLimiter } from '../../middlewares/ratelimit.js';

const logger = createLogger('server');
const router: Router = Router();

export default router;

router.use(corsMiddleware);
router.use(stremioManifestRateLimiter);

const manifest = async (config?: UserData): Promise<Manifest> => {
  let addonId = appConfig.branding.addonId;
  if (config) {
    addonId = addonId += `.${config.uuid?.substring(0, 12)}`;
  }
  let catalogs: Manifest['catalogs'] = [];
  let resources: Manifest['resources'] = [];
  let addonCatalogs: Manifest['addonCatalogs'] = [];
  let epgProvider = false;
  if (config) {
    const aiostreams = new AIOStreams(config, { skipFailedAddons: true });

    await aiostreams.initialise();

    catalogs = aiostreams.getCatalogs();
    resources = aiostreams.getResources();
    addonCatalogs = aiostreams.getAddonCatalogs();
    epgProvider = aiostreams.hasEpgProvider();
  } else {
    // Beamup and Stremio require a manifest with at least one resource.
    // The unconfigured addon still asks the user to finish setup.
    resources = ['catalog', 'meta', 'stream'];
    catalogs = [
      {
        type: constants.TV_TYPE,
        id: 'aiolivetv',
        name: appConfig.branding.addonName,
      },
    ];
  }
  return {
    name: config?.addonName || appConfig.branding.addonName,
    id: addonId,
    version:
      appConfig.bootstrap.version === 'unknown'
        ? '0.0.0'
        : appConfig.bootstrap.version,
    description: config?.addonDescription || appConfig.bootstrap.description,
    catalogs,
    resources,
    types: [constants.TV_TYPE],
    logo:
      config?.addonLogo ||
      `https://raw.githubusercontent.com/mrcanelas/aiolivetv/refs/heads/main/packages/frontend/public/logo${
        appConfig.branding.alternateDesign ? '_alt' : ''
      }.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: config ? false : true,
      epgProvider: epgProvider || undefined,
    },
    addonCatalogs,
    stremioAddonsConfig:
      appConfig.api.stremioAddonsConfigIssuer &&
      appConfig.api.stremioAddonsConfigSignature
        ? {
            issuer: appConfig.api.stremioAddonsConfigIssuer,
            signature: appConfig.api.stremioAddonsConfigSignature,
          }
        : undefined,
  };
};

router.get(
  '/',
  async (req: Request, res: Response<Manifest>, next: NextFunction) => {
    logger.info({ uuid: req.userData?.uuid }, 'received request for manifest');
    try {
      res.status(200).json(await manifest(req.userData));
    } catch (error) {
      logger.error(`Failed to generate manifest: ${error}`);
      next(new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR));
    }
  }
);
