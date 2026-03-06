import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  SAP_USERNAME: z.string().min(1, 'SAP_USERNAME é obrigatório'),
  SAP_PASSWORD: z.string().min(1, 'SAP_PASSWORD é obrigatório'),
  SAP_SESSION_TTL_MINUTES: z.coerce.number().default(20),
  SAP_BROWSER_HEADLESS: z
    .string()
    .optional()
    .transform((value) => value === 'true')
    .pipe(z.boolean()),
  SAP_LOGIN_MAX_ATTEMPTS: z.coerce.number().default(3),
});

export const env = envSchema.parse(process.env);
