import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type NormalizedActionRequest,
  OpenAiReleaseNotesTranslator,
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
  openAiApiKey?: string;
  openAiModel?: string;
}

interface AscCommandResult {
  args: string[];
  displayCommand: string;
  json: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

interface ScalarEntry {
  path: string;
  value: string;
}

interface LocalizedReleaseNotes {
  [locale: string]: string;
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

function toScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function collectScalarEntries(
  value: unknown,
  path = "",
  depth = 0
): ScalarEntry[] {
  if (depth > 4) {
    return [];
  }

  const scalar = toScalarString(value);
  if (scalar !== null) {
    return [{ path: path || "value", value: scalar }];
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).flatMap((item, index) =>
      collectScalarEntries(item, `${path}[${index}]`, depth + 1)
    );
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const entries: ScalarEntry[] = [];
  for (const [key, item] of Object.entries(record)) {
    entries.push(
      ...collectScalarEntries(item, path ? `${path}.${key}` : key, depth + 1)
    );
    if (entries.length >= 40) {
      break;
    }
  }

  return entries;
}

function looksLikeVersion(value: string): boolean {
  return /^\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?$/.test(value);
}

function humanizePath(path: string): string {
  const label = path.split(".").at(-1) ?? path;
  return label
    .replace(/\[\d+\]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function findEntry(
  entries: ScalarEntry[],
  pathRegex: RegExp,
  predicate?: (entry: ScalarEntry) => boolean
): ScalarEntry | undefined {
  return entries.find(
    (entry) =>
      pathRegex.test(entry.path) &&
      (predicate ? predicate(entry) : true)
  );
}

function summarizeStatusPayload(payload: Record<string, unknown>): string[] {
  const explicitSummary =
    findFirstString(payload, ["summary", "message", "status"]) ?? null;
  const entries = collectScalarEntries(payload);
  const versionEntries = entries.filter((entry) => looksLikeVersion(entry.value));

  const liveVersion = findEntry(
    versionEntries,
    /(live|ready.*sale|current.*version|released.*version|appStore.*version)/i
  );
  const latestVersion = findEntry(
    versionEntries,
    /(latest.*version|next.*version|version$|display.*version)/i
  );
  const reviewStatus = findEntry(
    entries,
    /(review.*status|review.*state)/i,
    (entry) => !looksLikeVersion(entry.value)
  );
  const releaseStatus = findEntry(
    entries,
    /(release.*status|appStore.*state|status|state)/i,
    (entry) => !looksLikeVersion(entry.value)
  );

  const lines: string[] = [];

  if (liveVersion) {
    lines.push(`Live version: ${liveVersion.value}`);
  }

  if (
    latestVersion &&
    latestVersion.value !== liveVersion?.value
  ) {
    lines.push(`Latest version: ${latestVersion.value}`);
  }

  if (releaseStatus) {
    lines.push(`${humanizePath(releaseStatus.path)}: ${releaseStatus.value}`);
  }

  if (
    reviewStatus &&
    reviewStatus.path !== releaseStatus?.path &&
    reviewStatus.value !== releaseStatus?.value
  ) {
    lines.push(`${humanizePath(reviewStatus.path)}: ${reviewStatus.value}`);
  }

  if (lines.length === 0 && explicitSummary) {
    lines.push(explicitSummary);
  }

  if (lines.length === 0) {
    lines.push(
      ...entries
        .slice(0, 4)
        .map((entry) => `${humanizePath(entry.path)}: ${entry.value}`)
    );
  }

  if (lines.length === 0) {
    lines.push("Fetched App Store Connect status.");
  }

  return Array.from(new Set(lines));
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

function looksLikeLocaleCode(value: string): boolean {
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/i.test(value);
}

function extractLocales(payload: Record<string, unknown>): string[] {
  const entries = collectScalarEntries(payload, "", 0);
  const locales = entries
    .filter(
      (entry) =>
        looksLikeLocaleCode(entry.value) &&
        /(locale|language)/i.test(entry.path)
    )
    .map((entry) => entry.value);

  if (locales.length === 0) {
    const fallback = entries
      .map((entry) => entry.value)
      .filter((value) => looksLikeLocaleCode(value));
    locales.push(...fallback);
  }

  const uniqueLocales = Array.from(new Set(locales)).sort();
  return uniqueLocales.length > 0 ? uniqueLocales : ["en-US"];
}

function requireReleaseNotes(request: NormalizedActionRequest): string {
  if (!request.releaseNotes) {
    throw new Error(
      "This action requires release notes so the bot can prepare localized metadata."
    );
  }

  return request.releaseNotes;
}

function buildReleaseRunDisplayCommand(
  binaryPath: string,
  appId: string,
  version: string,
  buildId: string,
  mode: "dry-run" | "confirm"
): string {
  return buildDisplayCommand(binaryPath, [
    "release",
    "run",
    "--app",
    appId,
    "--version",
    version,
    "--build",
    buildId,
    "--metadata-dir",
    "<generated-metadata-dir>",
    mode === "dry-run" ? "--dry-run" : "--confirm",
    "--output",
    "json"
  ]);
}

function buildReleaseRunArgs(
  appId: string,
  version: string,
  buildId: string,
  metadataDir: string,
  mode: "dry-run" | "confirm"
): string[] {
  return [
    "release",
    "run",
    "--app",
    appId,
    "--version",
    version,
    "--build",
    buildId,
    "--metadata-dir",
    metadataDir,
    mode === "dry-run" ? "--dry-run" : "--confirm",
    "--output",
    "json"
  ];
}

async function withReleaseMetadataDir<T>(
  localizedReleaseNotes: LocalizedReleaseNotes,
  callback: (metadataDir: string) => Promise<T>
): Promise<T> {
  const metadataDir = await mkdtemp(join(tmpdir(), "store-agent-metadata-"));

  try {
    for (const [locale, notes] of Object.entries(localizedReleaseNotes)) {
      const localeDir = join(metadataDir, locale);
      await mkdir(localeDir, { recursive: true });
      await writeFile(join(localeDir, "release_notes.txt"), `${notes.trim()}\n`);
    }

    return await callback(metadataDir);
  } finally {
    await rm(metadataDir, { recursive: true, force: true });
  }
}

function summarizeReleaseRunPlan(input: {
  version: string;
  buildNumber: string;
  buildId: string;
  locales: string[];
}): string[] {
  return [
    `Will create or update App Store version ${input.version}.`,
    `Will attach build ${input.buildNumber} (${input.buildId}).`,
    `Will apply localized release notes for ${input.locales.length} locale(s).`,
    "Dry-run validation succeeded."
  ];
}

function extractLocalizedReleaseNotesFromPlan(
  plan: ProviderExecutionPlan
): LocalizedReleaseNotes {
  const record = asRecord(plan.rawProviderData.localizedReleaseNotes);
  if (!record) {
    throw new Error(
      "The execution plan is missing localized release notes for the release workflow."
    );
  }

  const localizedReleaseNotes: LocalizedReleaseNotes = {};
  for (const [locale, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim().length > 0) {
      localizedReleaseNotes[locale] = value;
    }
  }

  if (Object.keys(localizedReleaseNotes).length === 0) {
    throw new Error(
      "The execution plan contains no usable localized release notes."
    );
  }

  return localizedReleaseNotes;
}

function extractLocalesFromPlan(plan: ProviderExecutionPlan): string[] {
  const rawLocales = plan.rawProviderData.locales;
  if (!Array.isArray(rawLocales)) {
    return Object.keys(extractLocalizedReleaseNotesFromPlan(plan));
  }

  const locales = rawLocales.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return locales.length > 0
    ? locales
    : Object.keys(extractLocalizedReleaseNotesFromPlan(plan));
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
  if (
    (request.actionType !== "submit_release_for_review" &&
      request.actionType !== "prepare_release_for_review") ||
    !plan.buildId
  ) {
    throw new Error("This execution plan is not eligible for a write action.");
  }
}

export class AppleAscProvider implements ProviderAdapter {
  public readonly providerId = "apple" as const;

  private readonly binaryPath: string;

  private readonly env: NodeJS.ProcessEnv;

  private readonly releaseNotesTranslator?: OpenAiReleaseNotesTranslator;

  public constructor(options: AscRuntimeOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ASC_PATH ?? "asc";
    this.env = buildAscEnv(options.env ?? process.env);
    if (options.openAiApiKey) {
      this.releaseNotesTranslator = new OpenAiReleaseNotesTranslator({
        apiKey: options.openAiApiKey,
        model: options.openAiModel
      });
    }
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
      const statusSummary = summarizeStatusPayload(status.json);

      return providerExecutionPlanSchema.parse({
        provider: request.provider,
        actionType: request.actionType,
        appAlias: request.appAlias,
        appId: app.appId,
        buildStrategy: request.buildStrategy,
        previewCommands: [status.displayCommand],
        validationSummary: statusSummary,
        executionSummary: `Status for ${request.appAlias}: ${statusSummary[0]}`,
        rawProviderData: {
          status: status.json
        }
      });
    }

    if (request.actionType === "prepare_release_for_review") {
      const version = requireVersion(request);
      const releaseNotes = requireReleaseNotes(request);

      if (!this.releaseNotesTranslator) {
        throw new Error(
          "OpenAI release-note translation is not configured for release preparation."
        );
      }

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

      const localizations = await readProcessOutput(
        this.binaryPath,
        ["localizations", "list", "--app", app.appId, "--output", "json"],
        this.env
      );
      const locales = extractLocales(localizations.json);
      const localizedReleaseNotes =
        await this.releaseNotesTranslator.translateReleaseNotes({
          baseNotes: releaseNotes,
          locales
        });

      const dryRun = await withReleaseMetadataDir(
        localizedReleaseNotes,
        async (metadataDir) =>
          readProcessOutput(
            this.binaryPath,
            buildReleaseRunArgs(app.appId, version, buildId, metadataDir, "dry-run"),
            this.env
          )
      );

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
        previewCommands: [
          latestBuild.displayCommand,
          localizations.displayCommand,
          buildReleaseRunDisplayCommand(
            this.binaryPath,
            app.appId,
            version,
            buildId,
            "dry-run"
          ),
          buildReleaseRunDisplayCommand(
            this.binaryPath,
            app.appId,
            version,
            buildId,
            "confirm"
          )
        ],
        validationSummary: summarizeReleaseRunPlan({
          version,
          buildNumber,
          buildId,
          locales
        }),
        executionSummary: `Prepared release workflow for version ${version} build ${buildNumber} across ${locales.length} locale(s).`,
        rawProviderData: {
          latestBuild: latestBuild.json,
          localizations: localizations.json,
          releaseRunDryRun: dryRun.json,
          localizedReleaseNotes,
          locales,
          releaseNotes
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
    if (context.request.actionType === "prepare_release_for_review") {
      const version = requireVersion(context.request);
      const buildId = context.previousPlan.buildId;
      const buildNumber =
        context.previousPlan.buildNumber ?? context.previousPlan.buildId ?? "unknown";

      if (!buildId) {
        throw new Error("The previous execution plan is missing a build ID.");
      }

      const localizedReleaseNotes =
        extractLocalizedReleaseNotesFromPlan(context.previousPlan);
      const locales = extractLocalesFromPlan(context.previousPlan);

      const dryRun = await withReleaseMetadataDir(
        localizedReleaseNotes,
        async (metadataDir) =>
          readProcessOutput(
            this.binaryPath,
            buildReleaseRunArgs(
              context.app.appId,
              version,
              buildId,
              metadataDir,
              "dry-run"
            ),
            this.env
          )
      );

      return providerExecutionPlanSchema.parse({
        ...context.previousPlan,
        appId: context.app.appId,
        version,
        buildId,
        buildNumber,
        previewCommands: [
          ...context.previousPlan.previewCommands.slice(0, 2),
          buildReleaseRunDisplayCommand(
            this.binaryPath,
            context.app.appId,
            version,
            buildId,
            "dry-run"
          ),
          buildReleaseRunDisplayCommand(
            this.binaryPath,
            context.app.appId,
            version,
            buildId,
            "confirm"
          )
        ],
        validationSummary: summarizeReleaseRunPlan({
          version,
          buildNumber,
          buildId,
          locales
        }),
        executionSummary: `Prepared release workflow for version ${version} build ${buildNumber} across ${locales.length} locale(s).`,
        rawProviderData: {
          ...context.previousPlan.rawProviderData,
          releaseRunDryRun: dryRun.json
        }
      });
    }

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

    if (context.request.actionType === "prepare_release_for_review") {
      const localizedReleaseNotes = extractLocalizedReleaseNotesFromPlan(
        context.plan
      );

      const releaseRun = await withReleaseMetadataDir(
        localizedReleaseNotes,
        async (metadataDir) =>
          readProcessOutput(
            this.binaryPath,
            buildReleaseRunArgs(
              context.app.appId,
              version,
              buildId,
              metadataDir,
              "confirm"
            ),
            this.env
          )
      );

      return providerExecutionResultSchema.parse({
        ok: true,
        summary: `Created or updated version ${version}, localized the release notes, attached build ${context.plan.buildNumber ?? buildId}, and submitted it for App Store review.`,
        rawResult: releaseRun.json
      });
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
