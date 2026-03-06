import { ISapAuthProvider, AuthSession } from '../../domain/interfaces/sap-auth.interface.js';
import { env } from '../../shared/config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

export class AuthSessionManager {
  private currentSession: AuthSession | null = null;

  constructor(private readonly authProvider: ISapAuthProvider) {}

  async getValidSession(): Promise<AuthSession> {
    if (this.currentSession && this.currentSession.expiresAt > Date.now()) {
      return this.currentSession;
    }

    let attempts = 0;
    let lastError: unknown;

    while (attempts < env.SAP_LOGIN_MAX_ATTEMPTS) {
      attempts += 1;
      try {
        this.currentSession = await this.authProvider.login();
        return this.currentSession;
      } catch (error) {
        lastError = error;
        await this.sleep(attempts * 1000);
      }
    }

    throw new AppError(
      `Não foi possível autenticar no SAP após ${env.SAP_LOGIN_MAX_ATTEMPTS} tentativas: ${
        lastError instanceof Error ? lastError.message : 'erro desconhecido'
      }`,
      424,
      'SAP_AUTH_DEPENDENCY_FAILED'
    );
  }

  invalidateSession(): void {
    this.currentSession = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
