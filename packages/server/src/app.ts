import express, { Request, Response, Express } from 'express';
import {
  userApi,
  healthApi,
  statusApi,
  formatApi,
  catalogApi,
  postersApi,
  proxyApi,
  templatesApi,
  syncApi,
  authApi,
  dashboardApi,
} from './routes/api/index.js';
import {
  configure,
  manifest,
  stream,
  catalog,
  meta,
  subtitle,
  addonCatalog,
  alias,
} from './routes/stremio/index.js';
import { liveTv } from './routes/builtins/index.js';
import {
  ipMiddleware,
  loggerMiddleware,
  userDataMiddleware,
  errorMiddleware,
  corsMiddleware,
  staticRateLimiter,
  internalMiddleware,
  stremioStreamRateLimiter,
  requireSessionIfAuthRequired,
  requestBoundaryMiddleware,
} from './middlewares/index.js';

import {
  config as appConfig,
  constants,
  createLogger,
  Env,
} from '@aiolivetv/core';
import { StremioTransformer } from '@aiolivetv/core';
import { createResponse } from './utils/responses.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import internalTasksApi from './routes/api/internal-tasks.js';
const app: Express = express();
const logger = createLogger('server');

export enum StaticFiles {
  DOWNLOAD_FAILED = 'download_failed.mp4',
  DOWNLOADING = 'downloading.mp4',
  UNAVAILABLE_FOR_LEGAL_REASONS = 'unavailable_for_legal_reasons.mp4',
  STORE_LIMIT_EXCEEDED = 'store_limit_exceeded.mp4',
  CONTENT_PROXY_LIMIT_REACHED = 'content_proxy_limit_reached.mp4',
  INTERNAL_SERVER_ERROR = '500.mp4',
  TOO_MANY_REQUESTS = '429.mp4',
  FORBIDDEN = '403.mp4',
  UNAUTHORIZED = '401.mp4',
  NO_MATCHING_FILE = 'no_matching_file.mp4',
  PAYMENT_REQUIRED = 'payment_required.mp4',
  OK = '200.mp4',
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** UserData with Live TV channel mappings can exceed Express's 100kb default. */
const JSON_BODY_LIMIT = '5mb';

export const frontendRoot = path.join(__dirname, '../../frontend/dist');
export const staticRoot = path.join(__dirname, './static');

app.use(ipMiddleware);
app.use(loggerMiddleware);
app.use(requestBoundaryMiddleware);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

// Allow all origins in development for easier testing
if (appConfig.bootstrap.nodeEnv === 'development') {
  logger.info('CORS enabled for all origins in development');
  app.use(corsMiddleware);
}

// API Routes
const apiRouter = express.Router();
apiRouter.use('/user', userApi);
apiRouter.use('/health', healthApi);
apiRouter.use('/status', statusApi);
apiRouter.use('/format', formatApi);
apiRouter.use('/catalogs', catalogApi);
apiRouter.use('/posters', postersApi);
apiRouter.use('/proxy', proxyApi);
apiRouter.use('/templates', templatesApi);
apiRouter.use('/sync', syncApi);
apiRouter.use('/auth', authApi);
apiRouter.use('/dashboard', dashboardApi);
apiRouter.use((req, res) => {
  res.status(404).json(
    createResponse({
      success: false,
      detail: 'Not Found',
    })
  );
});

app.use(`/api/v${constants.API_VERSION}`, apiRouter);
app.use('/api/internal/tasks', internalTasksApi);

// Stremio Routes
const stremioRouter = express.Router({ mergeParams: true });
stremioRouter.use(corsMiddleware);
// Public routes - no auth needed
stremioRouter.use('/manifest.json', manifest);
stremioRouter.use('/stream', stream);
stremioRouter.use('/configure', requireSessionIfAuthRequired, configure);

stremioRouter.use('/u', alias);

// Protected routes with authentication
const stremioAuthRouter = express.Router({ mergeParams: true });
stremioAuthRouter.use(corsMiddleware);
stremioAuthRouter.use(userDataMiddleware);
stremioAuthRouter.use('/manifest.json', manifest);
stremioAuthRouter.use('/stream', stream);
stremioAuthRouter.use('/configure', requireSessionIfAuthRequired, configure);
stremioAuthRouter.use('/meta', meta);
stremioAuthRouter.use('/catalog', catalog);
stremioAuthRouter.use('/subtitles', subtitle);
stremioAuthRouter.use('/addon_catalog', addonCatalog);

app.use('/stremio', stremioRouter); // For public routes
app.use('/stremio/:uuid/:encryptedPassword', stremioAuthRouter); // For authenticated routes

// Beamup compatibility.
// Beamup validates Stremio addons by checking the root /manifest.json.
// AIOLiveTV keeps the normal public route at /stremio/manifest.json too.
app.use('/manifest.json', manifest);

const builtinsRouter = express.Router();
builtinsRouter.use(internalMiddleware);
builtinsRouter.use('/live-tv', liveTv);
app.use('/builtins', builtinsRouter);

// Content-hashed build assets. These filenames change on every content
// change, so they are immutable and safe to cache aggressively. Deliberately
// NOT behind staticRateLimiter: a single page load pulls many of these and
// rate-limiting them is what caused asset fetch failures + the logo flash.
app.get('/assets/*any', (req, res, next) => {
  const filePath = path.resolve(frontendRoot, req.path.replace(/^\//, ''));
  if (filePath.startsWith(frontendRoot) && fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(filePath);
    return;
  }
  next();
});

// Root-level static files (not content-hashed). Short cache; kept behind the
// static rate limiter. The logo honours the alternate-design branding flag.
app.get('/logo.png', staticRateLimiter, (req, res, next) => {
  const filePath = path.resolve(
    frontendRoot,
    appConfig.branding.alternateDesign ? 'logo_alt.png' : 'logo.png'
  );
  if (filePath.startsWith(frontendRoot) && fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
    return;
  }
  next();
});
app.get('/favicon.ico', staticRateLimiter, (req, res, next) => {
  const filePath = path.resolve(frontendRoot, 'favicon.png');
  if (filePath.startsWith(frontendRoot) && fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('image/png');
    res.sendFile(filePath);
    return;
  }
  next();
});
app.get(
  [
    '/favicon.png',
    '/site.webmanifest',
    '/web-app-manifest-192x192.png',
    '/web-app-manifest-512x512.png',
    '/apple-icon.png',
    '/mini-nightly-white.png',
    '/mini-stable-white.png',
    '/icon1.png',
    '/logo_alt.png',
  ],
  staticRateLimiter,
  (req, res, next) => {
    const filePath = path.resolve(frontendRoot, req.path.replace(/^\//, ''));
    if (filePath.startsWith(frontendRoot) && fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(filePath);
      return;
    }
    next();
  }
);

app.get('/static/*any', corsMiddleware, (req, res, next) => {
  const filePath = path.resolve(
    staticRoot,
    req.path.replace(/^\/static\//, '')
  );
  logger.debug(`Static file requested: ${filePath}`);
  if (filePath.startsWith(staticRoot) && fs.existsSync(filePath)) {
    res.sendFile(filePath);
    return;
  }
  next();
});

// legacy route handlers
app.get(
  '{/:config}/stream/:type/:id.json',
  stremioStreamRateLimiter,
  (req, res) => {
    const baseUrl =
      appConfig.bootstrap.baseUrl ||
      `${req.protocol}://${req.hostname}${
        req.hostname === 'localhost' ? `:${appConfig.bootstrap.port}` : ''
      }`;
    res.json({
      streams: [
        StremioTransformer.createErrorStream({
          errorDescription:
            'AIOLiveTV requires you to reconfigure. Please click this stream to reconfigure.',
          errorUrl: `${baseUrl}/stremio/configure`,
        }),
      ],
    });
  }
);

// redirect for legacy paths
app.get('{/:config}/configure', (req, res) => {
  res.redirect('/stremio/configure');
});

app.get('/configure', (req, res) => {
  res.redirect('/stremio/configure');
});

// SPA route validation: returns true for paths that exist in the client-side router.
const SPA_STATIC_ROUTES = [
  '/',
  '/login',
  '/splashscreen',
  '/stremio/configure',
];

const SPA_DYNAMIC_PATTERNS: RegExp[] = [
  /^\/stremio\/[^/]+\/[^/]+\/configure$/,
  /^\/dashboard(\/.*)?$/,
];

function isValidSpaRoute(routePath: string): boolean {
  if (SPA_STATIC_ROUTES.includes(routePath)) {
    return true;
  }
  return SPA_DYNAMIC_PATTERNS.some((pattern) => pattern.test(routePath));
}

// SPA fallback.
app.get('*splat', staticRateLimiter, (req, res, next) => {
  if (req.method !== 'GET' || !req.accepts('html')) {
    next();
    return;
  }
  const indexPath = path.join(frontendRoot, 'index.html');
  if (fs.existsSync(indexPath)) {
    const status = isValidSpaRoute(req.path) ? 200 : 404;
    res
      .status(status)
      .setHeader('Cache-Control', 'no-cache')
      .sendFile(indexPath);
    return;
  }
  next();
});

// Error handling middleware should be last
app.use(errorMiddleware);

export default app;
