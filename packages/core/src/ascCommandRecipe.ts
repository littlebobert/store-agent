import OpenAI from "openai";
import { z } from "zod";

const captureNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const ascCommandCaptureSchema = z.object({
  name: captureNameSchema,
  jsonPath: z.string().trim().min(1)
});
export type AscCommandCapture = z.infer<typeof ascCommandCaptureSchema>;

export const ascCommandStepSchema = z.object({
  purpose: z.string().trim().min(1).max(200),
  args: z.array(z.string().trim().min(1)).min(1).max(40),
  captures: z.array(ascCommandCaptureSchema).max(10).default([])
});
export type AscCommandStep = z.infer<typeof ascCommandStepSchema>;

export const ascCommandRecipeSchema = z
  .object({
    intentSummary: z.string().trim().min(1).max(200),
    executionSummary: z.string().trim().min(1).max(300),
    validationSummary: z.array(z.string().trim().min(1)).max(8).default([]),
    requiresConfirmation: z.boolean(),
    steps: z.array(ascCommandStepSchema).max(12).default([]),
    needsClarification: z.boolean().default(false),
    clarificationQuestion: z.string().trim().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (value.needsClarification && !value.clarificationQuestion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clarificationQuestion"],
        message: "clarificationQuestion is required when needsClarification is true."
      });
    }

    if (!value.needsClarification && value.steps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "steps are required unless clarification is needed."
      });
    }
  });
export type AscCommandRecipe = z.infer<typeof ascCommandRecipeSchema>;

const commandOutputSummarySchema = z.object({
  shortSummary: z.string().trim().min(1),
  detailLines: z.array(z.string().trim().min(1)).min(1).max(6)
});
export type OpenAiCommandOutputSummary = z.infer<
  typeof commandOutputSummarySchema
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return [];
}

function normalizeCommandArgsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return tokenizeCommandString(value);
  }

  return [];
}

function tokenizeCommandString(command: string): string[] {
  const tokens = Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g)
  )
    .map((match) =>
      (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim()
    )
    .filter((token) => token.length > 0);

  return tokens[0] === "asc" ? tokens.slice(1) : tokens;
}

function deriveStepPurpose(args: string[], index: number): string {
  const commandPath = args.filter((arg) => !arg.startsWith("--")).slice(0, 3);
  if (commandPath.length > 0) {
    return `Run ${commandPath.join(" ")}`;
  }

  return `Run step ${index + 1}`;
}

function normalizeCapture(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const name =
    normalizeString(record.name) ?? normalizeString(record.variableName);
  const jsonPath =
    normalizeString(record.jsonPath) ??
    normalizeString(record.path) ??
    normalizeString(record.valuePath);
  if (!name || !jsonPath) {
    return null;
  }

  return { name, jsonPath };
}

function normalizeStep(value: unknown, index: number): Record<string, unknown> | null {
  if (typeof value === "string") {
    const args = tokenizeCommandString(value);
    if (args.length === 0) {
      return null;
    }

    return {
      purpose: deriveStepPurpose(args, index),
      args,
      captures: []
    };
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const args =
    normalizeCommandArgsValue(record.args).length > 0
      ? normalizeCommandArgsValue(record.args)
      : normalizeCommandArgsValue(record.command).length > 0
        ? normalizeCommandArgsValue(record.command)
        : normalizeCommandArgsValue(record.commandLine);
  const normalizedArgs = args[0] === "asc" ? args.slice(1) : args;
  if (normalizedArgs.length === 0) {
    return null;
  }

  const captures = Array.isArray(record.captures)
    ? record.captures
        .map((capture) => normalizeCapture(capture))
        .filter(
          (capture): capture is Record<string, unknown> => capture !== null
        )
    : [];

  return {
    purpose:
      normalizeString(record.purpose) ??
      normalizeString(record.description) ??
      deriveStepPurpose(normalizedArgs, index),
    args: normalizedArgs,
    captures
  };
}

function normalizeRecipeOutput(value: unknown): unknown {
  const record = asRecord(value) ?? {};
  const nestedPlan = asRecord(record.plan);
  const root = nestedPlan ?? record;

  const rawSteps = Array.isArray(root.steps)
    ? root.steps
    : Array.isArray(root.commands)
      ? root.commands
      : Array.isArray(root.recipe)
        ? root.recipe
        : [];
  const steps = rawSteps
    .map((step, index) => normalizeStep(step, index))
    .filter((step): step is Record<string, unknown> => step !== null);

  const intentSummary =
    normalizeString(root.intentSummary) ??
    normalizeString(root.intent) ??
    normalizeString(root.summary) ??
    (steps.length > 0 ? deriveStepPurpose(steps[0].args as string[], 0) : "Prepare asc command plan.");
  const executionSummary =
    normalizeString(root.executionSummary) ??
    normalizeString(root.summary) ??
    intentSummary;
  const validationSummary =
    normalizeStringArray(root.validationSummary).length > 0
      ? normalizeStringArray(root.validationSummary)
      : normalizeStringArray(root.validation);
  const clarificationQuestion =
    normalizeString(root.clarificationQuestion) ??
    normalizeString(root.question) ??
    normalizeString(root.followUpQuestion);

  return {
    intentSummary,
    executionSummary,
    validationSummary,
    requiresConfirmation:
      typeof root.requiresConfirmation === "boolean"
        ? root.requiresConfirmation
        : false,
    steps,
    needsClarification: root.needsClarification === true,
    clarificationQuestion
  };
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

function truncateForPrompt(content: string, maxChars = 50000): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n[truncated]`;
}

export interface OpenAiAscCommandRecipePlannerOptions {
  apiKey: string;
  model?: string;
}

export class OpenAiAscCommandRecipePlanner {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiAscCommandRecipePlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-5.4";
  }

  public async planRecipe(input: {
    rawCommand: string;
    appReference: string;
    appAlias: string;
    appId: string;
    platform: string;
    version?: string;
    notes?: string;
    ascDocs: string;
  }): Promise<AscCommandRecipe> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You generate exact asc CLI command recipes for Apple App Store Connect workflows and read-only operator questions.",
            "Use the provided ASC docs as the source of truth.",
            "Return JSON only.",
            "Each step args array must exclude the binary name; the runtime will prepend 'asc'.",
            "Do not use shell syntax like &&, ;, pipes, redirects, backticks, or command substitution.",
            "Use {{variableName}} placeholders for runtime variables.",
            "Available base placeholders are {{appId}}, {{appAlias}}, {{appReference}}, {{platform}}, and {{version}} when provided.",
            "Support read-only questions about ratings, reviews, analytics, crashes, feedback, finance, metadata, builds, and release status when the docs show matching commands.",
            "If the user asks for average rating or rating counts, prefer asc reviews ratings.",
            "If the user mentions a marketing version but the best matching asc command is app-level only, do not force a release workflow; use the app-level command and note that the result is app-level.",
            "Every step must include a short purpose string and an args array.",
            "Use the key steps for the ordered command list; do not rename it to commands or another key unless necessary.",
            "If a later step needs an ID from an earlier command, add a read-only discovery step first and capture it with captures[].",
            "Each capture must use a scalar JSON path like data.id, data[0].id, data.attributes.version, or included[0].id.",
            "Use canonical capture names when applicable: versionId, buildId, buildNumber, submissionId, appInfoId, localizationId, reviewDetailId.",
            "Add --output json for any step with captures and for any command whose output should be summarized back to the operator.",
            "Put all discovery and read-only steps before any mutating step.",
            "Set requiresConfirmation to true if any step mutates App Store Connect state; otherwise false.",
            "If the request is missing needed information, set needsClarification to true and ask one concise question.",
            "Do not invent unsupported flags or values.",
            "Be concise in intentSummary, executionSummary, and validationSummary."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            rawCommand: input.rawCommand,
            resolvedAppContext: {
              appReference: input.appReference,
              appAlias: input.appAlias,
              appId: input.appId,
              platform: input.platform,
              version: input.version ?? null,
              notes: input.notes ?? null
            },
            ascDocs: truncateForPrompt(input.ascDocs)
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return an asc command recipe.");
    }

    return ascCommandRecipeSchema.parse(
      normalizeRecipeOutput(JSON.parse(extractJsonPayload(content)))
    );
  }
}

export class OpenAiCommandOutputSummarizer {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiAscCommandRecipePlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-5.4";
  }

  public async summarizeOutputs(input: {
    rawCommand: string;
    outputs: Array<{
      purpose: string;
      command: string;
      stdout: string;
    }>;
  }): Promise<OpenAiCommandOutputSummary> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You summarize asc CLI command outputs for Slack operators.",
            "Use only facts in the provided command outputs.",
            "Prefer the final answer the operator cares about, not the mechanics.",
            "Call out ambiguity plainly instead of guessing.",
            "Return JSON only with shortSummary and detailLines.",
            "shortSummary must be one sentence under 140 characters.",
            "detailLines must contain 2-6 short factual lines."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            rawCommand: input.rawCommand,
            commandOutputs: input.outputs.map((output) => ({
              purpose: output.purpose,
              command: output.command,
              stdout: truncateForPrompt(output.stdout, 10000)
            }))
          })
        }
      ]
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("OpenAI did not return a command output summary.");
    }

    return commandOutputSummarySchema.parse(
      JSON.parse(extractJsonPayload(content))
    );
  }
}
