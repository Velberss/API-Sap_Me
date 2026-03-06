import { createApp } from './app.js';
import { env } from './shared/config/env.js';
import { logger } from './shared/logger/logger.js';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'API SAP Knowledge Search iniciada');
});
