import { chromium, Page } from 'playwright';

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
        const overlay = document.getElementById('trustarc-banner-overlay');
        if (overlay) overlay.remove();
        const banner = document.getElementById('consent_blackbar');
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

      // NÃO capturar SSE aqui — o response.text() só pode ser chamado uma vez,
      // e precisamos ler no waitForResponse abaixo. Aqui capturamos APENAS JSON.
      page.on('response', async (response) => {
        try {
          const url = response.url();
          const status = response.status();
          const contentType = response.headers()['content-type'] || '';

          // Capturar APENAS respostas JSON de busca (NÃO SSE)
          if (
            status >= 200 && status < 300 &&
            (url.includes('search') || url.includes('knowledge') || url.includes('note') || url.includes('kba') || url.includes('api')) &&
            contentType.includes('json')
          ) {
            const body = await response.json().catch(() => null);
            if (body) {
              apiResponses.push({ body, url });
              logger.info({ url, bodyKeys: Object.keys(body) }, 'Interceptada resposta JSON de busca');
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

      const ssePromise = page.waitForResponse(
        (resp) => {
          const url = resp.url();
          const ct = resp.headers()['content-type'] || '';
          return (
            url.includes('coveo.com') && (
              ct.includes('event-stream') ||
              ct.includes('text/plain') ||
              url.includes('genqa') ||
              url.includes('stream') ||
              url.includes('machinelearning')
            )
          );
        },
        { timeout: 20_000 }
      ).then(async (sseResponse) => {
        logger.info({ url: sseResponse.url(), status: sseResponse.status() }, 'Resposta SSE do Coveo capturada');
        const sseText = await sseResponse.text().catch((err: unknown) => {
          logger.warn({ error: err instanceof Error ? err.message : 'unknown' }, 'Erro ao ler corpo SSE');
          return '';
        });
        if (sseText) {
          sseChunks.push(sseText);
          logger.info({ length: sseText.length }, 'Dados SSE lidos com sucesso');
        }
      }).catch(() => {
        logger.info('Timeout aguardando resposta SSE do Coveo GenQA');
      });

      // AGORA submeter a busca (as promises já estão ouvindo)
      await searchInput.click();
      await searchInput.fill(query);
      await page.keyboard.press('Enter');

      logger.info('Busca submetida — aguardando resultados (Coveo + SSE em paralelo) …');

      // Estratégia otimizada: prosseguir assim que o Coveo REST responder.
      // Dar ao SSE um grace period de 12s após o Coveo REST para capturar
      // o Generated Answer. O GenQA (SSE) leva ~10-12s independentemente
      // da velocidade do REST, portanto o grace precisa ser generoso.
      await coveoSearchPromise;
      logger.info('Coveo REST processado — dando grace period de 12s para SSE …');

      // Grace period: se o SSE já completou, resolve imediatamente.
      // Se não, esperamos no máximo 12s adicionais.
      await Promise.race([
        ssePromise,
        new Promise((resolve) => setTimeout(resolve, 12_000))
      ]);
      logger.info({ sseChunksCount: sseChunks.length }, 'Respostas Coveo processadas');

      logger.info({ url: page.url() }, 'Página de resultados carregada');

      // ─── Etapa 5: Extrair resultados ────────────────────────────────────
      // Estratégia A: Tentar extrair dos dados interceptados da API
      let articles: KnowledgeArticle[] = this.extractFromApiResponses(apiResponses);

      if (articles.length > 0) {
        logger.info({ count: articles.length, source: 'api-intercept' }, 'Resultados extraídos via interceptação de API');
      } else {
        // Estratégia B: Extrair do DOM com seletores mais específicos
        logger.info('Nenhum resultado via API — tentando extração do DOM …');
        articles = await this.extractFromDom(page);
        logger.info({ count: articles.length, source: 'dom' }, 'Resultados extraídos do DOM');
      }

      // Filtrar artigos sem link válido (evita VALIDATION_ERROR no schema Zod)
      const validArticles = articles.filter((a) => a.link && a.link.startsWith('http'));

      // ─── Etapa 6: Capturar Generated Answer ─────────────────────────────
      // Estratégia A: Tentar extrair do DOM (elementos renderizados pela SPA)
      let generatedAnswer = await this.extractGeneratedAnswer(page);

      // Estratégia A.1: Se não encontrou no DOM imediatamente, aguardar o
      // GenQA renderizar (o streaming demora — faz polling por até 15s).
      // Isso é crítico para chamadas com sessão em cache, onde a busca
      // é rápida mas o GenQA ainda está sendo processado pelo Coveo.
      if (!generatedAnswer) {
        logger.info('Generated Answer não encontrado imediatamente — aguardando renderização no DOM …');
        const gaRendered = await this.waitForGeneratedAnswer(page);
        if (gaRendered) {
          generatedAnswer = await this.extractGeneratedAnswer(page);
          if (generatedAnswer) {
            logger.info({ length: generatedAnswer.length, source: 'dom-wait' }, 'Generated Answer capturado após aguardar renderização');
          }
        }
      }

      // Estratégia B: Se não encontrou no DOM, tentar extrair dos dados SSE capturados
      if (!generatedAnswer && sseChunks.length > 0) {
        logger.info({ chunks: sseChunks.length }, 'Tentando extrair Generated Answer dos dados SSE …');
        generatedAnswer = this.extractGeneratedAnswerFromSse(sseChunks);
        if (generatedAnswer) {
          logger.info({ length: generatedAnswer.length }, 'Generated Answer extraído dos dados SSE');
        }
      }

      // Estratégia C: Se ainda não encontrou, verificar se há texto nas respostas JSON do Coveo
      if (!generatedAnswer) {
        for (const { body } of apiResponses) {
          const ga = body?.generatedAnswer || body?.generativeAnswer || body?.answer || body?.genQA;
          if (ga && typeof ga === 'string' && ga.length > 20) {
            generatedAnswer = ga.trim();
            logger.info({ length: generatedAnswer.length, source: 'api-json' }, 'Generated Answer extraído da resposta JSON');
            break;
          }
          // Coveo pode incluir generatedAnswer como objeto
          if (ga && typeof ga === 'object' && ga.text) {
            generatedAnswer = ga.text.trim();
            logger.info({ length: generatedAnswer!.length, source: 'api-json-obj' }, 'Generated Answer extraído da resposta JSON (objeto)');
            break;
          }
        }
      }

      logger.info(
        { total: articles.length, valid: validArticles.length, hasGeneratedAnswer: !!generatedAnswer },
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
      const results: Array<{ title: string; link: string; dateText?: string }> = [];
      const seen = new Set<string>();

      // Regex para detectar datas em texto
      const dateRe = /(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}[\s.]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.,]+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.]+\d{1,2}[\s.,]+\d{4})/i;

      // Auxiliar: extrair data de um container
      function findDate(container: Element | null): string | undefined {
        if (!container) return undefined;

        // 1. <time datetime="...">
        const timeEl = container.querySelector('time[datetime]');
        if (timeEl) return timeEl.getAttribute('datetime') || undefined;

        // 2. Elemento com classe contendo "date"
        const dateEl = container.querySelector('[class*="date" i], [class*="Date"], [class*="time" i], [class*="updated" i], [class*="modified" i]');
        if (dateEl) {
          const m = (dateEl.textContent || '').match(dateRe);
          if (m) return m[0];
        }

        // 3. Qualquer texto no container que pareça uma data
        const fullText = container.textContent || '';
        const m = fullText.match(dateRe);
        if (m) return m[0];

        return undefined;
      }

      // ─── Seletores específicos do portal SAP UI5 ───────────────
      // O portal SAP usa diversas classes UI5 para renderizar listas de resultados.
      // Tentamos múltiplas abordagens para cobrir variações.

      // Abordagem 1: Items em listas SAP UI5 (sapMLIB, sapMSLI, sapMListTblRow, etc.)
      const ui5Items = document.querySelectorAll([
        '.sapMLIB',                       // List item base
        '.sapMSLI',                       // Standard list item
        '.sapMListTblRow',                // Table row
        '[class*="SearchResult"]',        // Custom search result class
        '[class*="searchResult"]',
        '[class*="resultItem"]',
        '[class*="ResultItem"]',
        '[class*="ListItem"]',
        'li[class*="sap"]',
        'tr[class*="sap"]'
      ].join(', '));

      ui5Items.forEach((item) => {
        const anchor = item.querySelector('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href') || '';
        // Aceitar links relativos (o SAP pode usar /notes/xxx) ou absolutos
        const fullHref = href.startsWith('/') ? `https://me.sap.com${href}` : href;
        if (!fullHref.includes('sap.com') && !fullHref.includes('help.sap')) return;

        const title = (anchor.textContent || item.querySelector('[class*="title" i], [class*="Title"], .sapMSLITitle, .sapMLIBContent')?.textContent || '').trim();
        if (title.length < 4 || seen.has(title + fullHref)) return;
        seen.add(title + fullHref);

        results.push({ title, link: fullHref, dateText: findDate(item) });
      });

      // Abordagem 2: Links que apontam para notas SAP, KBAs, ou help.sap.com
      if (results.length < 5) {
        const allLinks = document.querySelectorAll('a[href]');
        allLinks.forEach((a) => {
          const href = a.getAttribute('href') || '';
          const fullHref = href.startsWith('/') ? `https://me.sap.com${href}` : href;

          // Filtrar: apenas links para notas/KBAs/help
          const isSapResult =
            fullHref.includes('/notes/') ||
            fullHref.includes('/kba/') ||
            fullHref.includes('launchpad.support.sap.com') ||
            fullHref.includes('help.sap.com/docs') ||
            fullHref.includes('/knowledgebase/') ||
            /\/notes\/\d+/.test(fullHref);

          if (!isSapResult) return;

          const title = (a.textContent || '').trim();
          if (title.length < 4 || title.length > 500 || seen.has(title + fullHref)) return;
          seen.add(title + fullHref);

          // Subir na árvore DOM para encontrar o container do resultado
          const container = a.closest('li, tr, [class*="item"], [class*="Item"], [class*="result"], [class*="Result"], [class*="row"], [class*="Row"], div[class]');
          results.push({ title, link: fullHref, dateText: findDate(container) });
        });
      }

      // Abordagem 3: Qualquer link no corpo principal (excluindo header/footer/nav)
      if (results.length < 3) {
        const mainContent = document.querySelector('main, [role="main"], .sapMPage, .sapMShellContent, #content, [class*="content" i]') || document.body;
        const allLinks = mainContent.querySelectorAll('a[href]');
        allLinks.forEach((a) => {
          const href = a.getAttribute('href') || '';
          const title = (a.textContent || '').trim();
          const fullHref = href.startsWith('/') ? `https://me.sap.com${href}` : href;

          if (
            title.length > 5 && title.length < 500 &&
            (fullHref.startsWith('https://') || fullHref.startsWith('http://')) &&
            fullHref.includes('sap.com') &&
            !seen.has(title + fullHref)
          ) {
            // Excluir links de navegação genéricos
            const lower = title.toLowerCase();
            if (
              lower === 'home' || lower === 'services & support' ||
              lower === 'get assistance' || lower.startsWith('log') ||
              lower === 'status' || lower === 'community' ||
              lower === 'learning' || lower === 'partnership'
            ) return;

            seen.add(title + fullHref);
            const container = a.closest('li, tr, div[class], section');
            results.push({ title, link: fullHref, dateText: findDate(container) });
          }
        });
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
   * Estratégia:
   *   1. Polling agressivo no DOM por 25s procurando QUALQUER traço de generated answer
   *   2. Se container encontrado, aguardar o texto renderizar (mais 15s)
   */
  private async waitForGeneratedAnswer(page: Page): Promise<boolean> {
    const startTime = Date.now();

    // Seletores amplos para o container do Generated Answer
    const containerSelectors = [
      '.sapMeCoveoGeneratedAnswerContainer',
      '.sapMeCoveoGeneratedAnswerCard',
      '.sapMeCoveoSearchGeneratedAnswerText',
      '[id*="generatedAnswer"]',
      '[id*="GeneratedAnswer"]',
      '[class*="GeneratedAnswer"]',
      '[class*="generated-answer"]',
      '[class*="genqa"]',
      '[class*="gen-qa"]',
      '[data-source-component="GenQA"]',
      '[data-coveo-genqa]'
    ].join(', ');

    try {
      // Passo 1: Polling para encontrar QUALQUER elemento de generated answer no DOM
      const maxWaitContainer = 26_000;
      let containerFound = false;
      
      while (Date.now() - startTime < maxWaitContainer) {
        const count = await page.locator(containerSelectors).count();
        if (count > 0) {
          containerFound = true;
          logger.info({ elapsed: Date.now() - startTime, count }, 'Container do Generated Answer detectado no DOM');
          break;
        }
        
        // Também verificar via evaluate (pode pegar elementos dinamicamente criados)
        const foundViaJs = await page.evaluate((selectors) => {
          const el = document.querySelector(selectors);
          if (el) return { tag: el.tagName, id: el.id, className: el.className.toString().substring(0, 200) };
          // Busca alternativa: procurar por texto "Generated Answer" na página
          const allEls = document.querySelectorAll('*');
          for (const e of allEls) {
            const cls = e.className?.toString?.() || '';
            const id = e.id || '';
            if (cls.toLowerCase().includes('generated') || id.toLowerCase().includes('generated')) {
              return { tag: e.tagName, id, className: cls.substring(0, 200), source: 'text-scan' };
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

      // Passo 2: Se o container existe, aguardar o texto renderizar
      const textSelectors = [
        '.sapMeCoveoSearchGeneratedAnswerText',
        '[class*="GeneratedAnswer"] p',
        '[class*="GeneratedAnswer"] span',
        '[class*="generated-answer"] p',
        '[id*="generatedAnswer"]'
      ].join(', ');

      const maxWaitText = 15_000;
      const textStart = Date.now();
      
      while (Date.now() - textStart < maxWaitText) {
        const text = await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          let combined = '';
          for (const el of els) {
            combined += ' ' + (el.textContent || '');
          }
          return combined.trim();
        }, textSelectors).catch(() => '');

        if (text.length > 20) {
          logger.info({ length: text.length, elapsed: Date.now() - startTime }, 'Generated Answer renderizado com conteúdo');
          await page.waitForTimeout(2_000); // buffer para streaming completar
          return true;
        }
        await page.waitForTimeout(1_000);
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
    try {
      // Abordagem 1: Seletores específicos conhecidos
      const specificSelectors = [
        '.sapMeCoveoSearchGeneratedAnswerText',
        '[class*="GeneratedAnswerText"]',
        '[class*="generated-answer-text"]',
        '[class*="genqa-text"]'
      ].join(', ');

      const primaryEl = page.locator(specificSelectors).first();
      const primaryExists = await primaryEl.count() > 0;

      if (primaryExists) {
        const text = await primaryEl.innerText().catch(() => '');
        const trimmed = text.trim();
        if (trimmed.length > 10) {
          logger.info({ length: trimmed.length, source: 'specific-selector' }, 'Generated Answer capturado');
          return trimmed;
        }
      }

      // Abordagem 2: Container amplo
      const containerSelectors = [
        '.sapMeCoveoGeneratedAnswerContainer',
        '.sapMeCoveoGeneratedAnswerCard',
        '[id*="generatedAnswer"]',
        '[id*="GeneratedAnswer"]',
        '[class*="GeneratedAnswer"]',
        '[class*="generated-answer"]'
      ].join(', ');

      const containerEl = page.locator(containerSelectors).first();
      const containerExists = await containerEl.count() > 0;

      if (containerExists) {
        const text = await containerEl.innerText().catch(() => '');
        const cleaned = text
          .replace(/^Generated Answer\s*/i, '')
          .replace(/\b(ON|OFF)\b/g, '')
          .replace(/Show (more|less)/gi, '')
          .replace(/Citations/gi, '')
          .replace(/\d+ sources?/gi, '')
          .trim();
        if (cleaned.length > 10) {
          logger.info({ length: cleaned.length, source: 'container-selector' }, 'Generated Answer capturado via container');
          return cleaned;
        }
      }

      // Abordagem 3: Busca via evaluate (pode encontrar elementos ocultos ou shadow DOM)
      const domText = await page.evaluate(() => {
        // Buscar por qualquer elemento que contenha "generated" ou "genqa" no className
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const cls = el.className?.toString?.()?.toLowerCase() || '';
          const id = (el.id || '').toLowerCase();
          const isGenAnswer = cls.includes('generatedanswertext') || cls.includes('generated-answer-text')
            || id.includes('generatedanswertext') || cls.includes('genqa');
          if (isGenAnswer) {
            const text = (el.textContent || '').trim();
            if (text.length > 20) return text;
          }
        }
        return null;
      }).catch(() => null);

      if (domText) {
        logger.info({ length: domText.length, source: 'evaluate-scan' }, 'Generated Answer capturado via evaluate');
        return domText;
      }

      logger.info('Generated Answer não encontrado na página');
      return undefined;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : 'desconhecido' }, 'Erro ao extrair Generated Answer');
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
