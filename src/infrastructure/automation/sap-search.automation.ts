import { chromium, Page, Frame } from 'playwright';

import { KnowledgeArticle, KnowledgeSearchResult } from '../../domain/entities/knowledge-search.entity.js';
import { AuthSession } from '../../domain/interfaces/sap-auth.interface.js';
import { ISapSearchAutomation } from '../../domain/interfaces/sap-search.interface.js';
import { env } from '../../shared/config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import { logger } from '../../shared/logger/logger.js';
import { STEALTH_ARGS, REAL_USER_AGENT } from '../browser/stealth.js';

/**
 * Automação de busca no Knowledge Search do portal me.sap.com.
 *
 * Fluxo pós-autenticação:
 * 1. Abre me.sap.com/home com os cookies de sessão injetados.
 * 2. Confirma que estamos autenticados (URL permanece em me.sap.com).
 * 3. Navega para a seção Knowledge Search.
 * 4. Preenche o termo de busca e submete.
 * 5. Extrai os resultados (KBAs, SAP Notes, artigos).
 */
export class SapSearchAutomation implements ISapSearchAutomation {

  /** URL de entrada do portal */
  private readonly PORTAL_HOME = 'https://me.sap.com/home';

  /** URL da página de Knowledge Search (descoberta via logs de navegação) */
  private readonly KNOWLEDGE_SEARCH_URL = 'https://me.sap.com/servicessupport/search';

 

  /**
   * Dispensa o banner de consentimento de cookies TrustArc que aparece no me.sap.com.
   * O overlay #trustarc-banner-overlay intercepta TODOS os cliques na página,
   * impedindo a interação com qualquer elemento até ser dispensado.
   */
  private async dismissCookieConsentBanner(page: Page): Promise<void> {
    try {
      // O banner TrustArc pode ter diferentes botões de consentimento
      const consentButton = page.locator([
        '#truste-consent-button',                         // Botão principal "Accept"
        '#consent_blackbar button',                       // Qualquer botão no banner
        'a.call:has-text("Accept")',                      // Link "Accept All"
        'a.call:has-text("Aceitar")',                     // Versão pt
        '#trustarc-banner-overlay',                       // O próprio overlay (dispara click do botão)
        'button:has-text("Accept All Cookies")',          // Variação
        'button:has-text("Aceitar todos os cookies")'     // Variação pt
      ].join(', ')).first();

      const isVisible = await consentButton.isVisible().catch(() => false);
      if (isVisible) {
        logger.info('Banner de consentimento de cookies detectado — dispensando …');
        await consentButton.click({ timeout: 5_000 });
        // Aguardar o overlay desaparecer (sem sleep fixo — o waitFor já é condicional)
        await page.locator('#trustarc-banner-overlay').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
        logger.info('Banner de cookies dispensado');
      }
    } catch (err) {
      // Se não conseguir dispensar, tentar remover via JS como último recurso
      logger.warn('Não foi possível dispensar banner via clique — removendo via JS …');
      await page.evaluate(() => {
        var overlay = document.getElementById('trustarc-banner-overlay');
        if (overlay) overlay.remove();
        var banner = document.getElementById('consent_blackbar');
        if (banner) banner.remove();
      });
      await page.waitForTimeout(500);
    }
  }

  async searchKnowledgeBase(query: string, session: AuthSession): Promise<KnowledgeSearchResult> {
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

      // Injetar cookies da sessão autenticada.
      // Os cookies já foram normalizados no auth provider (sameSite, secure, etc.).
      // Filtramos apenas os campos aceitos pelo Playwright addCookies.
      const cookiesToInject = session.cookies
        .filter((c) => c.name && c.value && c.domain)
        .map((c) => {
          const cookie: {
            name: string; value: string; domain: string; path: string;
            expires?: number; httpOnly?: boolean; secure?: boolean;
            sameSite?: 'Strict' | 'Lax' | 'None';
          } = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
            sameSite: c.sameSite ?? 'Lax'
          };
          // sameSite 'None' exige secure=true
          if (cookie.sameSite === 'None') cookie.secure = true;
          // Só incluir expires se for um timestamp futuro válido
          if (c.expires && c.expires > 0) cookie.expires = c.expires;
          return cookie;
        });

      logger.info({ count: cookiesToInject.length }, 'Injetando cookies de sessão …');
      await context.addCookies(cookiesToInject);

      const page = await context.newPage();

      // Interceptar respostas de rede da SPA ANTES de navegar
      // — os resultados reais de busca vêm via XHR/fetch do Coveo
      const apiResponses: Array<{ body: any; url: string }> = [];
      const sseChunks: string[] = [];         // Dados SSE capturados do Coveo GenQA

      // Capturar TODAS respostas relevantes do Coveo (JSON + SSE + text)
      page.on('response', async (response) => {
        try {
          const url = response.url();
          const status = response.status();
          const contentType = response.headers()['content-type'] || '';

          // Log diagnóstico de TODA resposta Coveo
          if (url.includes('coveo') || url.includes('genqa') || url.includes('machinelearning')) {
            logger.info({ url: url.substring(0, 200), status, contentType: contentType.substring(0, 100) }, '[DIAG] Resposta Coveo interceptada');
          }

          if (status < 200 || status >= 300) return;

          // Capturar respostas SSE / text / event-stream do Coveo
          const isCoveoUrl = url.includes('coveo') || url.includes('genqa') || url.includes('machinelearning');
          const isSSEContent = contentType.includes('event-stream') || contentType.includes('text/plain') || contentType.includes('octet-stream');
          const isGenQAUrl = url.includes('genqa') || url.includes('stream') || url.includes('answer') || url.includes('generate') || url.includes('rga');

          if (isCoveoUrl && (isSSEContent || isGenQAUrl)) {
            const sseText = await response.text().catch(() => '');
            if (sseText && sseText.length > 0) {
              sseChunks.push(sseText);
              logger.info({ url: url.substring(0, 150), length: sseText.length, contentType }, 'SSE/text capturado do Coveo');
            }
            return; // não tentar json() no mesmo response
          }

          // Capturar respostas JSON de busca
          if (
            (url.includes('search') || url.includes('knowledge') || url.includes('note') || url.includes('kba') || url.includes('api') || isCoveoUrl) &&
            contentType.includes('json')
          ) {
            const body = await response.json().catch(() => null);
            if (body) {
              apiResponses.push({ body, url });
              logger.info({ url: url.substring(0, 150), bodyKeys: Object.keys(body) }, 'Interceptada resposta JSON');
            }
          }
        } catch { /* ignorar erros de interceptação */ }
      });

      // ─── Etapa 1: Navegar DIRETO para Knowledge Search ─────────────────
      // Com os cookies de sessão injetados, podemos pular Home e Services
      // e ir diretamente para a URL de Knowledge Search.
      // Se a sessão for inválida, o portal redireciona para accounts.sap.com.
      logger.info('Etapa 1 — Navegando diretamente para Knowledge Search …');
      await page.goto(this.KNOWLEDGE_SEARCH_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });

      // Aguardar a SPA estabilizar — timeout mínimo (SPA UI5 faz polling contínuo)
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
        logger.info('networkidle timeout (esperado — SPA UI5 faz polling contínuo)');
      });

      // ─── Etapa 2: Verificar se estamos autenticados ─────────────────────
      const currentUrl = page.url();
      logger.info({ url: currentUrl }, 'URL após navegação direta');

      if (currentUrl.includes('accounts.sap.com') || currentUrl.includes('/saml2/')) {
        throw new AppError(
          'Sessão SAP expirada ou inválida — redirecionado para login. Sessão será renovada automaticamente.',
          401,
          'SAP_SESSION_EXPIRED'
        );
      }

      // Dispensar banner de consentimento de cookies (TrustArc) — uma única vez
      await this.dismissCookieConsentBanner(page);

      // ─── Etapa 3: Aguardar campo de busca (prova de que a página carregou) ─
      logger.info({ query }, 'Etapa 3 — Aguardando campo de busca e preenchendo …');

      const searchInput = page.locator([
        'input[type="search"][placeholder*="Search" i]',
        'input[type="search"]',
        'input[placeholder*="knowledge" i]',
        'input[placeholder*="help" i]',
        '.sapMSF input.sapMSFI'
      ].join(', ')).first();

      try {
        await searchInput.waitFor({ state: 'visible', timeout: 30_000 });
      } catch {
        // Se o campo não apareceu, talvez a URL tenha mudado — verificar
        const fallbackUrl = page.url();
        if (!fallbackUrl.includes('me.sap.com')) {
          throw new AppError(
            `URL inesperada: ${fallbackUrl}`,
            424,
            'SAP_SEARCH_UNEXPECTED_REDIRECT'
          );
        }
        throw new AppError(
          'Campo de busca não encontrado na página Knowledge Search',
          424,
          'SAP_SEARCH_INPUT_NOT_FOUND'
        );
      }

      // ─── Etapa 4: Preencher e executar a busca ──────────────────────────
      // IMPORTANTE: Registrar os waitForResponse ANTES de pressionar Enter,
      // para que as promises estejam ouvindo quando as respostas chegarem.
      // O Playwright pode perder respostas que chegam antes do waitForResponse.
      const coveoSearchPromise = page.waitForResponse(
        (resp) => resp.url().includes('coveo.com/rest/search') && resp.status() === 200,
        { timeout: 30_000 }
      ).then(() => {
        logger.info('Resposta Coveo REST search recebida');
      }).catch(() => {
        logger.warn('Timeout aguardando resposta Coveo REST search');
      });

      // SSE agora é capturado pelo listener 'response' acima.
      // Aqui apenas esperamos tempo suficiente para o GenQA completar.
      const ssePromise = page.waitForTimeout(15_000).then(() => {
        logger.info({ sseChunksCount: sseChunks.length }, 'Período inicial de captura SSE concluído');
      });

      // AGORA submeter a busca (as promises já estão ouvindo)
      await searchInput.click();
      await searchInput.fill(query);
      await page.keyboard.press('Enter');

      logger.info('Busca submetida — aguardando resultados (Coveo + SSE em paralelo) …');

      // Aguardar os resultados de busca (artigos) do Coveo REST.
      // O SSE (Generated Answer) continua em background — será aguardado
      // de forma inteligente na Etapa 6 via detecção de estabilização no DOM.
      await coveoSearchPromise;
      logger.info('Coveo REST processado — prosseguindo para extração de artigos');

      logger.info({ url: page.url() }, 'Página de resultados carregada');

      // ─── Etapa 5: Capturar Generated Answer PRIMEIRO ────────────────────
      // A IA do Coveo renderiza via streaming SSE. Precisamos capturá-la
      // ANTES de fazer scroll/extração de artigos, pois o scroll pode
      // remover o elemento do viewport ou interferir no streaming.

      // Estratégia A: Aguardar renderização + extrair do DOM (main frame)
      let generatedAnswer: string | undefined;
      logger.info('Aguardando Generated Answer renderizar no DOM …');
      const gaRendered = await this.waitForGeneratedAnswer(page);
      if (gaRendered) {
        generatedAnswer = await this.extractGeneratedAnswer(page);
        if (generatedAnswer) {
          logger.info({ length: generatedAnswer.length, source: 'dom-main' }, 'GA capturado do DOM (main frame)');
        }
      }

      // Estratégia B: Buscar em TODOS os frames (iframes)
      if (!generatedAnswer) {
        logger.info('Buscando GA em iframes …');
        generatedAnswer = await this.extractGeneratedAnswerFromFrames(page);
        if (generatedAnswer) {
          logger.info({ length: generatedAnswer.length, source: 'iframe' }, 'GA capturado de iframe');
        }
      }

      // Estratégia C: Extrair dos dados SSE capturados pelo listener
      if (!generatedAnswer) {
        await ssePromise; // garantir que o período de captura inicial passou
        if (sseChunks.length > 0) {
          logger.info({ chunks: sseChunks.length, totalSize: sseChunks.reduce((s, c) => s + c.length, 0) }, 'Tentando extrair GA dos dados SSE …');
          generatedAnswer = this.extractGeneratedAnswerFromSse(sseChunks);
          if (generatedAnswer) {
            logger.info({ length: generatedAnswer.length, source: 'sse' }, 'GA extraído dos dados SSE');
          }
        } else {
          logger.info('Nenhum chunk SSE capturado');
        }
      }

      // Estratégia D: Deep scan recursivo de TODAS respostas JSON
      if (!generatedAnswer) {
        logger.info({ responseCount: apiResponses.length }, 'Deep scan nas respostas JSON …');
        generatedAnswer = this.deepScanJsonForAnswer(apiResponses);
        if (generatedAnswer) {
          logger.info({ length: generatedAnswer.length, source: 'json-deep' }, 'GA extraído via deep scan JSON');
        }
      }

      // Estratégia E: Scan de texto completo da página
      if (!generatedAnswer) {
        logger.info('Tentando extrair GA do texto completo da página …');
        generatedAnswer = await this.extractGeneratedAnswerFromFullText(page);
        if (generatedAnswer) {
          logger.info({ length: generatedAnswer.length, source: 'full-text' }, 'GA extraído do texto completo da página');
        }
      }

      if (!generatedAnswer) {
        logger.warn('TODAS as estratégias de captura do Generated Answer falharam');
      }

      // ─── Etapa 6: Extrair artigos ───────────────────────────────────────
      // Agora que o Generated Answer já foi capturado, podemos fazer scroll
      // e extrair artigos sem risco de perder a resposta da IA.
      const apiArticles = this.extractFromApiResponses(apiResponses);
      logger.info({ count: apiArticles.length, source: 'api-intercept' }, 'Resultados extraídos via interceptação de API');

      // Scroll para baixo na página para forçar lazy-loading / "load more"
      await this.scrollToLoadMore(page);

      const domArticles = await this.extractFromDom(page);
      logger.info({ count: domArticles.length, source: 'dom' }, 'Resultados extraídos do DOM');

      // Merge: combinar API + DOM, deduplicando por título+link
      const seen = new Set<string>();
      const merged: KnowledgeArticle[] = [];
      for (const a of [...apiArticles, ...domArticles]) {
        const key = `${a.title}|${a.link}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
      }
      logger.info({ api: apiArticles.length, dom: domArticles.length, merged: merged.length }, 'Resultados combinados API + DOM');

      // Filtrar artigos sem link válido
      const validArticles = merged.filter((a) => a.link && a.link.startsWith('http'));

      logger.info(
        { total: merged.length, valid: validArticles.length, hasGeneratedAnswer: !!generatedAnswer },
        'Resultados extraídos da Knowledge Search'
      );
      return { generatedAnswer, articles: validArticles };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        `Falha ao pesquisar base SAP: ${error instanceof Error ? error.message : 'desconhecido'}`,
        424,
        'SAP_SEARCH_FAILED'
      );
    } finally {
      await browser.close();
    }
  }

  /**
   * Faz scroll para baixo na página de resultados para forçar lazy-loading
   * e botões "Show More" / "Load More" que carregam resultados adicionais.
   * A SPA SAP/Coveo usa paginação infinita ou botão "Show More".
   */
  private async scrollToLoadMore(page: Page): Promise<void> {
    try {
      // Tentar clicar em botões "Show More" / "Load More" / "Ver mais" se existirem
      const showMoreSelectors = [
        'button:has-text("Show More")',
        'button:has-text("Load More")',
        'button:has-text("Ver mais")',
        'button:has-text("Mostrar mais")',
        'a:has-text("Show More")',
        'a:has-text("Load More")',
        '[class*="ShowMore"]',
        '[class*="showMore"]',
        '[class*="load-more"]',
        '[class*="LoadMore"]',
        '.sapMSLIShowMore',
        '.sapMGrowingListTrigger'
      ].join(', ');

      // Fazer scroll para baixo 3 vezes (com pausa para SPA renderizar)
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1_500);

        // Tentar clicar "Show More" se visível após scroll
        const showMoreBtn = page.locator(showMoreSelectors).first();
        const isVisible = await showMoreBtn.isVisible().catch(() => false);
        if (isVisible) {
          logger.info({ iteration: i + 1 }, 'Botão "Show More" encontrado — clicando …');
          await showMoreBtn.click({ timeout: 5_000 }).catch(() => {});
          // Aguardar novos resultados carregarem
          await page.waitForTimeout(3_000);
        }
      }

      // Scroll final para o topo para garantir que os seletores DOM funcionem
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      logger.info('Scroll/load-more concluído');
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : 'unknown' }, 'Erro durante scroll/load-more — prosseguindo');
    }
  }

  /**
   * Extrai resultados de busca das respostas JSON interceptadas da API interna do SAP.
   * O portal me.sap.com usa o Coveo como engine de busca. A resposta Coveo tem:
   *   body.results[] → array com { title, clickUri, uri, raw: { mh_alt_url, date, mh_id, documenttype, ... } }
   *   - raw.mh_alt_url: URL pública (me.sap.com/notes/xxx ou help.sap.com)
   *   - raw.date: timestamp em milissegundos (epoch)
   *   - raw.mh_id: número da nota SAP
   *   - clickUri: URL interna SAP (i7p.wdf.sap.corp) — NÃO usar como link público
   */
  private extractFromApiResponses(apiResponses: Array<{ body: any; url: string }>): KnowledgeArticle[] {
    const articles: KnowledgeArticle[] = [];
    const seen = new Set<string>();

    for (const { body, url } of apiResponses) {
      logger.info({ url, type: typeof body, isArray: Array.isArray(body) }, 'Processando resposta API interceptada');

      // ─── Coveo search response (resposta principal) ───────────────────
      if (body && Array.isArray(body.results) && body.results.length > 0) {
        logger.info({ count: body.results.length, totalCount: body.totalCount }, 'Resposta Coveo detectada');
        for (const item of body.results) {
          if (!item || typeof item !== 'object') continue;

          const title = (item.title || item.Title || '').trim();
          if (!title || title.length < 3) continue;

          const raw = item.raw || {};

          // Link: prioridade → mh_alt_url (público) > clickUri (pode ser help.sap.com) > construir via mh_id
          let link = '';
          if (raw.mh_alt_url && typeof raw.mh_alt_url === 'string') {
            link = raw.mh_alt_url;
          } else if (item.clickUri && typeof item.clickUri === 'string' && !item.clickUri.includes('.corp')) {
            link = item.clickUri;
          } else if (raw.mh_id) {
            link = `https://me.sap.com/notes/${raw.mh_id}/E`;
          }
          link = this.normalizeLink(link, raw.mh_id);

          // Date: raw.date é timestamp em milissegundos
          let date: string | undefined;
          const rawDate = raw.date || raw.sysdate;
          if (typeof rawDate === 'number' && rawDate > 0) {
            date = new Date(rawDate).toISOString().split('T')[0];
          } else if (typeof rawDate === 'string') {
            date = this.formatDateToIso(rawDate);
          }

          const key = `${title}|${link}`;
          if (seen.has(key)) continue;
          seen.add(key);

          articles.push({ title, link, date });
        }
        continue; // não processar arrays genéricos se já achamos Coveo
      }

      // ─── Fallback genérico: procurar arrays em qualquer resposta ──────
      const candidates = this.findArraysInObject(body);
      for (const arr of candidates) {
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const title = item.title || item.Title || item.name || item.Name
            || item.description || item.Description || item.subject || item.Subject || '';
          const rawLink = item.link || item.Link || item.url || item.Url || item.URL
            || item.href || item.Href || item.detailUrl || item.DetailUrl || '';
          const rawObj = item.raw || {};
          const dateVal = rawObj.date || item.date || item.Date || item.lastUpdated
            || item.createdDate || item.publishDate || item.releaseDate || '';
          const noteId = rawObj.mh_id || item.id || item.Id || item.ID || item.number || '';

          if (typeof title === 'string' && title.length > 3) {
            const finalLink = this.normalizeLink(rawObj.mh_alt_url || rawLink, noteId);
            const key = `${title}|${finalLink}`;
            if (seen.has(key)) continue;
            seen.add(key);

            let date: string | undefined;
            if (typeof dateVal === 'number' && dateVal > 0) {
              date = new Date(dateVal).toISOString().split('T')[0];
            } else if (typeof dateVal === 'string') {
              date = this.formatDateToIso(dateVal);
            }

            articles.push({ title: title.trim(), link: finalLink, date });
          }
        }
      }
    }

    return articles.slice(0, 50);
  }

  /**
   * Encontra todos os arrays dentro de um objeto (busca recursiva, profundidade limitada).
   */
  private findArraysInObject(obj: any, depth = 0): Array<any[]> {
    const arrays: Array<any[]> = [];
    if (depth > 5 || !obj) return arrays;

    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object') {
        arrays.push(obj);
      }
      return arrays;
    }

    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        arrays.push(...this.findArraysInObject(obj[key], depth + 1));
      }
    }

    return arrays;
  }

  /**
   * Extrai resultados diretamente do DOM da página de resultados.
   * Usa seletores específicos para a estrutura do portal SAP me.sap.com.
   */
  private async extractFromDom(page: Page): Promise<KnowledgeArticle[]> {
    const rawResults: Array<{ title: string; link: string; dateText?: string }> = await page.evaluate(() => {
      var results: Array<{ title: string; link: string; dateText?: string }> = [];
      var seen: Record<string, boolean> = {};
      var dateRe = /(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}[\s.]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.,]+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.]+\d{1,2}[\s.,]+\d{4})/i;

      // Abordagem 1: Items em listas SAP UI5
      var ui5Items = document.querySelectorAll(
        '.sapMLIB, .sapMSLI, .sapMListTblRow, [class*="SearchResult"], [class*="searchResult"], [class*="resultItem"], [class*="ResultItem"], [class*="ListItem"], li[class*="sap"], tr[class*="sap"]'
      );
      for (var i = 0; i < ui5Items.length; i++) {
        var item = ui5Items[i];
        var anchor = item.querySelector('a[href]');
        if (!anchor) continue;
        var href = anchor.getAttribute('href') || '';
        var fullHref = href.startsWith('/') ? 'https://me.sap.com' + href : href;
        if (fullHref.indexOf('sap.com') === -1 && fullHref.indexOf('help.sap') === -1) continue;
        var titleEl = anchor.textContent || '';
        if (!titleEl) { var t2 = item.querySelector('[class*="title"], [class*="Title"], .sapMSLITitle, .sapMLIBContent'); if (t2) titleEl = t2.textContent || ''; }
        var title = titleEl.trim();
        if (title.length < 4 || seen[title + fullHref]) continue;
        seen[title + fullHref] = true;
        // Extrair data inline
        var dt1 = undefined as string | undefined;
        var timeEl1 = item.querySelector('time[datetime]');
        if (timeEl1) { dt1 = timeEl1.getAttribute('datetime') || undefined; }
        if (!dt1) { var dateEl1 = item.querySelector('[class*="date"], [class*="Date"], [class*="time"], [class*="updated"], [class*="modified"]'); if (dateEl1) { var dm1 = (dateEl1.textContent || '').match(dateRe); if (dm1) dt1 = dm1[0]; } }
        if (!dt1) { var dm1b = (item.textContent || '').match(dateRe); if (dm1b) dt1 = dm1b[0]; }
        results.push({ title: title, link: fullHref, dateText: dt1 });
      }

      // Abordagem 2: Links para notas SAP, KBAs, help.sap.com
      var allLinks2 = document.querySelectorAll('a[href]');
      for (var j = 0; j < allLinks2.length; j++) {
        var a2 = allLinks2[j];
        var href2 = a2.getAttribute('href') || '';
        var fullHref2 = href2.startsWith('/') ? 'https://me.sap.com' + href2 : href2;
        var isSap = fullHref2.indexOf('/notes/') !== -1 || fullHref2.indexOf('/kba/') !== -1 ||
          fullHref2.indexOf('launchpad.support.sap.com') !== -1 || fullHref2.indexOf('help.sap.com/docs') !== -1 ||
          fullHref2.indexOf('/knowledgebase/') !== -1 || /\/notes\/\d+/.test(fullHref2);
        if (!isSap) continue;
        var title2 = (a2.textContent || '').trim();
        if (title2.length < 4 || title2.length > 500 || seen[title2 + fullHref2]) continue;
        seen[title2 + fullHref2] = true;
        var container2 = a2.closest('li, tr, [class*="item"], [class*="Item"], [class*="result"], [class*="Result"], [class*="row"], [class*="Row"], div[class]');
        var dt2 = undefined as string | undefined;
        if (container2) {
          var timeEl2 = container2.querySelector('time[datetime]');
          if (timeEl2) { dt2 = timeEl2.getAttribute('datetime') || undefined; }
          if (!dt2) { var dateEl2 = container2.querySelector('[class*="date"], [class*="Date"], [class*="time"], [class*="updated"], [class*="modified"]'); if (dateEl2) { var dm2 = (dateEl2.textContent || '').match(dateRe); if (dm2) dt2 = dm2[0]; } }
          if (!dt2) { var dm2b = (container2.textContent || '').match(dateRe); if (dm2b) dt2 = dm2b[0]; }
        }
        results.push({ title: title2, link: fullHref2, dateText: dt2 });
      }

      // Abordagem 3: Qualquer link SAP no corpo principal
      var mainContent = document.querySelector('main, [role="main"], .sapMPage, .sapMShellContent, #content, [class*="content"]') || document.body;
      var allLinks3 = mainContent.querySelectorAll('a[href]');
      for (var k = 0; k < allLinks3.length; k++) {
        var a3 = allLinks3[k];
        var href3 = a3.getAttribute('href') || '';
        var title3 = (a3.textContent || '').trim();
        var fullHref3 = href3.startsWith('/') ? 'https://me.sap.com' + href3 : href3;
        if (title3.length > 5 && title3.length < 500 &&
          (fullHref3.indexOf('https://') === 0 || fullHref3.indexOf('http://') === 0) &&
          fullHref3.indexOf('sap.com') !== -1 && !seen[title3 + fullHref3]) {
          var lower = title3.toLowerCase();
          if (lower === 'home' || lower === 'services & support' || lower === 'get assistance' ||
            lower.indexOf('log') === 0 || lower === 'status' || lower === 'community' ||
            lower === 'learning' || lower === 'partnership') continue;
          seen[title3 + fullHref3] = true;
          var container3 = a3.closest('li, tr, div[class], section');
          var dt3 = undefined as string | undefined;
          if (container3) {
            var timeEl3 = container3.querySelector('time[datetime]');
            if (timeEl3) { dt3 = timeEl3.getAttribute('datetime') || undefined; }
            if (!dt3) { var dateEl3 = container3.querySelector('[class*="date"], [class*="Date"], [class*="time"], [class*="updated"], [class*="modified"]'); if (dateEl3) { var dm3 = (dateEl3.textContent || '').match(dateRe); if (dm3) dt3 = dm3[0]; } }
            if (!dt3) { var dm3b = (container3.textContent || '').match(dateRe); if (dm3b) dt3 = dm3b[0]; }
          }
          results.push({ title: title3, link: fullHref3, dateText: dt3 });
        }
      }

      return results.slice(0, 50);
    });

    return rawResults.map((r) => ({
      title: r.title,
      link: r.link,
      date: r.dateText ? this.formatDateToIso(r.dateText) : undefined
    }));
  }

  /**
   * Aguarda o Generated Answer aparecer no DOM.
   * 
   * A IA do Coveo é carregada via streaming (SSE) SEPARADO da busca principal.
   * A SPA SAP cria o container dinamicamente quando o streaming começa.
   * 
   * Usa seletores amplos para cobrir variações de classname:
   *   - .sapMeCoveoGeneratedAnswerContainer / .sapMeCoveoGeneratedAnswerCard
   *   - .sapMeCoveoSearchGeneratedAnswerText
   *   - Qualquer elemento com "GeneratedAnswer" ou "generated-answer" no id/class
   *   - Elementos com "genqa" ou "gen-qa" no id/class
   * 
   * Estratégia com DETECÇÃO DE ESTABILIZAÇÃO:
   *   1. Polling no DOM por até 30s procurando o container do generated answer
   *   2. Se container encontrado, monitorar o texto até ele PARAR DE CRESCER
   *      por 5 segundos consecutivos — isso garante que o streaming completou
   *   3. Timeout máximo total de 120s para respostas longas da IA
   */
  private async waitForGeneratedAnswer(page: Page): Promise<boolean> {
    const startTime = Date.now();
    const MAX_WAIT_CONTAINER = 30_000;   // 30s para o container aparecer
    const MAX_WAIT_TOTAL = 120_000;      // 120s timeout total (respostas longas)
    const STABILIZATION_TIME = 5_000;    // texto deve ficar estável por 5s

    // Seletores amplos para o container do Generated Answer
    // Inclui Web Components do Coveo Atomic que são usados no portal SAP
    const containerSelectors = [
      'atomic-generated-answer',
      'atomic-rga-answer',
      '.sapMeCoveoGeneratedAnswerContainer',
      '.sapMeCoveoGeneratedAnswerCard',
      '.sapMeCoveoSearchGeneratedAnswerText',
      '[id*="generatedAnswer"]',
      '[id*="GeneratedAnswer"]',
      '[id*="generated-answer"]',
      '[class*="GeneratedAnswer"]',
      '[class*="generated-answer"]',
      '[class*="genqa"]',
      '[class*="gen-qa"]',
      '[class*="coveo-generated"]',
      '[data-source-component="GenQA"]',
      '[data-coveo-genqa]'
    ].join(', ');

    try {
      // Passo 1: Polling para encontrar QUALQUER elemento de generated answer no DOM
      let containerFound = false;
      
      while (Date.now() - startTime < MAX_WAIT_CONTAINER) {
        const count = await page.locator(containerSelectors).count();
        if (count > 0) {
          containerFound = true;
          logger.info({ elapsed: Date.now() - startTime, count }, 'Container do Generated Answer detectado no DOM');
          break;
        }
        
        // Também verificar via evaluate (pode pegar elementos dinamicamente criados)
        const foundViaJs = await page.evaluate((selectors) => {
          var el = document.querySelector(selectors);
          if (el) return { tag: el.tagName, id: el.id, className: el.className.toString().substring(0, 200) };
          // Buscar Web Components Coveo Atomic
          var atomicGA = document.querySelector('atomic-generated-answer, atomic-rga-answer');
          if (atomicGA) return { tag: atomicGA.tagName, id: atomicGA.id || '', className: atomicGA.className?.toString?.()?.substring(0, 200) || '', source: 'atomic-wc' };
          // Buscar por texto "Generated Answer" ou atributos genéricos
          var allEls = document.querySelectorAll('*');
          for (var ii = 0; ii < allEls.length; ii++) {
            var cls = allEls[ii].className?.toString?.() || '';
            var eid = allEls[ii].id || '';
            var tag = allEls[ii].tagName?.toLowerCase() || '';
            if (cls.toLowerCase().indexOf('generated') !== -1 || eid.toLowerCase().indexOf('generated') !== -1 || tag.indexOf('atomic-generated') !== -1 || tag.indexOf('atomic-rga') !== -1) {
              return { tag: allEls[ii].tagName, id: eid, className: cls.substring(0, 200), source: 'text-scan' };
            }
          }
          return null;
        }, containerSelectors).catch(() => null);

        if (foundViaJs) {
          containerFound = true;
          logger.info({ elapsed: Date.now() - startTime, element: foundViaJs }, 'Container do Generated Answer encontrado via JS evaluate');
          break;
        }

        await page.waitForTimeout(1_500); // poll a cada 1.5s
      }

      if (!containerFound) {
        logger.info({ elapsed: Date.now() - startTime }, 'Generated Answer: container não encontrado no DOM');
        return false;
      }

      // Passo 2: Monitorar o texto até ESTABILIZAR (parar de crescer por 5s)
      // Isso garante que o streaming SSE completou e toda a resposta foi renderizada.
      const textSelectors = [
        'atomic-generated-answer',
        'atomic-rga-answer',
        '.sapMeCoveoSearchGeneratedAnswerText',
        '[class*="GeneratedAnswer"] p',
        '[class*="GeneratedAnswer"] span',
        '[class*="generated-answer"] p',
        '[id*="generatedAnswer"]',
        '[class*="genqa"]'
      ].join(', ');

      let lastText = '';
      let lastChangeTime = Date.now();
      
      while (Date.now() - startTime < MAX_WAIT_TOTAL) {
        const currentText = await page.evaluate((sel) => {
          var els = document.querySelectorAll(sel);
          var combined = '';
          for (var ci = 0; ci < els.length; ci++) {
            combined += ' ' + (els[ci].textContent || '');
            // Tentar dentro de Shadow DOM se for web component
            var sr = els[ci].shadowRoot;
            if (sr) {
              combined += ' ' + (sr.textContent || '');
            }
          }
          return combined.trim();
        }, textSelectors).catch(() => '');

        // Detectar se o texto mudou desde a última verificação
        if (currentText !== lastText) {
          if (currentText.length > lastText.length) {
            logger.info({ length: currentText.length, delta: currentText.length - lastText.length, elapsed: Date.now() - startTime }, 'Generated Answer: texto em crescimento (streaming ativo)');
          }
          lastText = currentText;
          lastChangeTime = Date.now();
        }

        // Condição de sucesso: texto significativo E estável por STABILIZATION_TIME
        const timeSinceLastChange = Date.now() - lastChangeTime;
        if (lastText.length > 20 && timeSinceLastChange >= STABILIZATION_TIME) {
          logger.info({ length: lastText.length, elapsed: Date.now() - startTime, stableForMs: timeSinceLastChange }, 'Generated Answer: texto completo e estabilizado');
          return true;
        }

        await page.waitForTimeout(1_000); // poll a cada 1s
      }

      // Timeout atingido — retornar true se temos texto parcial (melhor que nada)
      if (lastText.length > 20) {
        logger.warn({ length: lastText.length, elapsed: Date.now() - startTime }, 'Generated Answer: timeout atingido mas retornando texto disponível');
        return true;
      }

      logger.info({ elapsed: Date.now() - startTime }, 'Generated Answer: container existe mas texto não renderizou');
      return false;
    } catch (err) {
      logger.info({ elapsed: Date.now() - startTime, error: err instanceof Error ? err.message : 'unknown' }, 'Generated Answer: erro durante espera');
      return false;
    }
  }

  /**
   * Extrai o Generated Answer dos dados SSE (Server-Sent Events) capturados do Coveo.
   * 
   * Formato típico SSE do Coveo GenQA:
   *   event: genqa.headerMessageType
   *   data: {"payload":{"textContent":"..."}}
   *   
   *   event: genqa.messageType
   *   data: {"payload":{"textContent":"..."}}
   *   
   *   event: genqa.endOfStreamType
   *   data: {}
   * 
   * IMPORTANTE: O campo `payload` é um JSON double-encoded (string dentro de string).
   * O texto real está em `payload.textDelta` (após segundo JSON.parse).
   * Tipos de payload a processar: genqa.messageType (texto), genqa.citationsType (citações).
   * Tipos a ignorar: genqa.headerMessageType, genqa.endOfStreamType.
   */
  private extractGeneratedAnswerFromSse(sseChunks: string[]): string | undefined {
    const textDeltas: string[] = [];

    for (const chunk of sseChunks) {
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.substring(5).trim();
        if (!jsonStr || jsonStr === '{}') continue;
        
        try {
          const parsed = JSON.parse(jsonStr);
          const payloadType = parsed?.payloadType || '';
          
          // Ignorar headers e end-of-stream
          if (payloadType === 'genqa.headerMessageType' || payloadType === 'genqa.endOfStreamType') {
            continue;
          }

          // Ignorar citações (não são texto da resposta)
          if (payloadType === 'genqa.citationsType') {
            continue;
          }

          // Processar mensagens de texto (genqa.messageType)
          // O campo `payload` é uma STRING JSON que precisa de segundo parse
          const payloadStr = parsed?.payload;
          if (typeof payloadStr === 'string') {
            try {
              const inner = JSON.parse(payloadStr);
              const delta = inner?.textDelta;
              if (typeof delta === 'string' && delta.length > 0) {
                textDeltas.push(delta);
              }
            } catch {
              // payload não é JSON válido — ignorar
            }
          } else if (typeof payloadStr === 'object' && payloadStr) {
            // Caso o payload já venha como objeto (versão futura?)
            const delta = payloadStr.textDelta || payloadStr.textContent || payloadStr.text;
            if (typeof delta === 'string' && delta.length > 0) {
              textDeltas.push(delta);
            }
          }
        } catch {
          // Linha data: não é JSON — ignorar
        }
      }
    }

    if (textDeltas.length > 0) {
      const combined = textDeltas.join('').trim();
      if (combined.length > 10) {
        logger.info({ chunks: textDeltas.length, totalLength: combined.length }, 'Generated Answer montado a partir de textDeltas SSE');
        return combined;
      }
    }

    return undefined;
  }

  /**
   * Captura o texto bruto da seção "Generated Answer" renderizada pela SPA SAP/Coveo.
   *
   * Usa seletores amplos para cobrir variações no HTML da SPA SAP UI5:
   *   - .sapMeCoveoSearchGeneratedAnswerText (classe principal)
   *   - Qualquer elemento com "GeneratedAnswer" no id/class
   *   - Qualquer elemento com "genqa" no id/class
   *   - Container pai como fallback
   */
  private async extractGeneratedAnswer(page: Page): Promise<string | undefined> {
    return this.extractGAFromFrame(page.mainFrame());
  }

  /**
   * Extrai GA de um frame específico (main ou iframe).
   * Usa var-only dentro de page.evaluate para compatibilidade com esbuild/tsx.
   */
  private async extractGAFromFrame(frame: Frame): Promise<string | undefined> {
    try {
      const result = await frame.evaluate(() => {
        // === ABORDAGEM 1: Seletores diretos ===
        var selectors = [
          'atomic-generated-answer', 'atomic-rga-answer',
          '.sapMeCoveoSearchGeneratedAnswerText',
          '[class*="GeneratedAnswerText"]', '[class*="generated-answer-text"]',
          '[class*="genqa-text"]', '[class*="GeneratedAnswer"]',
          '[class*="generated-answer"]', '[class*="genqa"]',
          '.sapMeCoveoGeneratedAnswerContainer', '.sapMeCoveoGeneratedAnswerCard',
          '[id*="generatedAnswer"]', '[id*="GeneratedAnswer"]',
          '[id*="generated-answer"]', '[class*="coveo-generated"]',
          '[data-source-component="GenQA"]', '[data-coveo-genqa]'
        ];
        for (var si = 0; si < selectors.length; si++) {
          var els = document.querySelectorAll(selectors[si]);
          for (var ei = 0; ei < els.length; ei++) {
            var txt = '';
            // Tentar shadow DOM primeiro
            var sr = els[ei].shadowRoot;
            if (sr) txt = (sr.textContent || '').trim();
            if (!txt) txt = (els[ei].textContent || '').trim();
            if (txt.length > 20) return { text: txt, source: 'selector', selector: selectors[si] };
          }
        }

        // === ABORDAGEM 2: Scan por tag name / class / id com palavras-chave ===
        var allEls = document.querySelectorAll('*');
        var keywords = ['generatedanswer', 'generated-answer', 'genqa', 'gen-qa', 'atomic-generated', 'atomic-rga', 'rga-answer', 'coveo-generated'];
        for (var gi = 0; gi < allEls.length; gi++) {
          var el = allEls[gi];
          var cls = (el.className?.toString?.() || '').toLowerCase();
          var eid = (el.id || '').toLowerCase();
          var tag = (el.tagName || '').toLowerCase();
          var combined = cls + ' ' + eid + ' ' + tag;
          var found = false;
          for (var ki = 0; ki < keywords.length; ki++) {
            if (combined.indexOf(keywords[ki]) !== -1) { found = true; break; }
          }
          if (found) {
            var txt2 = '';
            var sr2 = el.shadowRoot;
            if (sr2) txt2 = (sr2.textContent || '').trim();
            if (!txt2) txt2 = (el.textContent || '').trim();
            if (txt2.length > 20) return { text: txt2, source: 'keyword-scan', tag: tag, cls: cls.substring(0, 100), id: eid };
          }
        }

        // === ABORDAGEM 3: Listar custom elements para diagnóstico ===
        var customs: string[] = [];
        for (var di = 0; di < allEls.length; di++) {
          var dtag = allEls[di].tagName.toLowerCase();
          if (dtag.indexOf('-') !== -1 && customs.indexOf(dtag) === -1) {
            customs.push(dtag);
          }
        }

        return { text: null, source: 'not-found', customElements: customs.slice(0, 80) };
      }).catch((err) => {
        return { text: null, source: 'error', error: err instanceof Error ? err.message : 'unknown' };
      });

      if (result && result.text) {
        var cleaned = result.text
          .replace(/^Generated Answer\s*/i, '')
          .replace(/\b(ON|OFF)\b/g, '')
          .replace(/Show (more|less)/gi, '')
          .replace(/Citations/gi, '')
          .replace(/\d+ sources?/gi, '')
          .trim();
        if (cleaned.length > 10) {
          logger.info({ length: cleaned.length, source: result.source, selector: (result as any).selector || (result as any).tag }, 'GA extraído do frame');
          return cleaned;
        }
      }

      // Logar diagnóstico
      if (result && (result as any).customElements) {
        logger.info({ customElements: (result as any).customElements }, 'Custom elements no frame (diagnóstico GA)');
      }
      if (result && (result as any).error) {
        logger.warn({ error: (result as any).error }, 'Erro no evaluate do frame (GA)');
      }

      return undefined;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : 'desconhecido' }, 'Erro ao extrair GA do frame');
      return undefined;
    }
  }

  /**
   * Busca GA em TODOS os iframes da página.
   */
  private async extractGeneratedAnswerFromFrames(page: Page): Promise<string | undefined> {
    try {
      var frames = page.frames();
      logger.info({ frameCount: frames.length }, 'Buscando GA em todos os frames');
      for (var fi = 0; fi < frames.length; fi++) {
        var frame = frames[fi];
        if (frame === page.mainFrame()) continue; // já tentamos no main
        try {
          var ga = await this.extractGAFromFrame(frame);
          if (ga) return ga;
        } catch { /* frame pode estar detached */ }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Deep scan recursivo de TODAS respostas JSON capturadas.
   * Procura qualquer chave que contenha 'answer', 'generated', 'genqa', 'rga'
   * e cujo valor seja uma string com mais de 50 caracteres.
   */
  private deepScanJsonForAnswer(apiResponses: Array<{ body: any; url: string }>): string | undefined {
    var answerKeywords = ['answer', 'generated', 'genqa', 'rga', 'completion', 'response_text', 'responsetext', 'airesponse', 'ai_response'];

    var scanObj = (obj: any, depth: number): string | undefined => {
      if (depth > 8 || !obj) return undefined;
      if (typeof obj === 'string' && obj.length > 50) return obj;
      if (Array.isArray(obj)) {
        for (var ai = 0; ai < obj.length; ai++) {
          var r = scanObj(obj[ai], depth + 1);
          if (r) return r;
        }
        return undefined;
      }
      if (typeof obj === 'object') {
        var keys = Object.keys(obj);
        for (var ki = 0; ki < keys.length; ki++) {
          var key = keys[ki].toLowerCase();
          var isAnswerKey = false;
          for (var awi = 0; awi < answerKeywords.length; awi++) {
            if (key.indexOf(answerKeywords[awi]) !== -1) { isAnswerKey = true; break; }
          }
          if (isAnswerKey) {
            var val = obj[keys[ki]];
            if (typeof val === 'string' && val.trim().length > 50) {
              logger.info({ key: keys[ki], length: val.length }, 'GA encontrado via deep scan JSON');
              return val.trim();
            }
            if (typeof val === 'object' && val) {
              // Checar .text, .content, .value dentro do objeto
              var innerText = val.text || val.content || val.value || val.message;
              if (typeof innerText === 'string' && innerText.trim().length > 50) {
                logger.info({ key: keys[ki], innerKey: 'text|content|value', length: innerText.length }, 'GA encontrado via deep scan JSON (nested)');
                return innerText.trim();
              }
            }
          }
          // Recursar em sub-objetos
          var deeper = scanObj(obj[keys[ki]], depth + 1);
          if (deeper) return deeper;
        }
      }
      return undefined;
    };

    for (var ri = 0; ri < apiResponses.length; ri++) {
      var result = scanObj(apiResponses[ri].body, 0);
      if (result) return result;
    }
    return undefined;
  }

  /**
   * Último fallback: extrai o texto completo visível da página e tenta
   * identificar o bloco de texto que é o Generated Answer.
   * Identifica pela posição (antes dos resultados) ou pelo tamanho (parágrafo longo).
   */
  private async extractGeneratedAnswerFromFullText(page: Page): Promise<string | undefined> {
    try {
      var fullText = await page.evaluate(() => {
        // Pegar O HTML completo de áreas de conteúdo principal
        var main = document.querySelector('main, [role="main"], .sapMPage, .sapMShellContent, #content') || document.body;
        // Coletar blocos de texto significativos (parágrafos, divs com texto)
        var blocks: string[] = [];
        var visited: Record<string, boolean> = {};
        var candidates = main.querySelectorAll('p, [class*="text"], [class*="Text"], [class*="answer"], [class*="Answer"], [class*="content"], div > span, section');
        for (var bi = 0; bi < candidates.length; bi++) {
          var blockText = (candidates[bi].textContent || '').trim();
          // Procurar blocos de texto com 100+ caracteres (respostas de IA são longas)
          if (blockText.length > 100 && blockText.length < 10000 && !visited[blockText.substring(0, 80)]) {
            visited[blockText.substring(0, 80)] = true;
            blocks.push(blockText);
          }
        }
        return blocks;
      }).catch(() => []);

      if (fullText && fullText.length > 0) {
        logger.info({ blockCount: fullText.length, sizes: fullText.map((b: string) => b.length) }, 'Blocos de texto encontrados na página');
        // Procurar o bloco que mais parece uma resposta gerada por IA
        // (longo, não é título de artigo, não contém listas de links)
        for (var ti = 0; ti < fullText.length; ti++) {
          var block = fullText[ti];
          // Filtrar blocos que são listas de resultados (muitos links/títulos)
          var linkCount = (block.match(/https?:\/\//g) || []).length;
          var notePattern = (block.match(/\d{7,}/g) || []).length;
          // GA é texto corrido, sem muitos links ou números de nota
          if (block.length > 150 && linkCount < 3 && notePattern < 5) {
            logger.info({ length: block.length, preview: block.substring(0, 150) }, 'Possível GA encontrado via full-text scan');
            return block;
          }
        }
      }

      return undefined;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : 'desconhecido' }, 'Erro no full-text scan');
      return undefined;
    }
  }

  /**
   * Normaliza um link para URL absoluta.
   * Trata caminhos relativos (/notes/xxx), protocolos faltando, e IDs de nota.
   */
  private normalizeLink(rawLink: any, noteId?: any): string {
    const link = typeof rawLink === 'string' ? rawLink.trim() : '';
    const id = typeof noteId === 'string' ? noteId.trim()
      : typeof noteId === 'number' ? String(noteId) : '';

    // Já é URL absoluta
    if (link.startsWith('https://') || link.startsWith('http://')) return link;

    // Caminho relativo (ex: /notes/1999997/E)
    if (link.startsWith('/')) return `https://me.sap.com${link}`;

    // Link sem protocolo (ex: me.sap.com/notes/xxx)
    if (link.includes('sap.com')) return `https://${link}`;

    // Construir a partir do ID da nota
    if (id) return `https://me.sap.com/notes/${id}/E`;

    // Último recurso: retornar vazio (será filtrado depois)
    return link;
  }

  private formatDateToIso(dateText: string): string | undefined {
    const normalized = dateText.trim();
    if (!normalized) return undefined;

    const isoPrefix = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoPrefix) {
      return `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;
    }

    const slashDate = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashDate) {
      return `${slashDate[3]}-${this.padTwo(slashDate[2])}-${this.padTwo(slashDate[1])}`;
    }

    const cleaned = normalized.replace(/\bde\b/gi, ' ').replace(/\./g, ' ').replace(/\u00A0/g, ' ');
    const fallback = new Date(cleaned);
    if (!Number.isNaN(fallback.getTime())) {
      return fallback.toISOString().split('T')[0];
    }

    return undefined;
  }

  private padTwo(value: string): string {
    return value.padStart(2, '0');
  }
}
