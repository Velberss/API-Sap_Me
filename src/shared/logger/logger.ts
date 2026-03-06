import pino from 'pino';

import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redigir campos sensíveis para evitar vazamento em logs estruturados
  redact: [
    // cabeçalhos HTTP que podem conter tokens/cookies
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["set-cookie"]',
    // campos óbvios de credenciais
    'password',
    'sapPassword',
    'authorization',
    'cookies',
    'set-cookie'
  ]
});
