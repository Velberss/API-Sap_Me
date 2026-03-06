/**
 * Configurações stealth para evitar detecção de automação pelo portal SAP.
 * Aplicadas no launch do Chromium e no contexto do browser.
 */

/** User-Agent real de Chrome estável no Windows */
export const REAL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Args do Chromium para reduzir detecção de headless */
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-sandbox'
];
