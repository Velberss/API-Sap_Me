import { z } from 'zod';

// ─── Schemas de Entrada ───────────────────────────────────────────
export const knowledgeSearchSchema = z.object({
  query: z.string().min(1, 'O campo de busca é obrigatório')
});

export type KnowledgeSearchRequestDto = z.infer<typeof knowledgeSearchSchema>;

// ─── Schemas de Saída ─────────────────────────────────────────────
// Validação de data ISO 8601
const isoDateSchema = z
  .string()
  .refine(
    (date) => !isNaN(Date.parse(date)),
    'Data deve estar em formato ISO 8601 válido'
  )
  .refine(
    (date) => {
      // Garantir que é data futura válida (não more de 100 anos no passado)
      const parsed = new Date(date);
      const hundredYearsAgo = new Date();
      hundredYearsAgo.setFullYear(hundredYearsAgo.getFullYear() - 100);
      return parsed >= hundredYearsAgo;
    },
    'Data deve estar dentro de um intervalo válido'
  );

// Schema para um artigo de conhecimento
export const knowledgeArticleSchema = z.object({
  title: z.string().min(1, 'Título é obrigatório'),
  link: z.string().url('Link deve ser uma URL válida'),
  date: isoDateSchema.optional()
});

export type KnowledgeArticleDto = z.infer<typeof knowledgeArticleSchema>;

// Schema para resposta completa da API (resposta gerada + artigos)
export const knowledgeSearchResponseSchema = z.object({
  generatedAnswer: z.string().optional(),
  articles: z.array(knowledgeArticleSchema)
});

export type KnowledgeSearchResponseDto = z.infer<typeof knowledgeSearchResponseSchema>;
