import { spawn } from "node:child_process";

import {
  type NormalizedActionRequest,
  providerExecutionPlanSchema,
  providerExecutionResultSchema,
  type ProviderExecutionPlan
} from "@store-agent/core";

import type {
  ExecuteRequestContext,
  ProviderAdapter,
  ResolveRequestContext,
  RevalidateRequestContext
} from "./provider.js";

interface AscRuntimeOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
}

interface AscCommandResult {
  args: string[];
  displayCommand: string;
  json: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/=-]+$/.test(arg)) {
    return arg;
  }

  return JSON.stringify(arg);
}

function buildDisplayCommand(binaryPath: string, args: string[]): string {
  return [binaryPath, ...args.map((arg) => quoteArg(arg))].join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPath(
  value: Record<string, unknown>,
  path: string
): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current !== null && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, value);
}

function findFirstString(
  value: Record<string, unknown>,
  candidatePaths: string[]
): string | undefined {
  for (const path of candidatePaths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function extractBuildDetails(payload: Record<string, unknown>): {
  buildId: string;
  buildNumber: string;
} {
  const buildId =
    findFirstString(payload, [
      "id",
      "data.id",
      "data.buildId",
      "data.attributes.id"
    ]) ?? "";
  const buildNumber =
    findFirstString(payload, [
      "buildNumber",
      "version",
      "data.attributes.version",
      "data.attributes.buildNumber",
      "data.version"
    ]) ?? "";

  if (!buildId || !buildNumber) {
    throw new Error(
      "Unable to resolve build details from asc output. Inspect rawProviderData in the approval record."
    );
  }

  return { buildId, buildNumber };
}

function summarizeValidation(payload: Record<string, unknown>): string[] {
  const record = asRecord(payload);
  if (!record) {
    return ["Validation completed. Inspect raw validation output for details."];
  }

  const errors = readPath(record, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((item) => JSON.stringify(item));
  }

  const warnings = readPath(record, "warnings");
  if (Array.isArray(warnings) && warnings.length > 0) {
    return warnings.map((item) => JSON.stringify(item));
  }

  const summary =
    findFirstString(record, ["summary", "message", "status"]) ??
    "Validation completed without structured warnings.";

  return [summary];
}

async function readProcessOutput(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<AscCommandResult> {
  const child = spawn(binaryPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(
      `asc command failed (${buildDisplayCommand(binaryPath, args)}): ${stderr || stdout}`
    );
  }

  const trimmed = stdout.trim();
  const parsed: unknown = trimmed.length > 0 ? JSON.parse(trimmed) : {};
  const json = asRecord(parsed) ?? { data: parsed };

  return {
    args,
    displayCommand: buildDisplayCommand(binaryPath, args),
    json,
    stdout,
    stderr
  };
}

function buildAscEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ASC_BYPASS_KEYCHAIN: baseEnv.ASC_BYPASS_KEYCHAIN ?? "1",
    ASC_NO_UPDATE: baseEnv.ASC_NO_UPDATE ?? "1"
  };
}

function requireVersion(request: NormalizedActionRequest): string {
  if (!request.version) {
    throw new Error("This action requires a marketing version.");
  }

  return request.version;
}

function ensureWriteAction(
  request: NormalizedActionRequest,
  plan: ProviderExecutionPlan
): void {
  if (request.actionType !== "submit_release_for_review" || !plan.buildId) {
    throw new Error("This execution plan is not eligible for a write action.");
  }
}

export class AppleAscProvider implements ProviderAdapter {
  public readonly providerId = "apple" as const;

  private readonly binaryPath: string;

  private readonly env: NodeJS.ProcessEnv;

  public constructor(options: AscRuntimeOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ASC_PATH ?? "asc";
    this.env = buildAscEnv(options.env ?? process.env);
  }

  public async resolve(
    context: ResolveRequestContext
  ): Promise<ProviderExecutionPlan> {
    const { app, request } = context;

    if (request.actionType === "release_status") {
      const status = await readProcessOutput(
        this.binaryPath,
        ["status", "--app", app.appId, "--output", "json"],
        this.env
      );

      return providerExecutionPlanSchema.parse({
        provider: request.provider,
        actionType: request.actionType,
        appAlias: request.appAlias,
        appId: app.appId,
        buildStrategy: request.buildStrategy,
        previewCommands: [status.displayCommand],
        validationSummary: summarizeValidation(status.json),
        executionSummary: `Fetched App Store Connect status for ${request.appAlias}.`,
        rawProviderData: {
          status: status.json
        }
      });
    }

    const version = requireVersion(request);
    const latestBuild = await readProcessOutput(
      this.binaryPath,
      [
        "builds",
        "latest",
        "--app",
        app.appId,
        "--version",
        version,
        "--platform",
        app.platform,
        "--output",
        "json"
      ],
      this.env
    );
    const { buildId, buildNumber } = extractBuildDetails(latestBuild.json);

    const validation = await readProcessOutput(
      this.binaryPath,
      ["validate", "--app", app.appId, "--version", version, "--output", "json"],
      this.env
    );

    const previewCommands = [latestBuild.displayCommand, validation.displayCommand];

    if (request.actionType === "submit_release_for_review") {
      previewCommands.push(
        buildDisplayCommand(this.binaryPath, [
          "submit",
          "create",
          "--app",
          app.appId,
          "--version",
          version,
          "--build",
          buildId,
          "--confirm",
          "--output",
          "json"
        ])
      );
    }

    return providerExecutionPlanSchema.parse({
      provider: request.provider,
      actionType: request.actionType,
      appAlias: request.appAlias,
      appId: app.appId,
      version,
      releaseMode: request.releaseMode,
      buildStrategy: request.buildStrategy,
      buildId,
      buildNumber,
      previewCommands,
      validationSummary: summarizeValidation(validation.json),
      executionSummary:
        request.actionType === "resolve_latest_build"
          ? `Resolved latest build ${buildNumber} (${buildId}) for version ${version}.`
          : request.actionType === "validate_release"
            ? `Validated version ${version} with build ${buildNumber} (${buildId}).`
            : `Prepared App Store submission for version ${version} build ${buildNumber} (${buildId}).`,
      rawProviderData: {
        latestBuild: latestBuild.json,
        validation: validation.json
      }
    });
  }

  public async revalidate(
    context: RevalidateRequestContext
  ): Promise<ProviderExecutionPlan> {
    const latestPlan = await this.resolve({
      app: context.app,
      request: context.request
    });

    if (
      context.previousPlan.actionType === "submit_release_for_review" &&
      latestPlan.buildId !== context.previousPlan.buildId
    ) {
      throw new Error(
        `The latest build changed from ${context.previousPlan.buildId} to ${latestPlan.buildId}. Request a fresh approval before submitting.`
      );
    }

    return latestPlan;
  }

  public async execute(context: ExecuteRequestContext) {
    const version = requireVersion(context.request);
    ensureWriteAction(context.request, context.plan);
    const buildId = context.plan.buildId;

    if (!buildId) {
      throw new Error("Execution plan is missing a build ID.");
    }

    const submit = await readProcessOutput(
      this.binaryPath,
      [
        "submit",
        "create",
        "--app",
        context.app.appId,
        "--version",
        version,
        "--build",
        buildId,
        "--confirm",
        "--output",
        "json"
      ],
      this.env
    );

    return providerExecutionResultSchema.parse({
      ok: true,
      summary: `Submitted version ${version} build ${context.plan.buildNumber ?? context.plan.buildId} to App Store review.`,
      rawResult: submit.json
    });
  }
}
