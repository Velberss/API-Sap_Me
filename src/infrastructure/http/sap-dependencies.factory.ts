import { KnowledgeSearchUseCase } from '../../application/use-cases/knowledge-search.use-case.js';
import { AuthSessionManager } from '../auth/auth-session-manager.js';
import { SapAuthProvider } from '../auth/sap-auth.provider.js';
import { SapSearchAutomation } from '../automation/sap-search.automation.js';

export const makeSapDependencies = () => {
  const sapAuthProvider = new SapAuthProvider();
  const authSessionManager = new AuthSessionManager(sapAuthProvider);
  const sapSearchAutomation = new SapSearchAutomation();
  const knowledgeSearchUseCase = new KnowledgeSearchUseCase(authSessionManager, sapSearchAutomation);

  return {
    knowledgeSearchUseCase
  };
};
