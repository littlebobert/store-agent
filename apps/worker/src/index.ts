import "dotenv/config";

import { ServiceBusClient } from "@azure/service-bus";
import { serviceBusMessageSchema, PostgresStore } from "@store-agent/core";

import { loadWorkerConfig } from "./config.js";
import { ReleaseExecutor } from "./executeRelease.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const store = new PostgresStore(config.DATABASE_URL);
  const executor = new ReleaseExecutor(store, {
    slackBotToken: config.SLACK_BOT_TOKEN,
    ascPath: config.ASC_PATH,
    openAiApiKey: config.OPENAI_API_KEY,
    openAiModel: config.OPENAI_MODEL
  });

  try {
    if (config.APPROVAL_ID) {
      await executor.processApproval(config.APPROVAL_ID);
      return;
    }

    const client = new ServiceBusClient(config.SERVICE_BUS_CONNECTION_STRING);
    const receiver = client.createReceiver(config.SERVICE_BUS_QUEUE_NAME, {
      receiveMode: "peekLock"
    });

    try {
      const messages = await receiver.receiveMessages(1, {
        maxWaitTimeInMs: config.WORKER_RECEIVE_WAIT_SECONDS * 1000
      });

      if (messages.length === 0) {
        console.log("No release requests available.");
        return;
      }

      const message = messages[0];
      const payload = serviceBusMessageSchema.parse(message.body);

      try {
        await executor.processApproval(payload.approvalId);
        await receiver.completeMessage(message);
      } catch (error) {
        await receiver.abandonMessage(message);
        throw error;
      }
    } finally {
      await receiver.close();
      await client.close();
    }
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
