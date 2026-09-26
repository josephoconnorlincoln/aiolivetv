import app from './app.js';

import {
  config as appConfig,
  createLogger,
  initDb,
  initialiseConfig,
  closeDb,
  UserRepository,
  logStartupInfo,
  Cache,
  RegexAccess,
  SelAccess,
  ConfigStartupError,
  TemplateManager,
  maskSensitiveInfo,
  constants,
  ensureConfigAccessKey,
  startAnalytics,
  stopAnalytics,
  TaskManager,
  isEphemeralRuntime,
} from '@aiolivetv/core';
import { randomBytes } from 'crypto';

const logger = createLogger('server');

async function initialiseDatabase() {
  try {
    await initDb(appConfig.bootstrap.databaseUri);
    await initialiseConfig();
  } catch (error) {
    if (error instanceof ConfigStartupError) throw error;
    logger.error('Failed to initialise database:', error);
    throw error;
  }
}

function registerPruneTask() {
  const maxDays = appConfig.tasks.pruning.maxDays;
  TaskManager.register({
    id: 'prune-users',
    label: 'Prune inactive users',
    description:
      'Deletes user configs that have not been accessed within the configured window.',
    category: 'users',
    kind: 'scheduled',
    intervalMs: appConfig.tasks.pruning.interval * 1000,
    enabled: maxDays >= 0,
    destructive: true,
    multiReplica: 'single',
    run: async () => {
      if (appConfig.tasks.pruning.maxDays < 0)
        return { ok: true, message: 'pruning disabled' };
      const n = await UserRepository.pruneUsers(
        appConfig.tasks.pruning.maxDays
      );
      return { ok: true, message: `pruned ${n} users` };
    },
  });
}

function registerCacheTasks() {
  TaskManager.register({
    id: 'clear-all-cache',
    label: 'Clear all cache',
    description: 'Wipes every registered cache backend. Destructive.',
    category: 'cache',
    kind: 'manual',
    enabled: true,
    destructive: true,
    multiReplica: 'all',
    run: async () => {
      await Cache.clearAll();
      return { ok: true, message: 'cache cleared' };
    },
  });
  TaskManager.register({
    id: 'clear-expired-cache',
    label: 'Clear expired cache keys',
    description: 'Deletes expired SQL cache rows (memory/redis self-expire).',
    category: 'cache',
    kind: 'manual',
    enabled: true,
    destructive: false,
    multiReplica: 'single',
    run: async () => {
      const n = await Cache.clearExpired();
      return { ok: true, message: `removed ${n} expired rows` };
    },
  });
}

async function initialiseRedis() {
  if (appConfig.bootstrap.redisUri) {
    await Cache.testRedisConnection();
  }
}

async function initialiseTemplates() {
  try {
    await TemplateManager.loadTemplates();
  } catch (error) {
    logger.error('Failed to initialise templates:', error);
  }
}

async function initialiseAuth() {
  await ensureConfigAccessKey();
  if (appConfig.nzbProxy.publicEnabled) {
    appConfig.bootstrap.auth.set(
      constants.PUBLIC_NZB_PROXY_USERNAME,
      appConfig.bootstrap.auth.get(constants.PUBLIC_NZB_PROXY_USERNAME) ||
        randomBytes(32).toString('hex')
    );
    logger.info('Public NZB Proxy is enabled.', {
      username: constants.PUBLIC_NZB_PROXY_USERNAME,
      password: maskSensitiveInfo(
        appConfig.bootstrap.auth.get(constants.PUBLIC_NZB_PROXY_USERNAME) || ''
      ),
    });
  }
}

async function start() {
  try {
    await initialiseDatabase();
    await initialiseTemplates();
    logStartupInfo();
    await initialiseRedis();
    RegexAccess.initialise();
    SelAccess.initialise();
    registerPruneTask();
    registerCacheTasks();
    await initialiseAuth();
    startAnalytics();
    if (isEphemeralRuntime()) {
      if (appConfig.proxy.default.enabled || appConfig.proxy.force.enabled) {
        logger.warn(
          'Built-in media proxy is enabled. On Vercel, video bytes should not flow through the Function; disable the proxy and return source URLs to Stremio.'
        );
      }
    }
    let server: ReturnType<typeof app.listen>;
    const onListen = (error?: Error) => {
      if (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
      }
      logger.info(
        `Server running on port ${appConfig.bootstrap.port}: ${JSON.stringify(server.address())}`
      );
    };
    // Dokku/Beamup reach the container by its IPv4 address. Binding only the
    // IPv6 wildcard makes that preflight check miss the process.
    server = app.listen(appConfig.bootstrap.port, '0.0.0.0', onListen);
  } catch (error) {
    if (error instanceof ConfigStartupError) throw error;
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

async function shutdown() {
  TaskManager.stopAll();
  await stopAnalytics().catch(() => undefined);
  await Cache.close();
  RegexAccess.cleanup();
  SelAccess.cleanup();
  await closeDb();
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  await shutdown();
  process.exit(0);
});

start().catch((error) => {
  if (error instanceof ConfigStartupError) {
    // The message is already a pre-formatted human-friendly banner — print
    // it verbatim and exit 1 without dumping a node stack trace.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  logger.error('Failed to start server:', error);
  process.exit(1);
});
