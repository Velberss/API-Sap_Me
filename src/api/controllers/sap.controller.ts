import { Request, Response, NextFunction } from 'express';

import { KnowledgeSearchUseCase } from '../../application/use-cases/knowledge-search.use-case.js';
import { knowledgeSearchSchema, knowledgeSearchResponseSchema } from '../validators/knowledge-search.schema.js';
import { logger } from '../../shared/logger/logger.js';

export class SapController {
  constructor(private readonly knowledgeSearchUseCase: KnowledgeSearchUseCase) {}

  knowledgeSearch = async (req: any, res: Response, next: NextFunction): Promise<void> => {
    try {
      const payload = knowledgeSearchSchema.parse(req.body);
      const result = await this.knowledgeSearchUseCase.execute(payload);

      // Validar resposta contra schema para garantir conformidade
      const validatedResponse = knowledgeSearchResponseSchema.parse(result);
      
      logger.info({ requestId: req.id, articleCount: validatedResponse.articles.length, hasGeneratedAnswer: !!validatedResponse.generatedAnswer }, 'Search response validated and returning');
      res.status(200).json(validatedResponse);
    } catch (error) {
      next(error);
    }
  };
}
