import { KnowledgeSearchResult } from '../entities/knowledge-search.entity.js';
import { AuthSession } from './sap-auth.interface.js';

export interface ISapSearchAutomation {
  searchKnowledgeBase(query: string, session: AuthSession): Promise<KnowledgeSearchResult>;
}
