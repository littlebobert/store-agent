import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  SLACK_BOT_TOKEN: z.string().min(1),
  SERVICE_BUS_CONNECTION_STRING: z.string().min(1),
  SERVICE_BUS_QUEUE_NAME: z.string().min(1).default("release-requests"),
  ASC_PATH: z.string().min(1).default("asc"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4"),
  WORKER_RECEIVE_WAIT_SECONDS: z.coerce.number().int().positive().default(10),
  APPROVAL_ID: z.string().uuid().optional()
});

export type WorkerConfig = z.infer<typeof configSchema>;

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  return configSchema.parse(env);
}
