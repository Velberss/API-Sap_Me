import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Middleware que gera um requestId único para cada requisição
 * e o adiciona ao objeto request para uso em logs e headers.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Gerar ou usar requestId do header (se já existir)
  const requestId = req.headers['x-request-id'] as string || randomUUID();
  
  // Adicionar ao request object para acesso posterior
  (req as any).id = requestId;
  
  // Adicionar ao header de resposta para rastreamento cliente
  res.setHeader('X-Request-ID', requestId);
  
  next();
};
