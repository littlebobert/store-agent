import OpenAI from "openai";
import { z } from "zod";

import {
  type ConversationMessage,
  type DraftCommandInput,
  finalizePlannedActionRequest,
  finalizePlannedActionRequestFromRawCommand,
  plannerOutputSchema,
  type PlannerOutput,
  type PlannedActionRequest,
  type NormalizedActionRequest
} from "./actions.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_REASONING_EFFORT = "high";
export const DEFAULT_OPENAI_SERVICE_TIER = "priority";

export type OpenAiReasoningEffort = "low" | "medium" | "high";
export type OpenAiServiceTier =
  | "auto"
  | "default"
  | "flex"
  | "scale"
  | "priority";

export interface OpenAiCommandPlannerOptions {
  apiKey: string;
  model?: string;
  reasoningEffort?: OpenAiReasoningEffort;
  serviceTier?: OpenAiServiceTier;
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
  conversationContextReply?: string;
  plannedRequest: PlannedActionRequest | null;
}

const ACTION_ROUTING_GUIDE = [
  "Action routing catalog:",
  "release_to_app_store = final customer publish only. It moves an already prepared and approved App Store version from Pending Developer Release to live on the App Store. It does not create/update metadata, upload release notes, attach builds, validate, or submit for review. Use this for phrasing like 'release dotsu for iOS 1.4.3', 'go live', 'ready to release', 'approved', 'already has release notes', 'metadata is ready', or 'pending developer release'. Never ask for release notes for this action.",
  "prepare_release_for_review = pre-review preparation. It creates or updates an App Store version, uploads actual source release-note text, localizes metadata, attaches a TestFlight build, validates, and submits for App Store review. Use this only when the operator wants preparation/submission work before Apple approval. This action requires the actual release-note text; statements like 'release notes already exist' are not release-note text.",
  "update_draft_release = update an existing draft without submitting for review. Use when the operator wants to attach a build or upload actual release-note text to a draft version.",
  "create_draft_release = create an empty draft version only. Use when the operator explicitly asks for a draft/empty version without release notes, build attachment, validation, or review submission.",
  "submit_release_for_review = submit an already prepared version to Apple review. Use when metadata/build are already prepared and the operator asks to submit for review, not to publish to customers.",
  "release_status = read-only status lookup. Use for questions about current/live/latest/review/release status.",
  "list_app_aliases = local alias lookup. Use for listing or discovering configured app aliases.",
  "run_asc_commands = other App Store Connect workflows and read-only queries that do not fit the named actions.",
  "Routing examples: 'release dotsu for iOS 1.4.3' -> release_to_app_store; 'it already has release notes and is ready to release' -> release_to_app_store; 'prepare dotsu 1.4.3 with these release notes: ...' -> prepare_release_for_review; 'submit the prepared 1.4.3 build for review' -> submit_release_for_review; 'create an empty draft for 1.4.3' -> create_draft_release."
];

function withOpenAiRequestOptions<T extends object>(
  params: T,
  options: {
    reasoningEffort?: OpenAiReasoningEffort;
    serviceTier?: OpenAiServiceTier;
  }
): T {
  const record = params as Record<string, unknown>;
  if (options.reasoningEffort) {
    record.reasoning_effort = options.reasoningEffort;
  }
  if (options.serviceTier) {
    record.service_tier = options.serviceTier;
  }

  return params;
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

function looksLikeDraftReleaseRequest(text: string): boolean {
  const normalized = text.trim();
  if (!extractVersionFromText(normalized)) {
    return false;
  }

  const mentionsCreateOrPrepare =
    /\b(create|prepare)\b.*\b(release|review|submission)\b|\bnew release\b|\bcreate\b.*\bversion\b|リリース.*(作成|準備)|バージョン.*作成/i.test(
      normalized
    );
  const mentionsDraftOrEmpty =
    /\bdraft\b|\bempty\b|\bwithout\b.*\b(release notes?|build)\b|\bno\b.*\b(release notes?|build)\b|下書き/i.test(
      normalized
    );

  return (
    mentionsCreateOrPrepare &&
    mentionsDraftOrEmpty &&
    !/\bprepare\b|準備/i.test(normalized)
  );
}

function inferActionTypeFromCommandText(
  text: string
): PlannerOutput["actionType"] | undefined {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (
    /\b(list|show|what\s+are|available)\b.*\b(app\s+)?aliases?\b|\b(app\s+)?aliases?\b.*\b(list|show|available)\b/i.test(
      normalized
    )
  ) {
    return "list_app_aliases";
  }

  const hasExplicitVersion = Boolean(extractVersionFromText(normalized));
  const isCancellationRequest =
    /\b(cancel|withdraw|stop)\b.*\b(review|submission|release)\b|審査.*(キャンセル|取り消|取消)|提出.*(キャンセル|取り消|取消)/i.test(
      normalized
    );

  if (isCancellationRequest && hasExplicitVersion) {
    return "cancel_review_submission";
  }

  if (
    /\brelease status\b|\breview status\b|\bcurrent release\b|\blatest release\b|\blive version\b|\bcurrent version\b|\bstatus of\b.*\b(release|review|version)\b|リリース.*状況|審査.*状況|現在.*バージョン|ステータス/i.test(
      normalized
    )
  ) {
    return "release_status";
  }

  const mentionsReleaseNotes =
    /\brelease notes?\b|what'?s new|リリースノート/i.test(normalized);
  const mentionsLocalization =
    /\btranslate\b|\btranslation\b|\blocali[sz](?:e|ed|ation)?\b|翻訳|ローカライズ/i.test(
      normalized
    );
  const mentionsCreateOrPrepare =
    /\b(create|prepare)\b.*\b(release|review|submission)\b|\bnew release\b|\bcreate\b.*\bversion\b|リリース.*(作成|準備)|バージョン.*作成/i.test(
      normalized
    );
  const mentionsAttachBuild =
    /\battach\b.*\b(testflight|build)\b|TestFlight.*(添付|追加)|ビルド.*(添付|追加)/i.test(
      normalized
    );
  const mentionsSubmitForReview =
    /\bsubmit\b.*\b(review|apple|app store)\b|審査に提出|Apple.*提出/i.test(
      normalized
    );

  const mentionsForReview = /\bfor\s+review\b|審査(に)?提出|審査申請/i.test(
    normalized
  );

  const mentionsPostApprovalCustomerRelease =
    /\bpending\s+developer\s+release\b|\brelease\s+(?:it\s+)?(?:to|on)\s+(?:the\s+)?app\s+store\b|\bgo\s+live\b|\brelease\s+to\s+customers\b|\balready\s+approved\b|\bapproved\b.*\brelease\b|\bready\s+for\s+customers\b|\breview\s+passed\b.*\brelease\b|\bデベロッパによるリリース\b|\b配信\b.*\bリリース\b/i.test(
      normalized
    );

  if (
    hasExplicitVersion &&
    mentionsPostApprovalCustomerRelease &&
    !mentionsReleaseNotes &&
    !mentionsLocalization
  ) {
    return "release_to_app_store";
  }

  if (
    hasExplicitVersion &&
    /\brelease\b/i.test(normalized) &&
    !mentionsCreateOrPrepare &&
    !mentionsSubmitForReview &&
    !mentionsReleaseNotes &&
    !mentionsLocalization &&
    !mentionsForReview &&
    !/\btestflight\b|\bmetadata\b|\blocali[sz]/i.test(normalized)
  ) {
    return "release_to_app_store";
  }

  if (
    hasExplicitVersion &&
    mentionsAttachBuild &&
    mentionsReleaseNotes &&
    !mentionsSubmitForReview &&
    /\bdraft\b|\bfill(?:\s+it)?\s+in\b|\bupdate\b|\buse\s+the\s+draft\b/i.test(
      normalized
    )
  ) {
    return "update_draft_release";
  }

  if (
    hasExplicitVersion &&
    mentionsAttachBuild &&
    !mentionsCreateOrPrepare &&
    !mentionsSubmitForReview &&
    !mentionsReleaseNotes &&
    !mentionsLocalization
  ) {
    return "run_asc_commands";
  }

  if (
    hasExplicitVersion &&
    (
      mentionsCreateOrPrepare ||
      (mentionsSubmitForReview &&
        (mentionsReleaseNotes || mentionsLocalization || mentionsAttachBuild)) ||
      ((mentionsReleaseNotes || mentionsLocalization) &&
        /\b(release|review|submit|version|testflight|build|apple|app store)\b|リリース|審査|バージョン|TestFlight|ビルド/i.test(
          normalized
        ))
    )
  ) {
    return "prepare_release_for_review";
  }

  if (mentionsSubmitForReview && hasExplicitVersion) {
    return "submit_release_for_review";
  }

  return undefined;
}

function extractVersionFromText(text: string): string | undefined {
  const patterns = [
    /\bversion\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /\bver(?:sion)?\.?\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /バージョン\s*(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)/i,
    /\bv\s*(\d+(?:\.\d+){1,}(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /\b(?:for|on)\s+iOS\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i,
    /\biOS\s+(\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?)\b/i
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

function normalizeAppReference(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/^[\s"'`([{<]+/, "")
    .replace(/[\s"'`)\]}>.,:;!?]+$/, "");

  return trimmed.length > 0 ? trimmed : undefined;
}

function extractLikelyAppReferenceFromText(text: string): string | undefined {
  const bundleIdMatch = text.match(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}\b/i);
  if (bundleIdMatch?.[0]) {
    return bundleIdMatch[0];
  }

  const appStoreIdMatch = text.match(/\b\d{8,12}\b/);
  if (appStoreIdMatch?.[0]) {
    return appStoreIdMatch[0];
  }

  const platformAdjacentMatch = text.match(
    /\b([a-z][a-z0-9_-]{1,40})\s+(?:ios|iphone|ipad|android|testflight|app\s*store|google\s*play)\b/i
  );
  const candidate = platformAdjacentMatch?.[1];
  const ignoredTokens = new Set([
    "latest",
    "required",
    "generic",
    "draft",
    "release",
    "version",
    "testflight",
    "app",
    "store",
    "google",
    "play"
  ]);

  if (candidate && !ignoredTokens.has(candidate.toLowerCase())) {
    return candidate;
  }

  return undefined;
}

function requestedGenericReleaseNotes(text: string): boolean {
  return /\b(make\s+up|generic|placeholder|default)\b.*\brelease notes?\b|\brelease notes?\b.*\b(make\s+up|generic|placeholder|default)\b/i.test(
    text
  );
}

function normalizePlannerOutput(
  value: unknown,
  input: {
    rawCommand: string;
    latestUserMessage?: string;
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
  const appReference = record.appReference ?? record.appAlias;
  const version = record.version;
  const releaseNotes = record.releaseNotes;

  if (input.previousRequest) {
    for (const key of [
      "provider",
      "appReference",
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

  const inferredActionType =
    inferActionTypeFromCommandText(input.latestUserMessage ?? "") ??
    inferActionTypeFromCommandText(input.rawCommand);
  if (inferredActionType && record.actionType !== "create_draft_release") {
    record.actionType = inferredActionType;
  } else if (
    record.actionType === undefined &&
    input.previousRequest?.actionType
  ) {
    record.actionType = input.previousRequest.actionType;
  } else if (record.actionType === undefined) {
    record.actionType = "run_asc_commands";
  }

  if (typeof appReference === "string" && typeof record.appReference !== "string") {
    record.appReference = appReference;
  }

  if (
    record.actionType === "list_app_aliases" &&
    typeof record.appReference !== "string"
  ) {
    record.appReference = "all";
  }

  if (
    record.actionType !== "list_app_aliases" &&
    typeof record.appReference !== "string"
  ) {
    const extractedAppReference =
      extractLikelyAppReferenceFromText(input.latestUserMessage ?? "") ??
      extractLikelyAppReferenceFromText(input.rawCommand);
    if (extractedAppReference) {
      record.appReference = extractedAppReference;
    }
  }

  if (typeof appReference !== "string") {
    const extractedAppReference = extractFirstMeaningfulString(appReference, [
      "appReference",
      "appAlias",
      "alias",
      "app",
      "identifier",
      "bundleId",
      "packageName",
      "value",
      "name"
    ]);

    if (extractedAppReference) {
      record.appReference =
        normalizeAppReference(extractedAppReference) ?? extractedAppReference;
    }
  }

  if (typeof record.appReference === "string") {
    const normalizedReference = normalizeAppReference(record.appReference);
    if (normalizedReference) {
      record.appReference = normalizedReference;
    }
  }

  if (
    typeof record.appReference !== "string" &&
    typeof input.previousRequest?.appAlias === "string"
  ) {
    record.appReference = input.previousRequest.appAlias;
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

  if (
    record.actionType === "prepare_release_for_review" &&
    typeof record.releaseNotes !== "string" &&
    looksLikeDraftReleaseRequest(input.latestUserMessage ?? input.rawCommand)
  ) {
    record.actionType = "create_draft_release";
  }

  if (
    (record.actionType === "prepare_release_for_review" ||
      record.actionType === "update_draft_release") &&
    typeof record.releaseNotes !== "string" &&
    requestedGenericReleaseNotes(input.rawCommand)
  ) {
    record.releaseNotes = "Bug fixes and performance improvements.";
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
    latestUserMessage?: string;
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

  private readonly reasoningEffort?: OpenAiReasoningEffort;

  private readonly serviceTier?: OpenAiServiceTier;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.reasoningEffort =
      options.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    this.serviceTier = options.serviceTier ?? DEFAULT_OPENAI_SERVICE_TIER;
  }

  public async parseCommand(
    draft: DraftCommandInput
  ): Promise<PlannedActionRequest> {
    const completion = await this.client.chat.completions.create(
      withOpenAiRequestOptions({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You turn English or Japanese App Store Connect operator requests into a strict JSON object.",
            "Never invent app IDs or build IDs.",
            "Supported providers: apple, google-play.",
            "Supported actionType values: run_asc_commands, list_app_aliases, update_draft_release, create_draft_release, prepare_release_for_review, submit_release_for_review, release_to_app_store, cancel_review_submission, release_status.",
            "Supported releaseMode values: manual_after_review, automatic_on_approval.",
            "Supported buildStrategy values: latest_for_version, explicit_build_id.",
            "Infer commandLanguage as english, japanese, mixed, or unknown.",
            "If a required field is missing or the request is ambiguous, set needsClarification to true and include clarificationQuestion.",
            "Valid requests include read-only questions about ratings, reviews, analytics, crashes, feedback, finance, metadata, builds, and release status, not only release submissions.",
            "Use list_app_aliases when the operator asks to list, show, or discover configured app aliases. This is a local configuration lookup, not an asc command.",
            "For list_app_aliases, infer provider as apple for iOS/App Store aliases and google-play for Android/Google Play aliases. Put any account/team/filter text in appReference; if there is no filter, set appReference to all.",
            "appReference must be the app identifier the operator used, such as the configured app alias, bundle ID, or package name.",
            "If the operator provides a short app-like token such as dotsu, treat that token as appReference and do not ask for an exact alias or bundle ID.",
            "If the operator provides an App Store numeric app ID, use that numeric ID as appReference.",
            "If the user writes something like 'dotsu (jp.tech.kotoba.app)', prefer the alias and set appReference to 'dotsu'.",
            "If the user only provides a bundle ID or package name, set appReference to that identifier string.",
            "When the user says 'version 1.2.3', 'v1.2.3', or 'version 1.2.3 on iOS', always put 1.2.3 in the version field.",
            ...ACTION_ROUTING_GUIDE,
            "Use cancel_review_submission when the operator explicitly wants to cancel or withdraw a review submission.",
            "If the operator only wants to attach the latest TestFlight build to a version, use run_asc_commands, not prepare_release_for_review.",
            "For prepare_release_for_review, keep releaseNotes as one plain source string. Do not turn it into a localized object or array.",
            "For prepare_release_for_review, do not ask the user to list locales when they ask for required locales; the provider can discover locales and translate the source release notes automatically.",
            "If the operator asks you to make up generic release notes, use a generic source string such as 'Bug fixes and performance improvements.' and do not ask for release notes text.",
            "If the operator includes extra context like release notes or desired behavior, preserve it in notes unless it belongs in releaseNotes.",
            "Do not reject analytics or ratings questions just because they are not release workflows.",
            "Use manual_after_review unless the user explicitly asks for auto release when approved.",
            "Omit unknown optional fields instead of returning null.",
            "Output JSON only."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            rawCommand: draft.rawCommand,
            appReferenceOverride: draft.appReferenceOverride ?? null,
            versionOverride: draft.versionOverride ?? null,
            releaseModeOverride: draft.releaseModeOverride ?? null,
            notesOverride: draft.notesOverride ?? null
          })
        }
      ]
    }, {
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier
    })
    );

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a command plan.");
    }

    const parsed = parsePlannerOutput(content, {
      rawCommand: draft.rawCommand,
      latestUserMessage: draft.rawCommand,
      versionOverride: draft.versionOverride
    });

    return finalizePlannedActionRequest(draft, parsed);
  }

  public async planConversationTurn(input: {
    messages: ConversationMessage[];
    previousRequest?: NormalizedActionRequest | null;
  }): Promise<OpenAiConversationTurnResult> {
    const rawCommand = buildConversationRawCommand(input.messages);
    const latestUserMessage =
      [...input.messages]
        .reverse()
        .find((message) => message.role === "user")
        ?.content ?? rawCommand;
    const completion = await this.client.chat.completions.create(
      withOpenAiRequestOptions({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You help operators plan App Store Connect workflows and read-only queries in a multi-turn Slack conversation.",
            "Use the conversation history plus any previous structured request to carry forward unchanged details unless the user changes them.",
            "Supported providers: apple, google-play.",
            "Supported actionType values: run_asc_commands, list_app_aliases, update_draft_release, create_draft_release, prepare_release_for_review, submit_release_for_review, release_to_app_store, cancel_review_submission, release_status.",
            "Supported releaseMode values: manual_after_review, automatic_on_approval.",
            "Supported buildStrategy values: latest_for_version, explicit_build_id.",
            "Valid requests include read-only questions about ratings, reviews, analytics, crashes, feedback, finance, metadata, builds, and release status, not only release submissions.",
            "Use list_app_aliases when the operator asks to list, show, or discover configured app aliases. This is a local configuration lookup, not an asc command.",
            "For list_app_aliases, infer provider as apple for iOS/App Store aliases and google-play for Android/Google Play aliases. Put any account/team/filter text in appReference; if there is no filter, set appReference to all.",
            "appReference must be the app identifier the operator used, such as the configured app alias, bundle ID, or package name.",
            "If the operator provides a short app-like token such as dotsu, treat that token as appReference and do not ask for an exact alias or bundle ID.",
            "If the operator provides an App Store numeric app ID, use that numeric ID as appReference.",
            "If the user writes something like 'dotsu (jp.tech.kotoba.app)', prefer the alias and set appReference to 'dotsu'.",
            "If the user only provides a bundle ID or package name, set appReference to that identifier string.",
            "When a reply supplies one missing detail, combine it with the earlier request instead of re-asking for details already present in the conversation.",
            "When the user says 'version 1.2.3', 'v1.2.3', or 'version 1.2.3 on iOS', always put 1.2.3 in the version field.",
            ...ACTION_ROUTING_GUIDE,
            "Use cancel_review_submission when the operator explicitly wants to cancel or withdraw a review submission.",
            "If the operator only wants to attach the latest TestFlight build to a version, use run_asc_commands, not prepare_release_for_review.",
            "For prepare_release_for_review, keep releaseNotes as one plain source string. Do not turn it into a localized object or array.",
            "For prepare_release_for_review, do not ask the user to list locales when they ask for required locales; the provider can discover locales and translate the source release notes automatically.",
            "If the operator asks you to make up generic release notes, use a generic source string such as 'Bug fixes and performance improvements.' and do not ask for release notes text.",
            "If the operator includes extra context like release notes or desired behavior, preserve it in notes unless it belongs in releaseNotes.",
            "Treat direct requests phrased like 'can you ...' as instructions, not as ambiguity.",
            "Do not reject analytics or ratings questions just because they are not release workflows.",
            "If you still need information, set readyToResolve to false and assistantReply to one concise follow-up question.",
            "When readyToResolve is false, include plannerOutput with any known fields from the conversation so the next turn can carry them forward.",
            "If all required details are already present, do not ask the user to confirm your interpretation. Set readyToResolve to true.",
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
    }, {
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier
    })
    );

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a conversation plan.");
    }

    const parsed = conversationPlannerResponseSchema.parse(
      JSON.parse(extractJsonPayload(content))
    );

    if (!parsed.readyToResolve || !parsed.plannerOutput) {
      const conversationContextReply = parsed.plannerOutput
        ? [
            parsed.assistantReply,
            `Known structured request: ${JSON.stringify(parsed.plannerOutput)}`
          ].join("\n")
        : undefined;

      return {
        assistantReply: parsed.assistantReply,
        conversationContextReply,
        plannedRequest: null
      };
    }

    const plannerOutput = parsePlannerOutput(JSON.stringify(parsed.plannerOutput), {
      rawCommand,
      latestUserMessage,
      previousRequest: input.previousRequest
    });

    return {
      assistantReply: parsed.assistantReply,
      plannedRequest: finalizePlannedActionRequestFromRawCommand(
        rawCommand,
        plannerOutput
      )
    };
  }
}

export class OpenAiStatusSummarizer {
  private readonly client: OpenAI;

  private readonly model: string;

  private readonly reasoningEffort?: OpenAiReasoningEffort;

  private readonly serviceTier?: OpenAiServiceTier;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.reasoningEffort =
      options.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    this.serviceTier = options.serviceTier ?? DEFAULT_OPENAI_SERVICE_TIER;
  }

  public async summarizeStatus(input: {
    appAlias: string;
    provider: string;
    statusPayload: Record<string, unknown>;
  }): Promise<OpenAiStatusSummary> {
    const completion = await this.client.chat.completions.create(
      withOpenAiRequestOptions({
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
    }, {
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier
    })
    );

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

  private readonly reasoningEffort?: OpenAiReasoningEffort;

  private readonly serviceTier?: OpenAiServiceTier;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.reasoningEffort =
      options.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    this.serviceTier = options.serviceTier ?? DEFAULT_OPENAI_SERVICE_TIER;
  }

  public async summarizePlanningError(input: {
    rawCommand: string;
    rawError: string;
  }): Promise<OpenAiErrorSummary> {
    const completion = await this.client.chat.completions.create(
      withOpenAiRequestOptions({
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
    }, {
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier
    })
    );

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

  private readonly reasoningEffort?: OpenAiReasoningEffort;

  private readonly serviceTier?: OpenAiServiceTier;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.reasoningEffort =
      options.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    this.serviceTier = options.serviceTier ?? DEFAULT_OPENAI_SERVICE_TIER;
  }

  public async translateReleaseNotes(input: {
    baseNotes: string;
    locales: string[];
  }): Promise<Record<string, string>> {
    const completion = await this.client.chat.completions.create(
      withOpenAiRequestOptions({
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
    }, {
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier
    })
    );

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
