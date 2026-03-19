import OpenAI from "openai";
import { z } from "zod";

import {
  type DraftCommandInput,
  finalizeNormalizedActionRequest,
  plannerOutputSchema,
  type NormalizedActionRequest
} from "./actions.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

export interface OpenAiCommandPlannerOptions {
  apiKey: string;
  model?: string;
}

const statusSummarySchema = z.object({
  shortSummary: z.string().trim().min(1),
  detailLines: z.array(z.string().trim().min(1)).min(1).max(8)
});
export type OpenAiStatusSummary = z.infer<typeof statusSummarySchema>;

const errorSummarySchema = z.object({
  shortSummary: z.string().trim().min(1),
  detailLines: z.array(z.string().trim().min(1)).min(1).max(5)
});
export type OpenAiErrorSummary = z.infer<typeof errorSummarySchema>;

function extractJsonPayload(content: string): string {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const genericFence = content.match(/```\s*([\s\S]*?)```/i);
  if (genericFence?.[1]) {
    return genericFence[1].trim();
  }

  return content.trim();
}

function replaceNullsWithUndefined(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceNullsWithUndefined(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceNullsWithUndefined(item)
      ])
    );
  }

  return value;
}

function truncateForPrompt(content: string, maxChars = 50000): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n[truncated]`;
}

export class OpenAiCommandPlanner {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  public async parseCommand(
    draft: DraftCommandInput
  ): Promise<NormalizedActionRequest> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You turn English or Japanese mobile release requests into a strict JSON object.",
            "Never invent app IDs or build IDs.",
            "Supported providers: apple, google-play.",
            "Supported actionType values: resolve_latest_build, validate_release, submit_release_for_review, release_status.",
            "Supported releaseMode values: manual_after_review, automatic_on_approval.",
            "Supported buildStrategy values: latest_for_version, explicit_build_id.",
            "Infer commandLanguage as english, japanese, mixed, or unknown.",
            "If a required field is missing or the request is ambiguous, set needsClarification to true and include clarificationQuestion.",
            "Use submit_release_for_review for requests about sending a build to Apple review or public App Store release.",
            "Use manual_after_review unless the user explicitly asks for auto release when approved.",
            "Omit unknown optional fields instead of returning null.",
            "Output JSON only."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            rawCommand: draft.rawCommand,
            appAliasOverride: draft.appAliasOverride ?? null,
            versionOverride: draft.versionOverride ?? null,
            releaseModeOverride: draft.releaseModeOverride ?? null,
            notesOverride: draft.notesOverride ?? null
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a command plan.");
    }

    const parsed = plannerOutputSchema.parse(
      replaceNullsWithUndefined(JSON.parse(extractJsonPayload(content)))
    );

    return finalizeNormalizedActionRequest(draft, parsed);
  }
}

export class OpenAiStatusSummarizer {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  public async summarizeStatus(input: {
    appAlias: string;
    provider: string;
    statusPayload: Record<string, unknown>;
  }): Promise<OpenAiStatusSummary> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You summarize App Store Connect or store release status payloads for Slack.",
            "Use only facts present in the JSON payload.",
            "Be concise and operator-friendly.",
            "Prefer mentioning the currently live version, latest version, release state, and review state when present.",
            "If the payload is ambiguous or missing key information, say so plainly instead of guessing.",
            "Return JSON only with keys shortSummary and detailLines.",
            "shortSummary must be a single sentence under 140 characters.",
            "detailLines must contain 2-6 short factual lines."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            appAlias: input.appAlias,
            provider: input.provider,
            statusPayloadJson: truncateForPrompt(
              JSON.stringify(input.statusPayload)
            )
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a status summary.");
    }

    return statusSummarySchema.parse(JSON.parse(extractJsonPayload(content)));
  }
}

export class OpenAiErrorSummarizer {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  public async summarizePlanningError(input: {
    rawCommand: string;
    rawError: string;
  }): Promise<OpenAiErrorSummary> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You summarize release-planning failures for Slack operators.",
            "Turn noisy technical errors into a concise, factual explanation.",
            "Do not invent causes not supported by the error.",
            "Do not include stack traces, raw JSON, or shell command output unless absolutely necessary.",
            "Prefer actionable next steps like checking app alias, version, App Store Connect credentials, or asc output.",
            "Return JSON only with keys shortSummary and detailLines.",
            "shortSummary must be a single sentence under 140 characters.",
            "detailLines must contain 2-5 short lines."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            rawCommand: input.rawCommand,
            rawError: truncateForPrompt(input.rawError, 25000)
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return an error summary.");
    }

    return errorSummarySchema.parse(JSON.parse(extractJsonPayload(content)));
  }
}
