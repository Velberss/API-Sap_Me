import express from 'express';
import { pinoHttp } from 'pino-http';

import { sapRouter } from './api/routes/sap.routes.js';
import { logger } from './shared/logger/logger.js';
import { requestIdMiddleware } from './shared/middleware/request-id.middleware.js';
import { errorHandler } from './shared/errors/error-handler.js';

export const createApp = () => {
  const app = express();

  // CORS — permite frontend local em dev; restringir em produção
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware);
  app.use(pinoHttp({ logger, genReqId: (req: any) => req.id }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/', sapRouter);
  app.use(errorHandler);

  return app;
};
