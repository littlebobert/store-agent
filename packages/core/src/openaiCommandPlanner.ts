import OpenAI from "openai";
import { z } from "zod";

import {
  type ConversationMessage,
  type DraftCommandInput,
  finalizeNormalizedActionRequest,
  finalizeNormalizedActionRequestFromRawCommand,
  plannerOutputSchema,
  type PlannerOutput,
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

const localizedReleaseNotesSchema = z.object({
  translations: z.record(z.string(), z.string().trim().min(1))
});
export type OpenAiLocalizedReleaseNotes = z.infer<
  typeof localizedReleaseNotesSchema
>;

const conversationPlannerResponseSchema = z
  .object({
    assistantReply: z.string().trim().min(1),
    readyToResolve: z.boolean().default(false),
    plannerOutput: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((value, ctx) => {
    if (value.readyToResolve && !value.plannerOutput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plannerOutput"],
        message: "plannerOutput is required when readyToResolve is true."
      });
    }
  });

export interface OpenAiConversationTurnResult {
  assistantReply: string;
  normalizedRequest: NormalizedActionRequest | null;
}

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

function extractFirstMeaningfulString(
  value: unknown,
  preferredKeys: string[] = []
): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractFirstMeaningfulString(item, preferredKeys);
      if (extracted) {
        return extracted;
      }
    }

    return undefined;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;

    for (const key of preferredKeys) {
      if (key in record) {
        const extracted = extractFirstMeaningfulString(record[key], preferredKeys);
        if (extracted) {
          return extracted;
        }
      }
    }

    for (const key of Object.keys(record).sort()) {
      const extracted = extractFirstMeaningfulString(record[key], preferredKeys);
      if (extracted) {
        return extracted;
      }
    }
  }

  return undefined;
}

function looksLikeVersionString(value: string): boolean {
  return /^\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?$/.test(value);
}

function extractVersionFromText(text: string): string | undefined {
  const patterns = [
    /\bversion\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /\bver(?:sion)?\.?\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /バージョン\s*(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)/i,
    /\bv\s*(\d+(?:\.\d+){1,}(?:[-+._a-zA-Z0-9]*)?)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && looksLikeVersionString(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizePlannerOutput(
  value: unknown,
  input: {
    rawCommand: string;
    versionOverride?: string;
    previousRequest?: Partial<NormalizedActionRequest> | null;
  }
): unknown {
  const normalized = replaceNullsWithUndefined(value);

  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return normalized;
  }

  const record = { ...(normalized as Record<string, unknown>) };
  const version = record.version;
  const releaseNotes = record.releaseNotes;

  if (input.previousRequest) {
    for (const key of [
      "provider",
      "actionType",
      "appAlias",
      "version",
      "buildStrategy",
      "explicitBuildId",
      "releaseMode",
      "releaseNotes",
      "notes",
      "commandLanguage"
    ] satisfies Array<keyof NormalizedActionRequest>) {
      if (record[key] === undefined && input.previousRequest[key] !== undefined) {
        record[key] = input.previousRequest[key];
      }
    }
  }

  if (typeof version !== "string") {
    const extractedVersion = extractFirstMeaningfulString(version, [
      "value",
      "version",
      "marketingVersion",
      "appStoreVersion",
      "releaseVersion",
      "targetVersion"
    ]);

    if (extractedVersion && looksLikeVersionString(extractedVersion)) {
      record.version = extractedVersion;
    }
  }

  if (typeof record.version !== "string" && input.versionOverride) {
    record.version = input.versionOverride;
  }

  if (typeof record.version !== "string") {
    const extractedVersionFromCommand = extractVersionFromText(input.rawCommand);
    if (extractedVersionFromCommand) {
      record.version = extractedVersionFromCommand;
    }
  }

  if (typeof releaseNotes !== "string") {
    const extractedReleaseNotes = extractFirstMeaningfulString(releaseNotes, [
      "source",
      "text",
      "value",
      "default",
      "base",
      "original",
      "en-US",
      "en_US",
      "en",
      "ja"
    ]);

    if (extractedReleaseNotes) {
      record.releaseNotes = extractedReleaseNotes;
    }
  }

  if (typeof record.releaseNotes !== "string" && typeof record.notes !== "string") {
    const extractedNotes = extractFirstMeaningfulString(record.notes, [
      "source",
      "text",
      "value",
      "default",
      "base",
      "original"
    ]);

    if (extractedNotes) {
      record.notes = extractedNotes;
    }
  }

  if (
    typeof record.releaseNotes !== "string" &&
    record.actionType === "prepare_release_for_review" &&
    typeof record.notes === "string"
  ) {
    record.releaseNotes = record.notes;
  }

  return record;
}

function buildConversationRawCommand(messages: ConversationMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n");
}

function parsePlannerOutput(
  content: string,
  input: {
    rawCommand: string;
    versionOverride?: string;
    previousRequest?: Partial<NormalizedActionRequest> | null;
  }
): PlannerOutput {
  return plannerOutputSchema.parse(
    normalizePlannerOutput(JSON.parse(extractJsonPayload(content)), input)
  );
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
            "Supported actionType values: resolve_latest_build, validate_release, prepare_release_for_review, submit_release_for_review, release_status.",
            "Supported releaseMode values: manual_after_review, automatic_on_approval.",
            "Supported buildStrategy values: latest_for_version, explicit_build_id.",
            "Infer commandLanguage as english, japanese, mixed, or unknown.",
            "If a required field is missing or the request is ambiguous, set needsClarification to true and include clarificationQuestion.",
            "When the user says 'version 1.2.3', 'v1.2.3', or 'version 1.2.3 on iOS', always put 1.2.3 in the version field.",
            "Extract releaseNotes when the user provides release notes or 'what's new' text.",
            "releaseNotes must always be a single plain string with the operator's source text.",
            "Never return releaseNotes as an object, array, locale map, or translated bundle.",
            "If the user asks to translate release notes, keep releaseNotes as the single source string and let downstream tooling handle localization.",
            "Use prepare_release_for_review when the user wants to create or ensure an App Store version, apply release notes/localizations or metadata, attach a build, and submit in one workflow.",
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

    const parsed = parsePlannerOutput(content, {
      rawCommand: draft.rawCommand,
      versionOverride: draft.versionOverride
    });

    return finalizeNormalizedActionRequest(draft, parsed);
  }

  public async planConversationTurn(input: {
    messages: ConversationMessage[];
    previousRequest?: NormalizedActionRequest | null;
  }): Promise<OpenAiConversationTurnResult> {
    const rawCommand = buildConversationRawCommand(input.messages);
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You help operators plan mobile release workflows in a multi-turn Slack conversation.",
            "Use the conversation history plus any previous structured request to carry forward unchanged details unless the user changes them.",
            "Supported providers: apple, google-play.",
            "Supported actionType values: resolve_latest_build, validate_release, prepare_release_for_review, submit_release_for_review, release_status.",
            "Supported releaseMode values: manual_after_review, automatic_on_approval.",
            "Supported buildStrategy values: latest_for_version, explicit_build_id.",
            "When the user says 'version 1.2.3', 'v1.2.3', or 'version 1.2.3 on iOS', always put 1.2.3 in the version field.",
            "Extract releaseNotes when the user provides release notes or 'what's new' text.",
            "releaseNotes must always be a single plain string with the operator's source text.",
            "Never return releaseNotes as an object, array, locale map, or translated bundle.",
            "If the user asks to translate release notes, keep releaseNotes as the single source string and let downstream tooling handle localization.",
            "If you still need information, set readyToResolve to false and assistantReply to one concise follow-up question.",
            "If you have enough information, set readyToResolve to true, assistantReply to a short confirmation sentence, and plannerOutput to a complete self-contained request object.",
            "When readyToResolve is true, plannerOutput must include every required field needed for the selected action, not just changed fields.",
            "Never invent app IDs or build IDs.",
            "Infer commandLanguage as english, japanese, mixed, or unknown.",
            "Omit unknown optional fields instead of returning null.",
            "Return JSON only with keys assistantReply, readyToResolve, and plannerOutput when applicable."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            previousRequest: input.previousRequest ?? null,
            conversationMessages: input.messages
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a conversation plan.");
    }

    const parsed = conversationPlannerResponseSchema.parse(
      JSON.parse(extractJsonPayload(content))
    );

    if (!parsed.readyToResolve || !parsed.plannerOutput) {
      return {
        assistantReply: parsed.assistantReply,
        normalizedRequest: null
      };
    }

    const plannerOutput = parsePlannerOutput(JSON.stringify(parsed.plannerOutput), {
      rawCommand,
      previousRequest: input.previousRequest
    });

    return {
      assistantReply: parsed.assistantReply,
      normalizedRequest: finalizeNormalizedActionRequestFromRawCommand(
        rawCommand,
        plannerOutput
      )
    };
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

export class OpenAiReleaseNotesTranslator {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  public async translateReleaseNotes(input: {
    baseNotes: string;
    locales: string[];
  }): Promise<Record<string, string>> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You localize App Store release notes for multiple locales.",
            "Return JSON only with key translations.",
            "translations must be an object keyed by the exact locale codes provided by the user.",
            "Every requested locale must be present exactly once.",
            "Keep the tone concise, release-note appropriate, and faithful to the original.",
            "Do not add Markdown, bullets, or extra commentary unless they already exist in the source text.",
            "If the source text is already appropriate for a locale, you may keep it with light localization."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            baseNotes: input.baseNotes,
            locales: input.locales
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return localized release notes.");
    }

    const parsed = localizedReleaseNotesSchema.parse(
      JSON.parse(extractJsonPayload(content))
    );

    for (const locale of input.locales) {
      if (!parsed.translations[locale]) {
        throw new Error(
          `OpenAI did not provide release notes for locale ${locale}.`
        );
      }
    }

    return parsed.translations;
  }
}
