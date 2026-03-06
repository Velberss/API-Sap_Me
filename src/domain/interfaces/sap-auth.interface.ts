/** Cookie serializado com todos os campos necessários para o Playwright addCookies */
export interface SapCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface AuthSession {
  cookies: SapCookie[];
  createdAt: number;
  expiresAt: number;
}

export interface ISapAuthProvider {
  login(): Promise<AuthSession>;
}
