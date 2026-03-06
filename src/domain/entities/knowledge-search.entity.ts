/** Busca simples — campo único */
export interface KnowledgeSearchInput {
  query: string;
}

/** Resultado retornado pela API */
export interface KnowledgeArticle {
  title: string;
  link: string;
  date?: string; // ISO 8601 format: YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ssZ
}

/** Resposta completa da busca — artigos + resposta gerada por IA */
export interface KnowledgeSearchResult {
  generatedAnswer?: string;
  articles: KnowledgeArticle[];
}
