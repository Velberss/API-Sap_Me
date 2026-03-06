import {
  KnowledgeSearchInput,
  KnowledgeSearchResult
} from '../../domain/entities/knowledge-search.entity.js';
import { ISapSearchAutomation } from '../../domain/interfaces/sap-search.interface.js';
import { AuthSessionManager } from '../../infrastructure/auth/auth-session-manager.js';
import { logger } from '../../shared/logger/logger.js';

export class KnowledgeSearchUseCase {
  constructor(
    private readonly sessionManager: AuthSessionManager,
    private readonly sapSearchAutomation: ISapSearchAutomation
  ) {}

  async execute(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    const query = input.query.trim();
    logger.info({ query }, 'Iniciando busca na base SAP');

    const session = await this.sessionManager.getValidSession();
    const result = await this.sapSearchAutomation.searchKnowledgeBase(query, session);

    logger.info({ articleCount: result.articles.length, hasGeneratedAnswer: !!result.generatedAnswer }, 'Busca concluída');
    return result;
  }
}
