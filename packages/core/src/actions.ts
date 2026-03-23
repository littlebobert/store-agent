import { z } from "zod";

export const providerIdSchema = z.enum(["apple", "google-play"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const actionTypeSchema = z.enum([
  "resolve_latest_build",
  "validate_release",
  "prepare_release_for_review",
  "submit_release_for_review",
  "release_status"
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const releaseModeSchema = z.enum([
  "manual_after_review",
  "automatic_on_approval"
]);
export type ReleaseMode = z.infer<typeof releaseModeSchema>;

export const buildStrategySchema = z.enum([
  "latest_for_version",
  "explicit_build_id"
]);
export type BuildStrategy = z.infer<typeof buildStrategySchema>;

export const commandLanguageSchema = z.enum([
  "english",
  "japanese",
  "mixed",
  "unknown"
]);
export type CommandLanguage = z.infer<typeof commandLanguageSchema>;

export const conversationMessageRoleSchema = z.enum(["user", "assistant"]);
export type ConversationMessageRole = z.infer<
  typeof conversationMessageRoleSchema
>;

export const conversationMessageSchema = z.object({
  role: conversationMessageRoleSchema,
  content: z.string().trim().min(1).max(8000)
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

const plannerOutputObjectSchema = z.object({
  provider: providerIdSchema,
  actionType: actionTypeSchema,
  appAlias: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  buildStrategy: buildStrategySchema.default("latest_for_version"),
  explicitBuildId: z.string().trim().min(1).optional(),
  releaseMode: releaseModeSchema.default("manual_after_review"),
  releaseNotes: z.string().trim().min(1).max(4000).optional(),
  notes: z.string().trim().max(2000).optional(),
  commandLanguage: commandLanguageSchema.default("unknown"),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().trim().min(1).optional()
});

export const plannerOutputSchema = plannerOutputObjectSchema.superRefine(
  (value, ctx) => {
    if (
      value.actionType !== "release_status" &&
      value.buildStrategy === "latest_for_version" &&
      !value.version
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "Version is required for the selected action."
      });
    }

    if (
      value.buildStrategy === "explicit_build_id" &&
      !value.explicitBuildId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["explicitBuildId"],
        message: "Explicit build ID is required when buildStrategy is explicit."
      });
    }

    if (
      value.actionType === "prepare_release_for_review" &&
      !value.releaseNotes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["releaseNotes"],
        message:
          "Release notes are required when preparing a release workflow."
      });
    }
  }
);
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const draftCommandInputSchema = z.object({
  rawCommand: z.string().trim().min(1),
  appAliasOverride: z.string().trim().min(1).optional(),
  versionOverride: z.string().trim().min(1).optional(),
  releaseModeOverride: releaseModeSchema.optional(),
  notesOverride: z.string().trim().max(2000).optional()
});
export type DraftCommandInput = z.infer<typeof draftCommandInputSchema>;

export const normalizedActionRequestSchema = plannerOutputObjectSchema
  .omit({
    needsClarification: true,
    clarificationQuestion: true
  })
  .extend({
    appAlias: z.string().trim().min(1),
    rawCommand: z.string().trim().min(1)
  });
export type NormalizedActionRequest = z.infer<
  typeof normalizedActionRequestSchema
>;

export const providerExecutionPlanSchema = z.object({
  provider: providerIdSchema,
  actionType: actionTypeSchema,
  appAlias: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  version: z.string().trim().min(1).optional(),
  releaseMode: releaseModeSchema.optional(),
  buildStrategy: buildStrategySchema,
  buildId: z.string().trim().min(1).optional(),
  buildNumber: z.string().trim().min(1).optional(),
  previewCommands: z.array(z.string()).min(1),
  validationSummary: z.array(z.string()).default([]),
  executionSummary: z.string().trim().min(1),
  rawProviderData: z.record(z.string(), z.unknown()).default({})
});
export type ProviderExecutionPlan = z.infer<
  typeof providerExecutionPlanSchema
>;

export const providerExecutionResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string().trim().min(1),
  rawResult: z.record(z.string(), z.unknown()).optional()
});
export type ProviderExecutionResult = z.infer<
  typeof providerExecutionResultSchema
>;

export const serviceBusMessageSchema = z.object({
  approvalId: z.string().uuid()
});
export type ServiceBusMessage = z.infer<typeof serviceBusMessageSchema>;

export const modalMetadataSchema = z.object({
  channelId: z.string().trim().min(1),
  responseUrl: z.string().url(),
  requestUserId: z.string().trim().min(1),
  triggerRequestKey: z.string().trim().min(1)
});
export type ModalMetadata = z.infer<typeof modalMetadataSchema>;

export function mergePlannerOutputWithOverrides(
  draft: DraftCommandInput,
  plannerOutput: PlannerOutput
): PlannerOutput {
  return plannerOutputSchema.parse({
    ...plannerOutput,
    appAlias: draft.appAliasOverride ?? plannerOutput.appAlias,
    version: draft.versionOverride ?? plannerOutput.version,
    releaseMode: draft.releaseModeOverride ?? plannerOutput.releaseMode,
    notes: draft.notesOverride ?? plannerOutput.notes
  });
}

export function finalizeNormalizedActionRequest(
  draft: DraftCommandInput,
  plannerOutput: PlannerOutput
): NormalizedActionRequest {
  const merged = mergePlannerOutputWithOverrides(draft, plannerOutput);

  if (merged.needsClarification) {
    throw new Error(
      merged.clarificationQuestion ??
        "The command is ambiguous and needs clarification."
    );
  }

  return normalizedActionRequestSchema.parse({
    ...merged,
    rawCommand: draft.rawCommand
  });
}

export function finalizeNormalizedActionRequestFromRawCommand(
  rawCommand: string,
  plannerOutput: PlannerOutput
): NormalizedActionRequest {
  if (plannerOutput.needsClarification) {
    throw new Error(
      plannerOutput.clarificationQuestion ??
        "The command is ambiguous and needs clarification."
    );
  }

  return normalizedActionRequestSchema.parse({
    ...plannerOutput,
    rawCommand
  });
}

export function summarizeActionRequest(
  request: NormalizedActionRequest
): string {
  const action = {
    resolve_latest_build: "Resolve latest build",
    validate_release: "Validate release",
    prepare_release_for_review: "Prepare release for review",
    submit_release_for_review: "Submit release for review",
    release_status: "Check release status"
  }[request.actionType];

  const versionPart = request.version ? `version ${request.version}` : "latest";
  return `${action} for ${request.provider} app alias ${request.appAlias} (${versionPart})`;
}

export function isWriteAction(actionType: ActionType): boolean {
  return (
    actionType === "prepare_release_for_review" ||
    actionType === "submit_release_for_review"
  );
}
