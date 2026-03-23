import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";

import SlackBolt from "@slack/bolt";
import {
  type DraftCommandInput,
  type OpenAiErrorSummary,
  hashApprovalToken,
  isWriteAction,
  modalMetadataSchema,
  OpenAiCommandPlanner,
  OpenAiErrorSummarizer,
  OpenAiStatusSummarizer,
  PostgresStore,
  requireApprovalAccess,
  requireRequestAccess,
  canCancelApproval
} from "@store-agent/core";
import { ProviderRegistry } from "@store-agent/providers";

import { loadApiConfig } from "./config.js";
import { ReleaseQueuePublisher } from "./queue.js";
import {
  buildApprovalBlocks,
  buildErrorBlocks,
  buildReadOnlyBlocks,
  buildRequestModal,
  CANCEL_ACTION_ID,
  CONFIRM_ACTION_ID,
  REQUEST_MODAL_CALLBACK_ID
} from "./slackViews.js";

const { App, ExpressReceiver } = SlackBolt;

function stableKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unknown error occurred.";
}

function formatErrorSummary(summary: OpenAiErrorSummary): string {
  return [summary.shortSummary, ...summary.detailLines.map((line) => `- ${line}`)].join(
    "\n"
  );
}

function parseOptionalValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseModalDraft(viewState: Record<string, Record<string, unknown>>): DraftCommandInput {
  const rawInput = viewState.raw_command?.value as { value?: string } | undefined;
  const appAliasInput = viewState.app_alias?.value as { value?: string } | undefined;
  const versionInput = viewState.version?.value as { value?: string } | undefined;
  const notesInput = viewState.notes?.value as { value?: string } | undefined;
  const releaseModeInput = viewState.release_mode?.value as
    | { selected_option?: { value?: string } }
    | undefined;

  return {
    rawCommand: parseOptionalValue(rawInput?.value) ?? "",
    appAliasOverride: parseOptionalValue(appAliasInput?.value),
    versionOverride: parseOptionalValue(versionInput?.value),
    releaseModeOverride: releaseModeInput?.selected_option?.value as
      | DraftCommandInput["releaseModeOverride"]
      | undefined,
    notesOverride: parseOptionalValue(notesInput?.value)
  };
}

function parseApprovalActionValue(
  value: string | undefined
): { approvalId: string; approvalToken: string } {
  if (!value) {
    throw new Error("Slack action payload did not include approval context.");
  }

  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof parsed.approvalId !== "string" ||
    typeof parsed.approvalToken !== "string"
  ) {
    throw new Error("Approval context is invalid.");
  }

  return {
    approvalId: parsed.approvalId,
    approvalToken: parsed.approvalToken
  };
}

async function postResponse(
  responseUrl: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(
      `Slack response_url call failed with status ${response.status}.`
    );
  }
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const store = new PostgresStore(config.DATABASE_URL);
  await store.migrate();

  const planner = new OpenAiCommandPlanner({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL
  });
  const errorSummarizer = new OpenAiErrorSummarizer({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL
  });
  const statusSummarizer = new OpenAiStatusSummarizer({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL
  });
  const providers = new ProviderRegistry({
    apple: {
      binaryPath: config.ASC_PATH,
      env: process.env,
      openAiApiKey: config.OPENAI_API_KEY,
      openAiModel: config.OPENAI_MODEL
    }
  });
  const queue = new ReleaseQueuePublisher(
    config.SERVICE_BUS_CONNECTION_STRING,
    config.SERVICE_BUS_QUEUE_NAME
  );

  const receiver = new ExpressReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET
  });

  receiver.router.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    receiver
  });

  app.command(config.SLACK_COMMAND_NAME, async ({ ack, body, client }) => {
    const requestKey = stableKey([
      "slash",
      body.team_id ?? "",
      body.channel_id,
      body.user_id,
      body.text ?? "",
      body.trigger_id
    ]);

    await ack();

    try {
      const view = buildRequestModal(
        config.SLACK_COMMAND_NAME,
        {
          channelId: body.channel_id,
          responseUrl: body.response_url,
          requestUserId: body.user_id,
          triggerRequestKey: requestKey
        },
        body.text ?? ""
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view
      });
    } catch (error) {
      await postResponse(body.response_url, {
        response_type: "ephemeral",
        replace_original: false,
        text: toErrorMessage(error),
        blocks: buildErrorBlocks("Unable to open release modal", toErrorMessage(error))
      });
    }
  });

  app.view(REQUEST_MODAL_CALLBACK_ID, async ({ ack, body, view }) => {
    await ack();

    const metadata = modalMetadataSchema.parse(JSON.parse(view.private_metadata));
    let draft: DraftCommandInput | null = null;

    try {
      const submitRequestKey = stableKey([
        "view-submit",
        metadata.triggerRequestKey,
        body.user.id,
        view.id
      ]);
      const inserted = await store.recordProcessedRequest(
        submitRequestKey,
        "view-submit",
        {
          triggerRequestKey: metadata.triggerRequestKey,
          userId: body.user.id,
          viewId: view.id
        }
      );

      if (!inserted) {
        return;
      }

      if (body.user.id !== metadata.requestUserId) {
        throw new Error("Only the requesting Slack user can submit this modal.");
      }

      requireRequestAccess(await store.getSlackUser(body.user.id));

      draft = parseModalDraft(
        view.state.values as Record<string, Record<string, unknown>>
      );
      const normalizedRequest = await planner.parseCommand(draft);
      const appAlias = await store.getAppAlias(normalizedRequest.appAlias);

      if (!appAlias) {
        throw new Error(
          `No app alias named ${normalizedRequest.appAlias} exists in the database.`
        );
      }

      if (appAlias.provider !== normalizedRequest.provider) {
        throw new Error(
          `The app alias ${normalizedRequest.appAlias} is registered for ${appAlias.provider}, not ${normalizedRequest.provider}.`
        );
      }

      const provider = providers.get(normalizedRequest.provider);
      let executionPlan = await provider.resolve({
        app: appAlias,
        request: normalizedRequest
      });

      if (
        normalizedRequest.actionType === "release_status" &&
        "status" in executionPlan.rawProviderData
      ) {
        try {
          const summary = await statusSummarizer.summarizeStatus({
            appAlias: normalizedRequest.appAlias,
            provider: normalizedRequest.provider,
            statusPayload: executionPlan.rawProviderData.status as Record<
              string,
              unknown
            >
          });

          executionPlan = {
            ...executionPlan,
            executionSummary: `Status for ${normalizedRequest.appAlias}: ${summary.shortSummary}`,
            validationSummary: summary.detailLines,
            rawProviderData: {
              ...executionPlan.rawProviderData,
              openAiStatusSummary: summary
            }
          };
        } catch (error) {
          console.error("OpenAI status summarization failed", error);
        }
      }

      if (!isWriteAction(normalizedRequest.actionType)) {
        await postResponse(metadata.responseUrl, {
          response_type: "ephemeral",
          replace_original: false,
          text: executionPlan.executionSummary,
          blocks: buildReadOnlyBlocks(normalizedRequest, executionPlan)
        });
        return;
      }

      const approvalId = randomUUID();
      const approvalToken = randomUUID();
      const expiresAt = new Date(
        Date.now() + config.APPROVAL_TTL_MINUTES * 60 * 1000
      );
      const idempotencyKey = stableKey([
        normalizedRequest.provider,
        normalizedRequest.actionType,
        normalizedRequest.appAlias,
        normalizedRequest.version ?? "",
        executionPlan.buildId ?? "",
        body.user.id
      ]);

      const approval = await store.createApproval({
        approvalId,
        provider: normalizedRequest.provider,
        actionType: normalizedRequest.actionType,
        requestedBy: body.user.id,
        channelId: metadata.channelId,
        responseUrl: metadata.responseUrl,
        rawCommand: normalizedRequest.rawCommand,
        normalizedCommand: normalizedRequest,
        executionPlan,
        idempotencyKey,
        approvalTokenHash: hashApprovalToken(approvalToken),
        expiresAt
      });

      await store.appendAuditEvent(approval.approvalId, "approval_created", body.user.id, {
        request: normalizedRequest,
        executionPlan
      });

      await postResponse(metadata.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text: "Approval required before any App Store Connect write action runs.",
        blocks: buildApprovalBlocks({
          approvalId,
          approvalToken,
          request: normalizedRequest,
          plan: executionPlan,
          expiresAt
        })
      });
    } catch (error) {
      console.error("Unable to plan request", error);
      const rawError = toErrorMessage(error);
      let slackMessage = rawError;

      if (draft) {
        try {
          const summary = await errorSummarizer.summarizePlanningError({
            rawCommand: draft.rawCommand,
            rawError
          });
          slackMessage = formatErrorSummary(summary);
        } catch (summaryError) {
          console.error("OpenAI planning-error summarization failed", summaryError);
        }
      }

      await postResponse(metadata.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text: slackMessage,
        blocks: buildErrorBlocks("Unable to plan request", slackMessage)
      });
    }
  });

  app.action(CONFIRM_ACTION_ID, async ({ ack, body, action, respond }) => {
    await ack();

    try {
      const payload = parseApprovalActionValue((action as { value?: string }).value);
      const requestKey = stableKey([
        "confirm",
        payload.approvalId,
        body.user.id
      ]);
      const inserted = await store.recordProcessedRequest(requestKey, "confirm", {
        approvalId: payload.approvalId,
        userId: body.user.id
      });

      if (!inserted) {
        await respond({
          response_type: "ephemeral",
          text: "This approval click was already processed."
        });
        return;
      }

      requireApprovalAccess(await store.getSlackUser(body.user.id));

      const approval = await store.approvePendingApproval(
        payload.approvalId,
        hashApprovalToken(payload.approvalToken),
        body.user.id
      );

      if (!approval) {
        throw new Error("This approval has expired or was already handled.");
      }

      await store.appendAuditEvent(approval.approvalId, "approval_confirmed", body.user.id, {
        buildId: approval.executionPlan.buildId ?? null
      });
      await queue.sendReleaseRequest({ approvalId: approval.approvalId });

      await respond({
        replace_original: true,
        text: `Release queued. ${approval.executionPlan.executionSummary}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Release queued*\n${approval.executionPlan.executionSummary}`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `The worker will revalidate the exact build and then run:\n\`\`\`${approval.executionPlan.previewCommands.at(-1) ?? "asc submit create"}\`\`\``
            }
          }
        ]
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: toErrorMessage(error),
        blocks: buildErrorBlocks("Unable to confirm approval", toErrorMessage(error))
      });
    }
  });

  app.action(CANCEL_ACTION_ID, async ({ ack, body, action, respond }) => {
    await ack();

    try {
      const payload = parseApprovalActionValue((action as { value?: string }).value);
      const approval = await store.getApprovalById(payload.approvalId);

      if (!approval) {
        throw new Error("The approval request no longer exists.");
      }

      const actor = await store.getSlackUser(body.user.id);
      if (!canCancelApproval(actor, approval.requestedBy)) {
        throw new Error("You are not allowed to cancel this approval.");
      }

      const cancelled = await store.cancelApproval(payload.approvalId);
      if (!cancelled) {
        throw new Error("The approval could not be cancelled.");
      }

      await store.appendAuditEvent(cancelled.approvalId, "approval_cancelled", body.user.id, {});

      await respond({
        replace_original: true,
        text: "Release request cancelled.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Release request cancelled*"
            }
          }
        ]
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: toErrorMessage(error),
        blocks: buildErrorBlocks("Unable to cancel approval", toErrorMessage(error))
      });
    }
  });

  const httpServer = receiver.app.listen(config.PORT);
  await once(httpServer, "listening");
  console.log(`API listening on port ${config.PORT}`);

  async function shutdown(): Promise<void> {
    httpServer.close();
    await queue.close();
    await store.close();
  }

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
