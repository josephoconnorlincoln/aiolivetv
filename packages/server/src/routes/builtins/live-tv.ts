import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  fromUrlSafeBase64,
  M3uAddon,
  XmltvAddon,
  VivoTvAddon,
  MovistarTvAddon,
  TvpAddon,
  DirectvAddon,
  ClaroTvAddon,
  MiTvAddon,
  XtreamAddon,
  parseCatalogExtras,
  type LiveTvSourceConfig,
  type VivoTvConfig,
  type MovistarTvConfig,
  type TvpTvConfig,
  type DirectvConfig,
  type ClaroTvConfig,
  type MiTvConfig,
  type XtreamConfig,
} from '@aiolivetv/core';

const router: Router = Router();

interface ResourceParams {
  encodedConfig: string;
  type: string;
  id: string;
  extras?: string;
}

function config(encodedConfig: string): LiveTvSourceConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function vivoConfig(encodedConfig: string): VivoTvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function movistarConfig(encodedConfig: string): MovistarTvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function tvpConfig(encodedConfig: string): TvpTvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function directvConfig(encodedConfig: string): DirectvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function claroConfig(encodedConfig: string): ClaroTvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function miTvConfig(encodedConfig: string): MiTvConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

function xtreamConfig(encodedConfig: string): XtreamConfig {
  return JSON.parse(fromUrlSafeBase64(encodedConfig));
}

router.get('/:source/:encodedConfig/manifest.json', async (req, res, next) => {
  try {
    const addon =
      req.params.source === 'xmltv'
        ? new XmltvAddon(config(req.params.encodedConfig))
        : req.params.source === 'm3u'
          ? new M3uAddon(config(req.params.encodedConfig))
          : req.params.source === 'xtream'
            ? new XtreamAddon(xtreamConfig(req.params.encodedConfig))
          : req.params.source === 'vivo-tv'
            ? new VivoTvAddon(vivoConfig(req.params.encodedConfig))
          : req.params.source === 'movistar-tv'
            ? new MovistarTvAddon(movistarConfig(req.params.encodedConfig))
            : req.params.source === 'tvp'
              ? new TvpAddon(tvpConfig(req.params.encodedConfig))
            : req.params.source === 'directv'
              ? new DirectvAddon(directvConfig(req.params.encodedConfig))
            : req.params.source === 'claro-tv'
              ? new ClaroTvAddon(claroConfig(req.params.encodedConfig))
              : req.params.source === 'mi-tv'
                ? new MiTvAddon(miTvConfig(req.params.encodedConfig))
                : undefined;
    if (!addon) throw new Error(`Unsupported source: ${req.params.source}`);
    res.json(await Promise.resolve(addon.getManifest()));
  } catch (error) {
    next(error);
  }
});

router.get(
  '/xmltv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new XmltvAddon(
        config(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/xmltv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new XmltvAddon(
        config(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/m3u/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const extras = parseCatalogExtras(req.params.extras);
      const metas = await new M3uAddon(
        config(req.params.encodedConfig)
      ).getCatalog(extras.skip, extras.genre);
      res.json({
        metas,
        cacheMaxAge: 300,
        staleRevalidate: 1800,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/m3u/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new M3uAddon(config(req.params.encodedConfig)).getMeta(
        req.params.id
      );
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/m3u/:encodedConfig/stream/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const streams = await new M3uAddon(
        config(req.params.encodedConfig)
      ).getStreams(req.params.id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/xtream/:encodedConfig/stream/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const streams = await new XtreamAddon(
        xtreamConfig(req.params.encodedConfig)
      ).getStreams(req.params.id);
      res.json({ streams });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/xtream/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date, genre } = parseCatalogExtras(req.params.extras);
      const response = await new XtreamAddon(
        xtreamConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date, genre);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/xtream/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new XtreamAddon(
        xtreamConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/vivo-tv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new VivoTvAddon(
        vivoConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/vivo-tv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new VivoTvAddon(
        vivoConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/movistar-tv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new MovistarTvAddon(
        movistarConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/movistar-tv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new MovistarTvAddon(
        movistarConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tvp/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new TvpAddon(
        tvpConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tvp/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new TvpAddon(
        tvpConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/directv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new DirectvAddon(
        directvConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/directv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new DirectvAddon(
        directvConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/claro-tv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date, genre } = parseCatalogExtras(req.params.extras);
      const response = await new ClaroTvAddon(
        claroConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date, genre);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/claro-tv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new ClaroTvAddon(
        claroConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/mi-tv/:encodedConfig/catalog/:type/:id{/:extras}.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const { skip, date } = parseCatalogExtras(req.params.extras);
      const response = await new MiTvAddon(
        miTvConfig(req.params.encodedConfig)
      ).getCatalogResponse(skip, date);
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/mi-tv/:encodedConfig/meta/:type/:id.json',
  async (req: Request<ResourceParams>, res: Response, next: NextFunction) => {
    try {
      const meta = await new MiTvAddon(
        miTvConfig(req.params.encodedConfig)
      ).getMeta(req.params.id);
      res.json({
        meta,
        cacheMaxAge: 900,
        staleRevalidate: 3600,
        staleError: 604800,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
