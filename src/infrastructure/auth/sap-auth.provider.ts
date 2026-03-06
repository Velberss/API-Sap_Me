import { chromium, Page, BrowserContext } from 'playwright';

import { AuthSession, ISapAuthProvider, SapCookie } from '../../domain/interfaces/sap-auth.interface.js';
import { env } from '../../shared/config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import { logger } from '../../shared/logger/logger.js';
import { STEALTH_ARGS, REAL_USER_AGENT } from '../browser/stealth.js';

/**
 * Fluxo de autenticação alinhado ao comportamento real do portal SAP:
 *
 * 1. Navega para https://me.sap.com/home (ponto de entrada real do usuário).
 * 2. O portal (SPA UI5) detecta que não há sessão ativa e redireciona
 *    automaticamente para o SAP ID Service via cadeia SAML.
 * 3. Aguardamos o formulário de login aparecer (campo de e-mail).
 * 4. Preenchemos e-mail → Continuar → senha → Submit.
 * 5. O SAP ID redireciona de volta para me.sap.com com os tokens de sessão.
 * 6. Confirmamos que o ciclo SAML completou antes de prosseguir.
 */
export class SapAuthProvider implements ISapAuthProvider {

  /** URL de entrada — mesmo ponto que um usuário real acessaria */
  private readonly PORTAL_HOME = 'https://me.sap.com/home';



  async login(): Promise<AuthSession> {
    const browser = await chromium.launch({
      headless: env.SAP_BROWSER_HEADLESS,
      args: STEALTH_ARGS
    });

    try {
      const context = await browser.newContext({
        userAgent: REAL_USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR'
      });

      const page = await context.newPage();

      // ─── Logger de navegação: rastrear toda a cadeia de redirects ──────
      if (env.NODE_ENV === 'development') {
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            logger.info({ url: frame.url() }, '[nav] Página navegou para');
          }
        });
      }

      // ─── Etapa 1: Navegar para me.sap.com/home ──────────────────────────
      // Usamos domcontentloaded para permitir que o HTML da SPA carregue.
      // O UI5 irá inicializar e redirecionar via JS se não houver sessão.
      logger.info('Etapa 1 — Navegando para me.sap.com/home (ponto de entrada real) …');
      await page.goto(this.PORTAL_HOME, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });

      // Aguardar a SPA UI5 carregar e o redirect SAML acontecer.
      // O portal faz: load HTML → init UI5 → check auth → JS redirect
      // networkidle aguarda todos os requests estabilizarem.
      logger.info('Aguardando SPA carregar e redirect SAML completar …');
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
        logger.warn('networkidle timeout na Etapa 1 — tentando prosseguir …');
      });

      logger.info({ url: page.url() }, 'Página estabilizada após navegação inicial');

      // ─── Etapa 2: Determinar estado — autenticado ou redirect para login ─
      const isAuthenticated = await this.checkIfAuthenticated(page);

      if (isAuthenticated) {
        logger.info('Sessão já está ativa — não é necessário login');
      } else {
        // Verificar se estamos na página de erro "link inválido"
        const isErrorPage = await this.isInvalidLinkPage(page);
        if (isErrorPage) {
          logger.warn('Detectado erro "link inválido" — tentando fluxo alternativo …');
          // Re-navegar para o portal, desta vez aguardando load completo
          await this.recoverFromInvalidLink(page);
        }

        // ─── Etapa 3: Preencher formulário de login ───────────────────────
        await this.waitForAndFillLoginForm(page);
      }

      // ─── Etapa 4: Confirmar autenticação concluída ─────────────────────
      logger.info('Etapa 4 — Aguardando redirect final para me.sap.com …');
      try {
        await page.waitForURL((url) => {
          const href = url.toString();
          return href.includes('me.sap.com') && !href.includes('accounts.sap.com');
        }, { timeout: 90_000 });
      } catch {
        // Pode ser que já estamos no me.sap.com — verificar
        const finalUrl = page.url();
        if (!finalUrl.includes('me.sap.com') || finalUrl.includes('accounts.sap.com')) {
          throw new AppError(
            `Redirect pós-autenticação não completou. URL atual: ${finalUrl}`,
            401,
            'SAP_AUTH_REDIRECT_FAILED'
          );
        }
      }

      // Aguardar a página do portal estabilizar minimamente (a SPA UI5 nunca
      // atinge networkidle real, então usamos timeout curto apenas como buffer)
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {
        logger.warn('networkidle timeout pós-autenticação — OK, prosseguindo …');
      });

      const finalUrl = page.url();
      logger.info({ url: finalUrl }, 'Autenticação concluída com sucesso');

      // ─── Etapa 5: Extrair cookies de sessão ────────────────────────────
      return await this.extractSessionCookies(context);

    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        `Erro ao autenticar no SAP: ${error instanceof Error ? error.message : 'desconhecido'}`,
        401,
        'SAP_AUTH_FAILED'
      );
    } finally {
      await browser.close();
    }
  }

  /**
   * Verifica se já estamos autenticados (URL está em me.sap.com sem redirect).
   */
  private async checkIfAuthenticated(page: Page): Promise<boolean> {
    const url = page.url();
    // Se a URL ainda está em me.sap.com e não em accounts.sap.com → autenticado
    if (url.includes('me.sap.com') && !url.includes('accounts.sap.com')) {
      // Verificar se a página realmente renderizou (não é uma SPA em loading)
      const hasShell = await page.locator('[class*="sapUShell"], [class*="sapMShell"], header, nav').first()
        .isVisible().catch(() => false);
      return hasShell;
    }
    return false;
  }

  /**
   * Detecta a página de erro "Você seguiu um link inválido" do SAP ID.
   */
  private async isInvalidLinkPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (!url.includes('accounts.sap.com')) return false;

    // Verificar se contém a mensagem de "link inválido" / "invalid link"
    const errorText = await page.locator('body').textContent().catch(() => '') ?? '';
    return (
      errorText.includes('link inválido') ||
      errorText.includes('invalid link') ||
      errorText.includes('Advertência') ||
      errorText.includes('Warning')
    );
  }

  /**
   * Recupera do erro "link inválido" re-navegando para o portal de forma
   * que force um redirect SAML limpo com todos os parâmetros.
   */
  private async recoverFromInvalidLink(page: Page): Promise<void> {
    logger.info('Tentando recuperação: navegando para me.sap.com sem cache …');

    // Limpar cookies que possam estar corrompidos
    const context = page.context();
    await context.clearCookies();

    // Navegar para a raiz do portal (sem /home) para forçar redirect servidor
    await page.goto('https://me.sap.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    // Aguardar o redirect SAML (o servidor deve iniciar a cadeia)
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
      logger.warn('networkidle timeout na recuperação — prosseguindo …');
    });

    // Aguardar JS redirects (reduzido — 3s é suficiente para o redirect SAML)
    await page.waitForTimeout(3_000);

    logger.info({ url: page.url() }, 'Estado após recuperação');

    // Se ainda estamos na página de erro, tentar abordagem com redirect manual
    const stillError = await this.isInvalidLinkPage(page);
    if (stillError) {
      logger.warn('Ainda na página de erro — tentando abordagem direta para login …');

      // Última opção: ir direto para o formulário SAML com parâmetros do SP
      // Essa URL inclui o sp (service provider) que diz ao IdP para onde voltar
      await page.goto(
        'https://accounts.sap.com/saml2/idp/sso?sp=https://me.sap.com&RelayState=https://me.sap.com/home',
        { waitUntil: 'domcontentloaded', timeout: 60_000 }
      );
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2_000);

      // Se AINDA deu erro, tentar a URL do SAP Universal ID login
      const url = page.url();
      const bodyText = await page.locator('body').textContent().catch(() => '') ?? '';
      if (bodyText.includes('link inválido') || bodyText.includes('invalid link')) {
        logger.warn('Abordagem SP falhou — tentando URL de login universal SAP …');
        // O portal usa accounts.sap.com com parâmetro de callback
        await page.goto(
          'https://accounts.sap.com/?saml2sp=https://me.sap.com',
          { waitUntil: 'domcontentloaded', timeout: 60_000 }
        );
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }
  }

  /**
   * Aguarda o formulário de login aparecer e o preenche.
   * Busca por seletor (não por URL) para ser resiliente a variações na cadeia SAML.
   */
  private async waitForAndFillLoginForm(page: Page): Promise<void> {
    // ── 3a: Aguardar campo de e-mail (independente da URL) ──────────────
    logger.info('Etapa 3a — Aguardando campo de e-mail no formulário de login …');

    const emailInput = page.locator('input#j_username');

    // Esperar até 60s — o redirect SAML pode demorar
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      const url = page.url();
      const bodySnippet = await page.locator('body').textContent().catch(() => '') ?? '';
      throw new AppError(
        `Campo de e-mail não encontrado. URL: ${url} | Conteúdo: ${bodySnippet.slice(0, 200)}`,
        401,
        'SAP_AUTH_LOGIN_FORM_NOT_FOUND'
      );
    }

    logger.info({ url: page.url() }, 'Formulário de login encontrado');

    // ── 3b: Preencher e-mail ────────────────────────────────────────────
    await emailInput.fill(env.SAP_USERNAME);
    logger.info('E-mail preenchido, clicando em Continuar …');

    const continueBtn = page.locator('button#logOnFormSubmit');
    await continueBtn.click();

    // ── 3c: Aguardar campo de senha ─────────────────────────────────────
    logger.info('Etapa 3c — Aguardando campo de senha …');
    const passwordInput = page.locator('input#j_password');
    try {
      await passwordInput.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      throw new AppError(
        `Campo de senha não encontrado. URL: ${page.url()}`,
        401,
        'SAP_AUTH_PASSWORD_FORM_NOT_FOUND'
      );
    }

    // ── 3d: Preencher senha e submeter ──────────────────────────────────
    await passwordInput.fill(env.SAP_PASSWORD);
    logger.info('Senha preenchida, submetendo login …');

    await continueBtn.click();

    // Aguardar o SAP ID processar — não precisa networkidle longo,
    // pois o redirect acontece rápido. O portal SPA nunca atinge networkidle.
    logger.info('Login submetido — aguardando processamento …');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
      logger.warn('networkidle timeout pós-submit — OK, verificando estado …');
    });

    // Verificar erro de credenciais
    const errorMessage = page.locator('#logOnFormErrorMessage, .sapIdpLogonError');
    const hasError = await errorMessage.isVisible().catch(() => false);
    if (hasError) {
      const errorText = await errorMessage.textContent().catch(() => 'Erro desconhecido');
      throw new AppError(
        `Credenciais SAP inválidas: ${errorText?.trim()}`,
        401,
        'SAP_AUTH_INVALID_CREDENTIALS'
      );
    }
  }

  /**
   * Extrai cookies de sessão do contexto do browser.
   */
  private async extractSessionCookies(context: BrowserContext): Promise<AuthSession> {
    const rawCookies = await context.cookies();

    // Filtrar apenas cookies relevantes do SAP e serializar TODOS os campos
    // que o Playwright addCookies precisa para restaurar corretamente.
    const sapCookies = rawCookies
      .filter((c) => c.domain.includes('sap.com') || c.domain.includes('hana.ondemand.com'))
      .filter((c) => c.name && c.value && c.domain) // remover cookies sem campos obrigatórios
      .map((c) => {
        // sameSite 'None' exige secure=true no protocolo CDP.
        // Se não for Strict ou Lax, tratamos como Lax (padrão seguro).
        let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
        if (c.sameSite === 'Strict') sameSite = 'Strict';
        else if (c.sameSite === 'None') sameSite = 'None';

        const cookie: SapCookie = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: c.httpOnly ?? false,
          secure: sameSite === 'None' ? true : (c.secure ?? false),
          sameSite
        };

        // expires <= 0 significa cookie de sessão — não incluir campo
        if (c.expires > 0) {
          cookie.expires = c.expires;
        }

        return cookie;
      });

    if (sapCookies.length === 0) {
      throw new AppError(
        'Nenhum cookie SAP capturado após autenticação',
        401,
        'SAP_AUTH_NO_COOKIES'
      );
    }

    logger.info(
      { total: rawCookies.length, sap: sapCookies.length, domains: [...new Set(sapCookies.map(c => c.domain))] },
      'Cookies de sessão capturados'
    );

    const createdAt = Date.now();
    const expiresAt = createdAt + env.SAP_SESSION_TTL_MINUTES * 60_000;

    return {
      cookies: sapCookies,
      createdAt,
      expiresAt
    };
  }
}
