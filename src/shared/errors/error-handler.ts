import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { AppError } from './app-error.js';
import { logger } from '../logger/logger.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, req: any, res, _next) => {
  // Erros de validação: registrar metadados (não o payload completo)
  if (error instanceof ZodError) {
    logger.info({ requestId: req.id, url: req.url, method: req.method, issues: error.issues }, 'Validation error');
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Payload inválido',
      requestId: req.id,
      details: error.issues
    });
  }

  // Erros da aplicação (esperados) — registrar como warn
  if (error instanceof AppError) {
    logger.warn({ requestId: req.id, code: error.code, statusCode: error.statusCode, url: req.url }, 'Application error');
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      requestId: req.id
    });
  }

  // Erro inesperado — registrar stack e retornar resposta genérica
  logger.error({ requestId: req.id, err: error instanceof Error ? { message: error.message, stack: error.stack } : error, url: req.url }, 'Unhandled error');
  return res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Erro interno não tratado',
    requestId: req.id
  });
};
