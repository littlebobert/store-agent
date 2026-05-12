import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_COMMAND_NAME: z.string().min(1).default("/asc"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
  OPENAI_SERVICE_TIER: z
    .enum(["auto", "default", "flex", "scale", "priority"])
    .default("priority"),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  SERVICE_BUS_CONNECTION_STRING: z.string().min(1),
  SERVICE_BUS_QUEUE_NAME: z.string().min(1).default("release-requests"),
  ASC_PATH: z.string().min(1).default("asc"),
  PORT: z.coerce.number().int().positive().default(3000)
});

export type ApiConfig = z.infer<typeof configSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return configSchema.parse(env);
}
