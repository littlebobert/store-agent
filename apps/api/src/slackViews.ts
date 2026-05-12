import type { KnownBlock, View } from "@slack/types";

import type {
  ModalMetadata,
  NormalizedActionRequest,
  ProviderExecutionPlan
} from "@store-agent/core";

export const REQUEST_MODAL_CALLBACK_ID = "asc_request_modal";
export const CONFIRM_ACTION_ID = "confirm_release_request";
export const CANCEL_ACTION_ID = "cancel_release_request";

interface ApprovalCardInput {
  approvalId: string;
  approvalToken: string;
  request: NormalizedActionRequest;
  plan: ProviderExecutionPlan;
  expiresAt: Date;
}

function truncateLines(lines: string[], maxLines = 4): string {
  return lines.slice(0, maxLines).join("\n");
}

function chunkLines(lines: string[], maxChars: number): string[] {
  const sourceLines = lines.length > 0 ? lines : ["(none)"];
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const line of sourceLines) {
    const nextLength =
      currentLength + (currentChunk.length > 0 ? 1 : 0) + line.length;
    if (currentChunk.length > 0 && nextLength > maxChars) {
      chunks.push(currentChunk.join("\n"));
      currentChunk = [line];
      currentLength = line.length;
      continue;
    }

    currentChunk.push(line);
    currentLength = nextLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n"));
  }

  return chunks;
}

function buildCommandBlocks(commands: string[]): KnownBlock[] {
  return chunkLines(commands, 2600).map((chunk, index) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        index === 0
          ? `*asc commands*\n\`\`\`${chunk}\`\`\``
          : `*asc commands (continued)*\n\`\`\`${chunk}\`\`\``
    }
  }));
}

function formatActionType(actionType: NormalizedActionRequest["actionType"]): string {
  return {
    run_asc_commands: "Run ASC command plan",
    resolve_latest_build: "Resolve latest build",
    validate_release: "Validate release",
    list_app_aliases: "List app aliases",
    update_draft_release: "Update draft release",
    create_draft_release: "Create draft release",
    prepare_release_for_review: "Prepare release for review",
    submit_release_for_review: "Submit release for review",
    release_to_app_store: "Release on the App Store",
    cancel_review_submission: "Cancel review submission",
    release_status: "Release status"
  }[actionType];
}

export function buildRequestModal(
  commandName: string,
  metadata: ModalMetadata,
  initialCommand: string
): View {
  return {
    type: "modal",
    callback_id: REQUEST_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Review release request"
    },
    submit: {
      type: "plain_text",
      text: "Plan request"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: JSON.stringify(metadata),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Use English or Japanese. The bot will use OpenAI to normalize the request behind ${commandName}, then show the exact asc plan before anything executes.`
        }
      },
      {
        type: "input",
        block_id: "raw_command",
        label: {
          type: "plain_text",
          text: "Release command"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: initialCommand,
          placeholder: {
            type: "plain_text",
            text: "submit the latest 1.3.7 TestFlight to Apple for public release"
          }
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "app_alias",
        label: {
          type: "plain_text",
          text: "App alias override"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "my-ios-app"
          }
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "version",
        label: {
          type: "plain_text",
          text: "Version override"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "1.3.7"
          }
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "release_mode",
        label: {
          type: "plain_text",
          text: "Release mode override"
        },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Let OpenAI infer this"
          },
          options: [
            {
              text: { type: "plain_text", text: "Manual after review" },
              value: "manual_after_review"
            },
            {
              text: { type: "plain_text", text: "Automatic on approval" },
              value: "automatic_on_approval"
            }
          ]
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "notes",
        label: {
          type: "plain_text",
          text: "Operator notes"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Optional notes for approvers or audit history"
          }
        }
      }
    ]
  };
}

export function buildApprovalBlocks(
  input: ApprovalCardInput
): KnownBlock[] {
  const buttonValue = JSON.stringify({
    approvalId: input.approvalId,
    approvalToken: input.approvalToken
  });
  const isCancellation = input.request.actionType === "cancel_review_submission";
  const isDynamicPlan = input.request.actionType === "run_asc_commands";
  const isCustomerRelease = input.request.actionType === "release_to_app_store";
  const isDraftRelease = input.request.actionType === "create_draft_release";
  const confirmButtonText = isCancellation
    ? "Confirm cancellation"
    : isDynamicPlan
      ? "Confirm commands"
      : isCustomerRelease
        ? "Confirm App Store release"
        : isDraftRelease
          ? "Confirm draft creation"
          : "Confirm release";
  const confirmTitle = isCancellation
    ? "Cancel submission?"
    : isDynamicPlan
      ? "Queue ASC commands?"
      : isCustomerRelease
        ? "Release to customers?"
        : isDraftRelease
          ? "Create draft release?"
          : "Submit release?";
  const confirmBody = isCancellation
    ? "This will queue the confirmed App Store Connect submission cancellation."
    : isDynamicPlan
      ? "This will queue the approved ASC command plan for execution."
      : isCustomerRelease
        ? "This will queue asc versions release so the approved version goes live on the App Store."
        : isDraftRelease
          ? "This will queue asc versions create. It will not attach a build, upload release notes, validate, or submit for review."
          : "This will queue the confirmed App Store Connect write action.";
  const confirmActionText = isCancellation
    ? "Cancel submission"
    : isDynamicPlan
      ? "Queue commands"
      : isCustomerRelease
        ? "Release"
        : isDraftRelease
          ? "Create draft"
          : "Submit";
  const summaryLabel = isCancellation
    ? "Submission summary"
    : isDynamicPlan
      ? "Plan summary"
      : "Validation summary";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval required*\n${input.plan.executionSummary}`
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Provider*\n${input.request.provider}`
        },
        {
          type: "mrkdwn",
          text: `*Action*\n${formatActionType(input.request.actionType)}`
        },
        {
          type: "mrkdwn",
          text: `*App alias*\n${input.request.appAlias}`
        },
        {
          type: "mrkdwn",
          text: `*Version*\n${input.request.version ?? "n/a"}`
        },
        {
          type: "mrkdwn",
          text: `*Build*\n${input.plan.buildNumber ?? "n/a"} (${input.plan.buildId ?? "n/a"})`
        },
        {
          type: "mrkdwn",
          text: `*Expires*\n${input.expiresAt.toISOString()}`
        }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${summaryLabel}*\n${truncateLines(input.plan.validationSummary)}`
      }
    },
    ...buildCommandBlocks(input.plan.previewCommands),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CONFIRM_ACTION_ID,
          style: "primary",
          text: {
            type: "plain_text",
            text: confirmButtonText
          },
          value: buttonValue,
          confirm: {
            title: {
              type: "plain_text",
              text: confirmTitle
            },
            text: {
              type: "mrkdwn",
              text: confirmBody
            },
            confirm: {
              type: "plain_text",
              text: confirmActionText
            },
            deny: {
              type: "plain_text",
              text: "Cancel"
            }
          }
        },
        {
          type: "button",
          action_id: CANCEL_ACTION_ID,
          text: {
            type: "plain_text",
            text: "Cancel"
          },
          value: buttonValue
        }
      ]
    }
  ];
}

export function buildReadOnlyBlocks(
  request: NormalizedActionRequest,
  plan: ProviderExecutionPlan
): KnownBlock[] {
  const summaryLabel =
    request.actionType === "release_status"
      ? "Status summary"
      : request.actionType === "cancel_review_submission"
        ? "Submission summary"
      : request.actionType === "run_asc_commands"
        ? "Result summary"
      : "Validation summary";
  const summaryLineCount =
    request.actionType === "release_status" ||
    request.actionType === "run_asc_commands"
      ? 8
      : 4;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${formatActionType(request.actionType)}*\n${plan.executionSummary}`
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*App alias*\n${request.appAlias}`
        },
        {
          type: "mrkdwn",
          text: `*Version*\n${request.version ?? "n/a"}`
        },
        {
          type: "mrkdwn",
          text: `*Build*\n${plan.buildNumber ?? "n/a"} (${plan.buildId ?? "n/a"})`
        },
        {
          type: "mrkdwn",
          text: `*Provider*\n${request.provider}`
        }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${summaryLabel}*\n${truncateLines(plan.validationSummary, summaryLineCount)}`
      }
    },
    ...buildCommandBlocks(plan.previewCommands)
  ];
}

export function buildErrorBlocks(
  title: string,
  message: string
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*\n${message}`
      }
    }
  ];
}

export function buildConversationMessageBlocks(
  title: string,
  message: string
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*\n${message}`
      }
    }
  ];
}
