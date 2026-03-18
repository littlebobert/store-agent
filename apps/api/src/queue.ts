import { ServiceBusClient } from "@azure/service-bus";

import type { ServiceBusMessage } from "@store-agent/core";

export class ReleaseQueuePublisher {
  private readonly client: ServiceBusClient;

  private readonly sender;

  public constructor(connectionString: string, queueName: string) {
    this.client = new ServiceBusClient(connectionString);
    this.sender = this.client.createSender(queueName);
  }

  public async sendReleaseRequest(message: ServiceBusMessage): Promise<void> {
    await this.sender.sendMessages({
      body: message
    });
  }

  public async close(): Promise<void> {
    await this.sender.close();
    await this.client.close();
  }
}
