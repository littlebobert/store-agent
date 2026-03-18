import OpenAI from "openai";

import {
  type DraftCommandInput,
  finalizeNormalizedActionRequest,
  plannerOutputSchema,
  type NormalizedActionRequest
} from "./actions.js";

export interface OpenAiCommandPlannerOptions {
  apiKey: string;
  model?: string;
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

export class OpenAiCommandPlanner {
  private readonly client: OpenAI;

  private readonly model: string;

  public constructor(options: OpenAiCommandPlannerOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-4.1-mini";
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
      JSON.parse(extractJsonPayload(content))
    );

    return finalizeNormalizedActionRequest(draft, parsed);
  }
}
