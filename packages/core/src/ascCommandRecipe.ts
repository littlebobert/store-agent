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
            "You generate exact asc CLI command recipes for Apple App Store Connect workflows.",
            "Use the provided ASC docs as the source of truth.",
            "Return JSON only.",
            "Each step args array must exclude the binary name; the runtime will prepend 'asc'.",
            "Do not use shell syntax like &&, ;, pipes, redirects, backticks, or command substitution.",
            "Use {{variableName}} placeholders for runtime variables.",
            "Available base placeholders are {{appId}}, {{appAlias}}, {{appReference}}, {{platform}}, and {{version}} when provided.",
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

    return ascCommandRecipeSchema.parse(JSON.parse(extractJsonPayload(content)));
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
