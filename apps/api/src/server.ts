import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";

import SlackBolt from "@slack/bolt";
import {
  type AppAliasRecord,
  type ConversationMessage,
  type ConversationSessionRecord,
  finalizeNormalizedActionRequest,
  type NormalizedActionRequest,
  type OpenAiErrorSummary,
  type PlannedActionRequest,
  type ProviderExecutionPlan,
  canCancelApproval,
  hashApprovalToken,
  isWriteAction,
  OpenAiCommandPlanner,
  OpenAiErrorSummarizer,
  OpenAiStatusSummarizer,
  PostgresStore,
  requireApprovalAccess,
  requireRequestAccess,
  summarizeActionRequest
} from "@store-agent/core";
import { ProviderRegistry } from "@store-agent/providers";

import { loadApiConfig } from "./config.js";
import { ReleaseQueuePublisher } from "./queue.js";
import {
  buildApprovalBlocks,
  buildConversationMessageBlocks,
  buildErrorBlocks,
  buildReadOnlyBlocks,
  CANCEL_ACTION_ID,
  CONFIRM_ACTION_ID
} from "./slackViews.js";

const { App, ExpressReceiver } = SlackBolt;

const MAX_CONVERSATION_MESSAGES = 20;

interface SlackMessageEvent {
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  ts: string;
  subtype?: string;
  bot_id?: string;
}

interface ConversationTarget {
  channelId: string;
  threadTs: string | null;
}

interface SlackChatClient {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
    }): Promise<{ ts?: string }>;
  };
}

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

function extractGeneratedCommandFromError(rawError: string): string | null {
  const match = rawError.match(/Generated command:\s*(.+)$/im);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : null;
}

function formatRawPlanningError(rawError: string): string {
  const generatedCommand = extractGeneratedCommandFromError(rawError);
  if (!generatedCommand) {
    return rawError;
  }

  const withoutGeneratedCommand = rawError
    .replace(/\s*Generated command:\s*.+$/im, "")
    .trim();

  return `${withoutGeneratedCommand}\n\nGenerated command:\n\`\`\`${generatedCommand}\`\`\``;
}

function stripAppMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").replace(/\s+/g, " ").trim();
}

function normalizeConversationMessages(
  messages: ConversationMessage[]
): ConversationMessage[] {
  return messages.slice(-MAX_CONVERSATION_MESSAGES);
}

function buildConversationRawCommand(
  messages: ConversationMessage[]
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n");
}

function buildConversationContextSummary(
  request: NormalizedActionRequest,
  plan: ProviderExecutionPlan
): string {
  return `${summarizeActionRequest(request)}. ${plan.executionSummary}`;
}

async function resolveConfiguredApp(
  store: PostgresStore,
  request: PlannedActionRequest
): Promise<{
  appAlias: AppAliasRecord;
  normalizedRequest: NormalizedActionRequest;
}> {
  const directMatch = await store.getAppAlias(request.appReference);
  if (directMatch && directMatch.provider === request.provider) {
    return {
      appAlias: directMatch,
      normalizedRequest: finalizeNormalizedActionRequest(
        request,
        directMatch.alias
      )
    };
  }

  const identifierMatches = await store.findAppAliasesByMetadataIdentifier(
    request.provider,
    request.appReference
  );

  if (identifierMatches.length === 1) {
    const resolvedAppAlias = identifierMatches[0];
    return {
      appAlias: resolvedAppAlias,
      normalizedRequest: finalizeNormalizedActionRequest(
        request,
        resolvedAppAlias.alias
      )
    };
  }

  if (identifierMatches.length > 1) {
    throw new Error(
      `The app reference "${request.appReference}" matched multiple configured ${request.provider} apps: ${identifierMatches.map((match) => match.alias).join(", ")}. Use the exact app alias.`
    );
  }

  if (directMatch) {
    throw new Error(
      `The app reference ${request.appReference} is registered for ${directMatch.provider}, not ${request.provider}.`
    );
  }

  throw new Error(
    `The app reference "${request.appReference}" could not be resolved to a configured ${request.provider} app alias or metadata identifier.`
  );
}

function isDirectMessageChannelId(channelId: string): boolean {
  return channelId.startsWith("D");
}

function inferChannelType(event: SlackMessageEvent): string {
  if (event.channel_type) {
    return event.channel_type;
  }

  if (isDirectMessageChannelId(event.channel)) {
    return "im";
  }

  if (event.channel.startsWith("G")) {
    return "group";
  }

  if (event.channel.startsWith("C")) {
    return "channel";
  }

  return "unknown";
}

function extractTeamId(body: Record<string, unknown>): string {
  if (typeof body.team_id === "string" && body.team_id.length > 0) {
    return body.team_id;
  }

  if (Array.isArray(body.authorizations)) {
    for (const authorization of body.authorizations) {
      if (
        authorization !== null &&
        typeof authorization === "object" &&
        typeof (authorization as { team_id?: unknown }).team_id === "string"
      ) {
        return (authorization as { team_id: string }).team_id;
      }
    }
  }

  throw new Error("Slack did not include a team ID for this request.");
}

function buildConversationTarget(
  channelId: string,
  threadTs?: string | null
): ConversationTarget {
  return {
    channelId,
    threadTs: threadTs && threadTs.length > 0 ? threadTs : null
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

async function postConversationMessage(
  client: SlackChatClient,
  target: ConversationTarget,
  body: {
    text: string;
    blocks?: unknown[];
  }
): Promise<{ ts?: string }> {
  return client.chat.postMessage({
    channel: target.channelId,
    thread_ts: target.threadTs ?? undefined,
    text: body.text,
    blocks: body.blocks
  });
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

  async function saveConversationSession(input: {
    existingSession?: ConversationSessionRecord | null;
    teamId: string;
    channelId: string;
    threadTs?: string | null;
    ownerSlackUserId: string;
    messages: ConversationMessage[];
    lastNormalizedRequest?: NormalizedActionRequest | null;
    lastExecutionPlan?: ProviderExecutionPlan | null;
  }): Promise<ConversationSessionRecord> {
    return store.upsertConversationSession({
      sessionId: input.existingSession?.sessionId ?? randomUUID(),
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs ?? null,
      ownerSlackUserId: input.ownerSlackUserId,
      messages: normalizeConversationMessages(input.messages),
      lastNormalizedRequest:
        input.lastNormalizedRequest === undefined
          ? (input.existingSession?.lastNormalizedRequest ?? null)
          : input.lastNormalizedRequest,
      lastExecutionPlan:
        input.lastExecutionPlan === undefined
          ? (input.existingSession?.lastExecutionPlan ?? null)
          : input.lastExecutionPlan
    });
  }

  async function discardConversationSession(
    session: ConversationSessionRecord
  ): Promise<void> {
    await store.cancelPendingApprovalsForConversationSession(session.sessionId);
    await store.deleteConversationSession(session.sessionId);
  }

  async function processConversationTurn(input: {
    client: SlackChatClient;
    teamId: string;
    channelId: string;
    threadTs?: string | null;
    userId: string;
    text: string;
    allowCreate: boolean;
    resetSession: boolean;
    respondOnOwnershipConflict: boolean;
  }): Promise<void> {
    const trimmedText = input.text.trim();
    if (trimmedText.length === 0) {
      return;
    }

    const target = buildConversationTarget(input.channelId, input.threadTs);
    let session: ConversationSessionRecord | null = null;
    let normalizedRequest: NormalizedActionRequest | null = null;
    let executionPlan: ProviderExecutionPlan | null = null;

    try {
      const existingSession = await store.getConversationSession(
        input.teamId,
        input.channelId,
        input.threadTs
      );

      if (existingSession && existingSession.ownerSlackUserId !== input.userId) {
        if (input.respondOnOwnershipConflict) {
          await postConversationMessage(input.client, target, {
            text: `This conversation belongs to <@${existingSession.ownerSlackUserId}>. Start a new ${config.SLACK_COMMAND_NAME} or mention the bot in a new thread to create your own plan.`,
            blocks: buildConversationMessageBlocks(
              "Conversation already in progress",
              `This thread belongs to <@${existingSession.ownerSlackUserId}>. Start a new ${config.SLACK_COMMAND_NAME} or mention the bot in a new thread to create your own plan.`
            )
          });
        }
        return;
      }

      if (input.resetSession && existingSession) {
        await discardConversationSession(existingSession);
        session = null;
      } else {
        session = existingSession;
      }

      if (!session && !input.allowCreate && !input.resetSession) {
        return;
      }

      requireRequestAccess(await store.getSlackUser(input.userId));

      session = await saveConversationSession({
        existingSession: session,
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        ownerSlackUserId: input.userId,
        messages: [
          ...(input.resetSession ? [] : session?.messages ?? []),
          {
            role: "user",
            content: trimmedText
          }
        ],
        lastNormalizedRequest: input.resetSession
          ? null
          : session?.lastNormalizedRequest,
        lastExecutionPlan: input.resetSession
          ? null
          : session?.lastExecutionPlan
      });

      const turn = await planner.planConversationTurn({
        messages: session.messages,
        previousRequest: session.lastNormalizedRequest
      });

      if (!turn.plannedRequest) {
        session = await saveConversationSession({
          existingSession: session,
          teamId: session.teamId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          ownerSlackUserId: session.ownerSlackUserId,
          messages: [
            ...session.messages,
            {
              role: "assistant",
              content: turn.assistantReply
            }
          ]
        });

        await postConversationMessage(input.client, target, {
          text: turn.assistantReply,
          blocks: buildConversationMessageBlocks(
            "Need one more detail",
            turn.assistantReply
          )
        });
        return;
      }

      const resolvedApp = await resolveConfiguredApp(store, turn.plannedRequest);
      normalizedRequest = resolvedApp.normalizedRequest;
      const appAlias = resolvedApp.appAlias;

      const provider = providers.get(normalizedRequest.provider);
      executionPlan = await provider.resolve({
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

      session = await saveConversationSession({
        existingSession: session,
        teamId: session.teamId,
        channelId: session.channelId,
        threadTs: session.threadTs,
        ownerSlackUserId: session.ownerSlackUserId,
        messages: [
          ...session.messages,
          {
            role: "assistant",
            content: buildConversationContextSummary(
              normalizedRequest,
              executionPlan
            )
          }
        ],
        lastNormalizedRequest: normalizedRequest,
        lastExecutionPlan: executionPlan
      });

      if (
        !executionPlan.requiresConfirmation &&
        !isWriteAction(normalizedRequest.actionType)
      ) {
        await postConversationMessage(input.client, target, {
          text: executionPlan.executionSummary,
          blocks: buildReadOnlyBlocks(normalizedRequest, executionPlan)
        });
        return;
      }

      await store.cancelPendingApprovalsForConversationSession(session.sessionId);

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
        input.userId,
        session.sessionId
      ]);

      const approval = await store.createApproval({
        approvalId,
        provider: normalizedRequest.provider,
        actionType: normalizedRequest.actionType,
        requestedBy: input.userId,
        channelId: session.channelId,
        threadTs: session.threadTs,
        responseUrl: null,
        rawCommand: normalizedRequest.rawCommand,
        normalizedCommand: normalizedRequest,
        executionPlan,
        conversationSessionId: session.sessionId,
        idempotencyKey,
        approvalTokenHash: hashApprovalToken(approvalToken),
        expiresAt
      });

      await store.appendAuditEvent(approval.approvalId, "approval_created", input.userId, {
        request: normalizedRequest,
        executionPlan,
        conversationSessionId: session.sessionId
      });

      await postConversationMessage(input.client, target, {
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
      const rawCommand = session ? buildConversationRawCommand(session.messages) : trimmedText;
      const generatedCommand = extractGeneratedCommandFromError(rawError);
      let slackMessage = generatedCommand
        ? formatRawPlanningError(rawError)
        : rawError;

      if (!generatedCommand) {
        try {
          const summary = await errorSummarizer.summarizePlanningError({
            rawCommand,
            rawError
          });
          slackMessage = formatErrorSummary(summary);
        } catch (summaryError) {
          console.error("OpenAI planning-error summarization failed", summaryError);
        }
      }

      if (session) {
        await saveConversationSession({
          existingSession: session,
          teamId: session.teamId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          ownerSlackUserId: session.ownerSlackUserId,
          messages: [
            ...session.messages,
            {
              role: "assistant",
              content: slackMessage
            }
          ],
          lastNormalizedRequest:
            normalizedRequest ?? session.lastNormalizedRequest,
          lastExecutionPlan: executionPlan ?? session.lastExecutionPlan
        });
      }

      await postConversationMessage(input.client, target, {
        text: slackMessage,
        blocks: buildErrorBlocks("Unable to plan request", slackMessage)
      });
    }
  }

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
    await ack();

    try {
      requireRequestAccess(await store.getSlackUser(body.user_id));

      const teamId = body.team_id ?? "";
      if (!teamId) {
        throw new Error("Slack did not include a team ID for this command.");
      }

      const initialText = body.text.trim();

      if (isDirectMessageChannelId(body.channel_id)) {
        if (initialText.length === 0) {
          const intro =
            "Reply here with a release request in English or Japanese. I’ll plan the exact asc steps, ask follow-up questions if needed, and show the final commands before any write action runs.";

          const existingSession = await store.getConversationSession(
            teamId,
            body.channel_id
          );
          if (existingSession) {
            await discardConversationSession(existingSession);
          }

          await saveConversationSession({
            teamId,
            channelId: body.channel_id,
            ownerSlackUserId: body.user_id,
            messages: [
              {
                role: "assistant",
                content: intro
              }
            ],
            lastNormalizedRequest: null,
            lastExecutionPlan: null
          });

          await postConversationMessage(client, buildConversationTarget(body.channel_id), {
            text: intro,
            blocks: buildConversationMessageBlocks("Conversation started", intro)
          });
          return;
        }

        await processConversationTurn({
          client,
          teamId,
          channelId: body.channel_id,
          userId: body.user_id,
          text: initialText,
          allowCreate: true,
          resetSession: true,
          respondOnOwnershipConflict: true
        });
        return;
      }

      const intro =
        initialText.length === 0
          ? `Reply in this thread with a release request in English or Japanese. I’ll plan the exact asc steps, ask follow-up questions if needed, and show the final commands before any write action runs.`
          : `I’m planning <@${body.user_id}>’s request in this thread. Reply here to revise the plan before approving it.`;

      const startMessage = await postConversationMessage(
        client,
        buildConversationTarget(body.channel_id),
        {
          text: `<@${body.user_id}> started a release planning conversation.`,
          blocks: buildConversationMessageBlocks("Conversation started", intro)
        }
      );

      const threadTs = startMessage.ts;
      if (!threadTs) {
        throw new Error("Slack did not return a thread timestamp for the conversation.");
      }

      if (initialText.length === 0) {
        await saveConversationSession({
          teamId,
          channelId: body.channel_id,
          threadTs,
          ownerSlackUserId: body.user_id,
          messages: [
            {
              role: "assistant",
              content: intro
            }
          ],
          lastNormalizedRequest: null,
          lastExecutionPlan: null
        });
        return;
      }

      await saveConversationSession({
        teamId,
        channelId: body.channel_id,
        threadTs,
        ownerSlackUserId: body.user_id,
        messages: [],
        lastNormalizedRequest: null,
        lastExecutionPlan: null
      });

      await processConversationTurn({
        client,
        teamId,
        channelId: body.channel_id,
        threadTs,
        userId: body.user_id,
        text: initialText,
        allowCreate: false,
        resetSession: false,
        respondOnOwnershipConflict: true
      });
    } catch (error) {
      await postResponse(body.response_url, {
        response_type: "ephemeral",
        replace_original: false,
        text: toErrorMessage(error),
        blocks: buildErrorBlocks(
          "Unable to start conversation",
          toErrorMessage(error)
        )
      });
    }
  });

  app.event("app_mention", async ({ body, client, event }) => {
    const mentionEvent = event as SlackMessageEvent;

    if (!mentionEvent.user || !mentionEvent.text) {
      return;
    }

    const requestKey = stableKey([
      "event",
      String((body as { event_id?: string }).event_id ?? mentionEvent.ts)
    ]);
    const inserted = await store.recordProcessedRequest(
      requestKey,
      "slack-event",
      {
        type: "app_mention",
        channelId: mentionEvent.channel,
        ts: mentionEvent.ts
      }
    );

    if (!inserted) {
      return;
    }

    try {
      requireRequestAccess(await store.getSlackUser(mentionEvent.user));

      const teamId = extractTeamId(body as Record<string, unknown>);
      const threadTs = mentionEvent.thread_ts ?? mentionEvent.ts;
      const target = buildConversationTarget(mentionEvent.channel, threadTs);
      const cleanedText = stripAppMention(mentionEvent.text);
      const existingSession = await store.getConversationSession(
        teamId,
        mentionEvent.channel,
        threadTs
      );

      if (existingSession && existingSession.ownerSlackUserId !== mentionEvent.user) {
        await postConversationMessage(client, target, {
          text: `This conversation belongs to <@${existingSession.ownerSlackUserId}>. Start a new ${config.SLACK_COMMAND_NAME} or mention the bot in a new thread to create your own plan.`,
          blocks: buildConversationMessageBlocks(
            "Conversation already in progress",
            `This thread belongs to <@${existingSession.ownerSlackUserId}>. Start a new ${config.SLACK_COMMAND_NAME} or mention the bot in a new thread to create your own plan.`
          )
        });
        return;
      }

      if (cleanedText.length === 0) {
        const prompt = existingSession
          ? "Reply in this thread with what you want to change, validate, or submit."
          : "Reply in this thread with a release request in English or Japanese. I’ll ask follow-up questions if needed and then show the final asc commands before any write action runs.";

        await saveConversationSession({
          existingSession,
          teamId,
          channelId: mentionEvent.channel,
          threadTs,
          ownerSlackUserId: mentionEvent.user,
          messages: [
            ...(existingSession?.messages ?? []),
            {
              role: "assistant",
              content: prompt
            }
          ],
          lastNormalizedRequest: existingSession?.lastNormalizedRequest ?? null,
          lastExecutionPlan: existingSession?.lastExecutionPlan ?? null
        });

        await postConversationMessage(client, target, {
          text: prompt,
          blocks: buildConversationMessageBlocks("Conversation started", prompt)
        });
        return;
      }

      await processConversationTurn({
        client,
        teamId,
        channelId: mentionEvent.channel,
        threadTs,
        userId: mentionEvent.user,
        text: cleanedText,
        allowCreate: true,
        resetSession: false,
        respondOnOwnershipConflict: true
      });
    } catch (error) {
      const message = toErrorMessage(error);
      await postConversationMessage(
        client,
        buildConversationTarget(
          mentionEvent.channel,
          mentionEvent.thread_ts ?? mentionEvent.ts
        ),
        {
          text: message,
          blocks: buildErrorBlocks("Unable to handle mention", message)
        }
      );
    }
  });

  app.event("message", async ({ body, client, event }) => {
    const messageEvent = event as SlackMessageEvent;

    if (
      !messageEvent.user ||
      !messageEvent.text ||
      messageEvent.subtype ||
      messageEvent.bot_id
    ) {
      return;
    }

    const channelType = inferChannelType(messageEvent);
    if (channelType !== "im" && /<@[A-Z0-9]+>/i.test(messageEvent.text)) {
      return;
    }

    const requestKey = stableKey([
      "event",
      String((body as { event_id?: string }).event_id ?? messageEvent.ts)
    ]);
    const inserted = await store.recordProcessedRequest(
      requestKey,
      "slack-event",
      {
        type: "message",
        channelId: messageEvent.channel,
        ts: messageEvent.ts
      }
    );

    if (!inserted) {
      return;
    }

    try {
      const teamId = extractTeamId(body as Record<string, unknown>);

      if (channelType === "im") {
        await processConversationTurn({
          client,
          teamId,
          channelId: messageEvent.channel,
          userId: messageEvent.user,
          text: messageEvent.text,
          allowCreate: true,
          resetSession: false,
          respondOnOwnershipConflict: true
        });
        return;
      }

      if (!messageEvent.thread_ts) {
        return;
      }

      const session = await store.getConversationSession(
        teamId,
        messageEvent.channel,
        messageEvent.thread_ts
      );

      if (!session || session.ownerSlackUserId !== messageEvent.user) {
        return;
      }

      await processConversationTurn({
        client,
        teamId,
        channelId: messageEvent.channel,
        threadTs: messageEvent.thread_ts,
        userId: messageEvent.user,
        text: messageEvent.text,
        allowCreate: false,
        resetSession: false,
        respondOnOwnershipConflict: false
      });
    } catch (error) {
      console.error("Unable to process message event", error);
    }
  });

  app.action(CONFIRM_ACTION_ID, async ({ ack, action, body, respond }) => {
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
          const queuedLabel =
            approval.actionType === "cancel_review_submission"
              ? "Cancellation queued"
              : approval.actionType === "run_asc_commands"
                ? "ASC command plan queued"
                : "Release queued";
          const revalidationCopy =
            approval.actionType === "cancel_review_submission"
              ? "The worker will revalidate the current submission and then run:"
              : approval.actionType === "run_asc_commands"
                ? "The worker will revalidate the captured preflight variables and then run:"
                : "The worker will revalidate the exact build and then run:";

      await respond({
        replace_original: true,
        text: `${queuedLabel}. ${approval.executionPlan.executionSummary}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${queuedLabel}*\n${approval.executionPlan.executionSummary}`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${revalidationCopy}\n\`\`\`${approval.executionPlan.previewCommands.at(-1) ?? "asc submit create"}\`\`\``
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

  app.action(CANCEL_ACTION_ID, async ({ ack, action, body, respond }) => {
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
