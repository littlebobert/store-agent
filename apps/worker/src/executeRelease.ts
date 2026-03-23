import SlackWebApi from "@slack/web-api";
import type { PostgresStore } from "@store-agent/core";
import { ProviderRegistry } from "@store-agent/providers";

const { WebClient } = SlackWebApi;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unknown error occurred.";
}

interface ReleaseExecutorOptions {
  slackBotToken: string;
  ascPath?: string;
  openAiApiKey?: string;
  openAiModel?: string;
}

export class ReleaseExecutor {
  private readonly slackClient: InstanceType<typeof WebClient>;

  private readonly providers: ProviderRegistry;

  public constructor(
    private readonly store: PostgresStore,
    options: ReleaseExecutorOptions
  ) {
    this.slackClient = new WebClient(options.slackBotToken);
    this.providers = new ProviderRegistry({
      apple: {
        binaryPath: options.ascPath,
        env: process.env,
        openAiApiKey: options.openAiApiKey,
        openAiModel: options.openAiModel
      }
    });
  }

  public async processApproval(approvalId: string): Promise<void> {
    const approval = await this.store.getApprovalById(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} was not found.`);
    }

    const appAlias = await this.store.getAppAlias(
      approval.normalizedCommand.appAlias
    );
    if (!appAlias) {
      throw new Error(
        `App alias ${approval.normalizedCommand.appAlias} is not configured.`
      );
    }

    const execution = await this.store.startExecution(approvalId);
    if (!execution) {
      throw new Error(
        `Approval ${approvalId} is not in an executable state.`
      );
    }

    await this.store.appendAuditEvent(approvalId, "execution_started", null, {
      buildId: approval.executionPlan.buildId ?? null
    });

    try {
      const provider = this.providers.get(approval.provider);
      const revalidatedPlan = await provider.revalidate({
        app: appAlias,
        request: approval.normalizedCommand,
        previousPlan: approval.executionPlan
      });
      const result = await provider.execute({
        app: appAlias,
        request: approval.normalizedCommand,
        plan: revalidatedPlan
      });

      await this.store.completeExecution(
        approvalId,
        true,
        {
          summary: result.summary,
          rawResult: result.rawResult ?? {},
          revalidatedPlan
        }
      );
      await this.store.appendAuditEvent(approvalId, "execution_succeeded", null, {
        summary: result.summary
      });

      await this.slackClient.chat.postMessage({
        channel: approval.channelId,
        thread_ts: approval.threadTs ?? undefined,
        text: `<@${approval.requestedBy}> ${result.summary}`
      });
    } catch (error) {
      const message = toErrorMessage(error);
      await this.store.completeExecution(approvalId, false, {
        summary: message
      }, message);
      await this.store.appendAuditEvent(approvalId, "execution_failed", null, {
        error: message
      });

      await this.slackClient.chat.postMessage({
        channel: approval.channelId,
        thread_ts: approval.threadTs ?? undefined,
        text: `<@${approval.requestedBy}> Release execution failed: ${message}`
      });

      throw error;
    }
  }
}
