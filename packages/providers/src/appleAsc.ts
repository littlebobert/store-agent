import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ascCommandRecipeSchema,
  type AscCommandRecipe,
  type AscCommandStep,
  type NormalizedActionRequest,
  OpenAiAscCommandRecipePlanner,
  OpenAiCommandOutputSummarizer,
  type OpenAiReasoningEffort,
  type OpenAiServiceTier,
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
  openAiReasoningEffort?: OpenAiReasoningEffort;
  openAiServiceTier?: OpenAiServiceTier;
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

interface AppStoreVersionRecord {
  versionId: string;
  versionString: string;
  appStoreState?: string;
}

interface AscTextResult {
  args: string[];
  displayCommand: string;
  stdout: string;
  stderr: string;
}

interface PlannedCommandOutput {
  purpose: string;
  command: string;
  stdout: string;
  json?: Record<string, unknown>;
}

interface CommandExecutionState {
  variables: Record<string, string>;
  outputs: PlannedCommandOutput[];
}

const ASC_DOC_HELP_PATHS = [
  ["apps"],
  ["builds"],
  ["builds", "latest"],
  ["versions"],
  ["versions", "list"],
  ["versions", "view"],
  ["versions", "get"],
  ["versions", "attach-build"],
  ["versions", "release"],
  ["localizations"],
  ["localizations", "list"],
  ["localizations", "upload"],
  ["review"],
  ["review", "submissions-list"],
  ["review", "submissions-get"],
  ["review", "submissions-create"],
  ["review", "items-add"],
  ["review", "submissions-submit"],
  ["review", "submissions-cancel"],
  ["validate"],
  ["testflight"],
  ["reviews"],
  ["reviews", "list"],
  ["reviews", "get"],
  ["reviews", "ratings"],
  ["reviews", "summarizations"],
  ["feedback"],
  ["crashes"],
  ["finance"],
  ["analytics"],
  ["users"]
] as const;

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

function extractAppStoreVersionRecords(
  payload: Record<string, unknown>
): AppStoreVersionRecord[] {
  const rawData = readPath(payload, "data");
  const singleRecord = asRecord(rawData);
  const records = Array.isArray(rawData)
    ? rawData
        .map((value) => asRecord(value))
        .filter((value): value is Record<string, unknown> => value !== null)
    : singleRecord
      ? [singleRecord]
      : [];

  return records
    .map<AppStoreVersionRecord | null>((record) => {
      const versionId = findFirstString(record, ["id"]) ?? "";
      if (!versionId) {
        return null;
      }

      const versionString =
        findFirstString(record, [
          "attributes.versionString",
          "attributes.version",
          "versionString",
          "version"
        ]) ?? "";
      const appStoreState = findFirstString(record, [
        "attributes.appStoreState",
        "attributes.appStoreVersionState",
        "attributes.state",
        "appStoreState",
        "state"
      ]);

      return appStoreState
        ? { versionId, versionString, appStoreState }
        : { versionId, versionString };
    })
    .filter((record): record is AppStoreVersionRecord => record !== null);
}

function findAppStoreVersionRecord(
  payload: Record<string, unknown>,
  version: string
): AppStoreVersionRecord | null {
  const records = extractAppStoreVersionRecords(payload);
  return (
    records.find((record) => record.versionString === version) ?? records[0] ?? null
  );
}

function extractAttachedBuildId(payload: Record<string, unknown>): string | null {
  const explicit =
    findFirstString(payload, [
      "data.relationships.build.data.id",
      "relationships.build.data.id",
      "data.relationships.builds.data.0.id",
      "relationships.builds.data.0.id"
    ]) ?? null;
  if (explicit) {
    return explicit;
  }

  const included = readPath(payload, "included");
  if (!Array.isArray(included)) {
    return null;
  }

  for (const item of included) {
    const record = asRecord(item);
    if (
      record?.type === "builds" &&
      typeof record.id === "string" &&
      record.id.length > 0
    ) {
      return record.id;
    }
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseCommandPath(args: string[]): string[] {
  const path: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      break;
    }
    path.push(arg);
  }

  return path;
}

function parseCatalogCommandPath(path: string): string[] {
  return path
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function commandPathKey(path: string[]): string {
  return path.join(" ");
}

function dedupeCommandPaths(paths: string[][]): string[][] {
  const seen = new Set<string>();
  const deduped: string[][] = [];

  for (const path of paths) {
    if (path.length === 0) {
      continue;
    }

    const key = commandPathKey(path);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(path);
  }

  return deduped;
}

function expandCommandPathsForContext(
  selectedPaths: string[][],
  availablePaths: readonly string[][]
): string[][] {
  const availableKeys = new Set(availablePaths.map((path) => commandPathKey(path)));
  const groups = new Set(selectedPaths.map((path) => path[0]).filter(Boolean));
  const expanded: string[][] = [];

  for (const path of selectedPaths) {
    for (let index = 1; index <= path.length; index += 1) {
      const prefix = path.slice(0, index);
      if (availableKeys.has(commandPathKey(prefix))) {
        expanded.push(prefix);
      }
    }
  }

  for (const path of availablePaths) {
    if (groups.has(path[0])) {
      expanded.push([...path]);
    }
  }

  return dedupeCommandPaths(expanded);
}

function suggestCommandPathsFromRequest(rawCommand: string): string[][] {
  const text = rawCommand.trim();
  if (text.length === 0) {
    return [];
  }

  const suggestions: string[][] = [];
  if (
    /\brating\b|\bratings\b|\bstars?\b|平均.*評価|評価.*平均/i.test(text)
  ) {
    suggestions.push(["reviews"], ["reviews", "ratings"]);
  }

  if (
    /\breview status\b|\brelease status\b|\bstatus of\b|\bcurrent release\b|リリース.*状況|ステータス/i.test(
      text
    )
  ) {
    suggestions.push(
      ["versions"],
      ["versions", "list"],
      ["versions", "view"],
      ["versions", "get"]
    );
  }

  if (
    /\breviews?\b|customer review|レビュー/i.test(text) &&
    !/\brating\b|\bratings\b|\bstars?\b/i.test(text)
  ) {
    suggestions.push(["reviews"], ["reviews", "list"], ["reviews", "summarizations"]);
  }

  if (/\bsubmit\b|\breview\b|審査/i.test(text)) {
    suggestions.push(
      ["builds"],
      ["builds", "latest"],
      ["review"],
      ["review", "submissions-create"],
      ["review", "items-add"],
      ["review", "submissions-submit"],
      ["versions"],
      ["versions", "list"],
      ["versions", "attach-build"]
    );
  }

  if (
    /\bpending\s+developer\s+release\b|\brelease\s+(?:to|on)\s+(?:the\s+)?app\s+store\b|\bgo\s+live\b|\balready\s+approved\b.*\brelease\b/i.test(
      text
    )
  ) {
    suggestions.push(
      ["versions"],
      ["versions", "list"],
      ["versions", "view"],
      ["versions", "get"],
      ["versions", "release"]
    );
  }

  if (
    /\brelease notes?\b|what'?s new|locali[sz]|metadata|リリースノート|ローカライズ|メタデータ/i.test(
      text
    )
  ) {
    suggestions.push(
      ["versions"],
      ["versions", "list"],
      ["versions", "view"],
      ["versions", "get"],
      ["localizations"],
      ["localizations", "list"],
      ["localizations", "upload"]
    );
  }

  return dedupeCommandPaths(suggestions);
}

function extractLongFlags(args: string[]): string[] {
  return args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.split("=")[0] ?? arg);
}

function isWriteCommandArgs(args: string[]): boolean {
  if (args.some((arg) => arg === "--confirm" || arg.startsWith("--confirm="))) {
    return true;
  }

  const path = parseCommandPath(args);
  const lastSegment = path.at(-1) ?? "";
  const writeVerbs = [
    "create",
    "update",
    "delete",
    "remove",
    "upload",
    "release",
    "cancel",
    "set",
    "submit",
    "attach-build",
    "add"
  ];
  if (
    writeVerbs.some(
      (verb) => lastSegment === verb || lastSegment.endsWith(`-${verb}`)
    )
  ) {
    return true;
  }

  return false;
}

function renderArgTemplate(
  arg: string,
  variables: Record<string, string>,
  strict: boolean
): string {
  return arg.replace(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (_match: string, name: string) => {
    const value = variables[name];
    if (value !== undefined) {
      return value;
    }

    if (strict) {
      throw new Error(`The command plan references an unknown variable "${name}".`);
    }

    return `<${name}>`;
    }
  );
}

function renderStepArgs(
  args: string[],
  variables: Record<string, string>,
  strict: boolean
): string[] {
  return args.map((arg) => renderArgTemplate(arg, variables, strict));
}

function buildGeneratedStepCommand(
  binaryPath: string,
  step: AscCommandStep,
  variables?: Record<string, string>
): string {
  return buildDisplayCommand(
    binaryPath,
    variables ? renderStepArgs(step.args, variables, false) : step.args
  );
}

function readJsonPath(value: unknown, path: string): unknown {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  return normalized.split(".").reduce<unknown>((current, segment) => {
    if (segment.length === 0) {
      return current;
    }

    if (/^\d+$/.test(segment)) {
      if (!Array.isArray(current)) {
        return undefined;
      }
      return current[Number(segment)];
    }

    if (current !== null && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, value);
}

function toCapturedVariableValue(value: unknown, name: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  throw new Error(
    `The command plan capture "${name}" did not resolve to a usable scalar value.`
  );
}

function extractCapturedVariables(
  step: AscCommandStep,
  json: Record<string, unknown>
): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const capture of step.captures) {
    const value = readJsonPath(json, capture.jsonPath);
    if (value === undefined) {
      throw new Error(
        `The command plan capture "${capture.name}" could not be found at ${capture.jsonPath}.`
      );
    }
    captured[capture.name] = toCapturedVariableValue(value, capture.name);
  }

  return captured;
}

function summarizeGenericPayload(payload: Record<string, unknown>): string[] {
  const explicitSummary =
    findFirstString(payload, ["summary", "message", "status"]) ?? null;
  const entries = collectScalarEntries(payload);

  const lines: string[] = [];
  if (explicitSummary) {
    lines.push(explicitSummary);
  }

  if (lines.length === 0) {
    lines.push(
      ...entries
        .slice(0, 4)
        .map((entry) => `${humanizePath(entry.path)}: ${entry.value}`)
    );
  }

  return lines.length > 0 ? Array.from(new Set(lines)) : ["Command completed."];
}

function extractHelpText(result: AscTextResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout.length > 0 && stderr.length > 0) {
    return `${stdout}\n${stderr}`;
  }

  return stdout.length > 0 ? stdout : stderr;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCommandRecipeFromPlan(plan: ProviderExecutionPlan): AscCommandRecipe {
  return ascCommandRecipeSchema.parse(plan.rawProviderData.commandRecipe);
}

function extractCapturedVariablesFromPlan(
  plan: ProviderExecutionPlan
): Record<string, string> {
  const value = plan.rawProviderData.capturedVariables;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0
      )
      .map(([key, item]) => [key, item.trim()])
  );
}

function extractStoredOutputsFromPlan(plan: ProviderExecutionPlan): PlannedCommandOutput[] {
  const value = plan.rawProviderData.commandOutputs;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.purpose !== "string" || typeof record.command !== "string") {
      return [];
    }

    return [
      {
        purpose: record.purpose,
        command: record.command,
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        json: asRecord(record.json) ?? undefined
      } satisfies PlannedCommandOutput
    ];
  });
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

function formatPlatformLabel(platform: string): string {
  return (
    {
      IOS: "iOS",
      MAC_OS: "macOS",
      TV_OS: "tvOS",
      VISION_OS: "visionOS"
    }[platform] ?? platform
  );
}

function buildMissingVersionError(version: string, platform: string): Error {
  return new Error(
    `App Store Connect has no App Store version ${version} for the ${formatPlatformLabel(platform)} app.`
  );
}

function requireAppStoreVersionRecord(
  versionRecord: AppStoreVersionRecord | null,
  version: string,
  platform: string
): AppStoreVersionRecord {
  if (!versionRecord) {
    throw buildMissingVersionError(version, platform);
  }

  return versionRecord;
}

function mapReleaseModeToAscReleaseType(
  releaseMode?: NormalizedActionRequest["releaseMode"]
): string | null {
  switch (releaseMode) {
    case "manual_after_review":
      return "MANUAL";
    case "automatic_on_approval":
      return "AFTER_APPROVAL";
    default:
      return null;
  }
}

function buildVersionLookupArgs(
  appId: string,
  version: string,
  platform: string
): string[] {
  return [
    "versions",
    "list",
    "--app",
    appId,
    "--version",
    version,
    "--platform",
    platform,
    "--output",
    "json"
  ];
}

function buildVersionCreateArgs(
  appId: string,
  version: string,
  platform: string,
  releaseMode?: NormalizedActionRequest["releaseMode"]
): string[] {
  const args = [
    "versions",
    "create",
    "--app",
    appId,
    "--version",
    version,
    "--platform",
    platform
  ];
  const releaseType = mapReleaseModeToAscReleaseType(releaseMode);
  if (releaseType) {
    args.push("--release-type", releaseType);
  }
  args.push("--output", "json");
  return args;
}

function buildVersionViewArgs(versionId: string): string[] {
  return [
    "versions",
    "view",
    "--version-id",
    versionId,
    "--include-build",
    "--output",
    "json"
  ];
}

function buildLegacyVersionGetArgs(versionId: string): string[] {
  return [
    "versions",
    "get",
    "--version-id",
    versionId,
    "--include-build",
    "--output",
    "json"
  ];
}

function buildLocalizationsListArgs(input: {
  appId: string;
  versionId?: string;
}): string[] {
  const args = ["localizations", "list"];
  if (input.versionId) {
    args.push("--version", input.versionId);
  } else {
    args.push("--app", input.appId, "--type", "app-info");
  }
  args.push("--paginate", "--output", "json");
  return args;
}

function buildLocalizationsUploadArgs(
  versionId: string,
  inputPath: string,
  mode: "dry-run" | "upload"
): string[] {
  const args = [
    "localizations",
    "upload",
    "--version",
    versionId,
    "--path",
    inputPath
  ];
  if (mode === "dry-run") {
    args.push("--dry-run");
  }
  args.push("--output", "json");
  return args;
}

function buildLocalizationsUploadDisplayCommand(
  binaryPath: string,
  versionId: string,
  mode: "dry-run" | "upload"
): string {
  return buildDisplayCommand(
    binaryPath,
    buildLocalizationsUploadArgs(
      versionId,
      "<generated-localizations-dir>",
      mode
    )
  );
}

function buildAttachBuildArgs(versionId: string, buildId: string): string[] {
  return [
    "versions",
    "attach-build",
    "--version-id",
    versionId,
    "--build",
    buildId,
    "--output",
    "json"
  ];
}

function buildValidateArgs(
  appId: string,
  versionId: string,
  platform: string
): string[] {
  return [
    "validate",
    "--app",
    appId,
    "--version-id",
    versionId,
    "--platform",
    platform,
    "--output",
    "json"
  ];
}

function buildReviewSubmissionCreateArgs(appId: string, platform: string): string[] {
  return [
    "review",
    "submissions-create",
    "--app",
    appId,
    "--platform",
    platform,
    "--output",
    "json"
  ];
}

function buildReviewItemAddArgs(
  submissionId: string,
  versionId: string
): string[] {
  return [
    "review",
    "items-add",
    "--submission",
    submissionId,
    "--item-type",
    "appStoreVersions",
    "--item-id",
    versionId,
    "--output",
    "json"
  ];
}

function buildReviewSubmissionSubmitArgs(submissionId: string): string[] {
  return [
    "review",
    "submissions-submit",
    "--id",
    submissionId,
    "--confirm",
    "--output",
    "json"
  ];
}

function buildReviewSubmissionPreviewCommands(
  binaryPath: string,
  appId: string,
  versionId: string,
  platform: string
): string[] {
  const submissionId = "<review-submission-id>";
  return [
    buildDisplayCommand(
      binaryPath,
      buildReviewSubmissionCreateArgs(appId, platform)
    ),
    buildDisplayCommand(
      binaryPath,
      buildReviewItemAddArgs(submissionId, versionId)
    ),
    buildDisplayCommand(binaryPath, buildReviewSubmissionSubmitArgs(submissionId))
  ];
}

function buildSubmitStatusArgs(versionId: string): string[] {
  return [
    "submit",
    "status",
    "--version-id",
    versionId,
    "--output",
    "json"
  ];
}

function buildSubmitCancelArgs(versionId: string): string[] {
  return [
    "submit",
    "cancel",
    "--version-id",
    versionId,
    "--confirm",
    "--output",
    "json"
  ];
}

function buildVersionReleaseArgs(versionId: string): string[] {
  return [
    "versions",
    "release",
    "--version-id",
    versionId,
    "--confirm",
    "--output",
    "json"
  ];
}

function escapeStringsValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

async function withLocalizationStringsDir<T>(
  localizedReleaseNotes: LocalizedReleaseNotes,
  callback: (localizationsDir: string) => Promise<T>
): Promise<T> {
  const localizationsDir = await mkdtemp(
    join(tmpdir(), "store-agent-localizations-")
  );

  try {
    for (const [locale, notes] of Object.entries(localizedReleaseNotes)) {
      await writeFile(
        join(localizationsDir, `${locale}.strings`),
        `"whatsNew" = "${escapeStringsValue(notes.trim())}";\n`
      );
    }

    return await callback(localizationsDir);
  } finally {
    await rm(localizationsDir, { recursive: true, force: true });
  }
}

async function lookupAppStoreVersion(input: {
  binaryPath: string;
  appId: string;
  version: string;
  platform: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  lookup: AscCommandResult;
  versionRecord: AppStoreVersionRecord | null;
}> {
  const lookup = await readProcessOutput(
    input.binaryPath,
    buildVersionLookupArgs(input.appId, input.version, input.platform),
    input.env
  );

  return {
    lookup,
    versionRecord: findAppStoreVersionRecord(lookup.json, input.version)
  };
}

async function waitForAppStoreVersion(input: {
  binaryPath: string;
  appId: string;
  version: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  attempts?: number;
  delayMs?: number;
}): Promise<{
  lookup: AscCommandResult;
  versionRecord: AppStoreVersionRecord | null;
}> {
  const attempts = input.attempts ?? 6;
  const delayMs = input.delayMs ?? 2000;

  let latest = await lookupAppStoreVersion(input);
  if (latest.versionRecord) {
    return latest;
  }

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await sleep(delayMs);
    latest = await lookupAppStoreVersion(input);
    if (latest.versionRecord) {
      return latest;
    }
  }

  return latest;
}

async function ensureAppStoreVersion(input: {
  binaryPath: string;
  appId: string;
  version: string;
  platform: string;
  releaseMode?: NormalizedActionRequest["releaseMode"];
  env: NodeJS.ProcessEnv;
}): Promise<{
  lookup: AscCommandResult;
  create: AscCommandResult | null;
  versionRecord: AppStoreVersionRecord;
  created: boolean;
}> {
  const existing = await lookupAppStoreVersion({
    binaryPath: input.binaryPath,
    appId: input.appId,
    version: input.version,
    platform: input.platform,
    env: input.env
  });
  if (existing.versionRecord) {
    return {
      lookup: existing.lookup,
      create: null,
      versionRecord: existing.versionRecord,
      created: false
    };
  }

  const create = await readProcessOutput(
    input.binaryPath,
    buildVersionCreateArgs(
      input.appId,
      input.version,
      input.platform,
      input.releaseMode
    ),
    input.env
  );
  const versionRecord =
    findAppStoreVersionRecord(create.json, input.version) ??
    (
      await waitForAppStoreVersion({
        binaryPath: input.binaryPath,
        appId: input.appId,
        version: input.version,
        platform: input.platform,
        env: input.env
      })
    ).versionRecord;
  const resolvedVersionRecord = requireAppStoreVersionRecord(
    versionRecord,
    input.version,
    input.platform
  );

  return {
    lookup: existing.lookup,
    create,
    versionRecord: resolvedVersionRecord,
    created: true
  };
}

function summarizePrepareReleasePlan(input: {
  version: string;
  versionExists: boolean;
  buildNumber: string;
  buildId: string;
  locales: string[];
  dryRunValidated: boolean;
  buildAlreadyAttached: boolean;
}): string[] {
  return [
    input.versionExists
      ? `Will update existing App Store version ${input.version}.`
      : `Will create App Store version ${input.version}.`,
    input.buildAlreadyAttached
      ? `Build ${input.buildNumber} (${input.buildId}) is already attached.`
      : `Will attach build ${input.buildNumber} (${input.buildId}).`,
    `Will apply localized release notes for ${input.locales.length} locale(s).`,
    input.dryRunValidated
      ? "Localization dry-run succeeded."
      : "Localization dry-run will run during execution after the version exists.",
    "Full App Store validation will run during execution after metadata upload and build attachment."
  ];
}

function summarizeSubmissionCancellationPlan(input: {
  version: string;
  statusPayload: Record<string, unknown>;
}): string[] {
  const lines = summarizeStatusPayload(input.statusPayload).slice(0, 3);
  lines.push(
    `Will cancel the current App Store review submission for version ${input.version}.`
  );
  return Array.from(new Set(lines));
}

function summarizeReleaseToAppStorePlan(input: {
  version: string;
  versionState: string;
  detailsPayload: Record<string, unknown>;
}): string[] {
  const lines = summarizeGenericPayload(input.detailsPayload).slice(0, 4);
  lines.unshift(
    `Version ${input.version} is ${input.versionState} in App Store Connect.`
  );
  lines.push(
    "Will run asc versions release (--confirm) to publish this version on the App Store (Pending Developer Release → live)."
  );
  return lines;
}

async function submitVersionForReview(input: {
  binaryPath: string;
  appId: string;
  versionId: string;
  platform: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  submissionCreate: AscCommandResult;
  itemAdd: AscCommandResult;
  submissionSubmit: AscCommandResult;
}> {
  const submissionCreate = await readProcessOutput(
    input.binaryPath,
    buildReviewSubmissionCreateArgs(input.appId, input.platform),
    input.env
  );
  const submissionId =
    findFirstString(submissionCreate.json, [
      "id",
      "data.id",
      "data.attributes.id",
      "reviewSubmissionId",
      "data.reviewSubmissionId"
    ]) ?? "";

  if (!submissionId) {
    throw new Error(
      "Unable to resolve review submission ID from asc review submissions-create output."
    );
  }

  const itemAdd = await readProcessOutput(
    input.binaryPath,
    buildReviewItemAddArgs(submissionId, input.versionId),
    input.env
  );
  const submissionSubmit = await readProcessOutput(
    input.binaryPath,
    buildReviewSubmissionSubmitArgs(submissionId),
    input.env
  );

  return { submissionCreate, itemAdd, submissionSubmit };
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

async function readProcessText(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<AscTextResult> {
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

  return {
    args,
    displayCommand: buildDisplayCommand(binaryPath, args),
    stdout,
    stderr
  };
}

async function readProcessOutput(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<AscCommandResult> {
  const result = await readProcessText(binaryPath, args, env);
  const trimmed = result.stdout.trim();
  const parsed: unknown = trimmed.length > 0 ? JSON.parse(trimmed) : {};
  const json = asRecord(parsed) ?? { data: parsed };

  return {
    ...result,
    json
  };
}

function shouldFallbackToLegacyVersionGet(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    /asc\s+versions\s+view/i.test(error.message) &&
    /\b(unknown|unsupported|invalid|not found|no such command|no help topic)\b/i.test(
      error.message
    )
  );
}

async function readVersionDetailsOutput(
  binaryPath: string,
  versionId: string,
  env: NodeJS.ProcessEnv
): Promise<AscCommandResult> {
  try {
    return await readProcessOutput(binaryPath, buildVersionViewArgs(versionId), env);
  } catch (error) {
    if (shouldFallbackToLegacyVersionGet(error)) {
      return readProcessOutput(
        binaryPath,
        buildLegacyVersionGetArgs(versionId),
        env
      );
    }

    throw error;
  }
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
  if (request.actionType === "cancel_review_submission") {
    return;
  }

  if (request.actionType === "release_to_app_store") {
    return;
  }

  if (request.actionType === "create_draft_release") {
    return;
  }

  if (
    (request.actionType !== "submit_release_for_review" &&
      request.actionType !== "update_draft_release" &&
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

  private readonly commandRecipePlanner?: OpenAiAscCommandRecipePlanner;

  private readonly commandOutputSummarizer?: OpenAiCommandOutputSummarizer;

  private readonly releaseNotesTranslator?: OpenAiReleaseNotesTranslator;

  private ascDocsPromise?: Promise<string>;

  private availableHelpPathsPromise?: Promise<string[][]>;

  private readonly helpTextCache = new Map<string, Promise<string>>();

  public constructor(options: AscRuntimeOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ASC_PATH ?? "asc";
    this.env = buildAscEnv(options.env ?? process.env);
    if (options.openAiApiKey) {
      this.commandRecipePlanner = new OpenAiAscCommandRecipePlanner({
        apiKey: options.openAiApiKey,
        model: options.openAiModel,
        reasoningEffort: options.openAiReasoningEffort,
        serviceTier: options.openAiServiceTier
      });
      this.commandOutputSummarizer = new OpenAiCommandOutputSummarizer({
        apiKey: options.openAiApiKey,
        model: options.openAiModel,
        reasoningEffort: options.openAiReasoningEffort,
        serviceTier: options.openAiServiceTier
      });
      this.releaseNotesTranslator = new OpenAiReleaseNotesTranslator({
        apiKey: options.openAiApiKey,
        model: options.openAiModel,
        reasoningEffort: options.openAiReasoningEffort,
        serviceTier: options.openAiServiceTier
      });
    }
  }

  private async getAscDocs(): Promise<string> {
    if (!this.ascDocsPromise) {
      this.ascDocsPromise = (async () => {
        const docsDir = await mkdtemp(join(tmpdir(), "store-agent-asc-docs-"));

        try {
          await readProcessOutput(
            this.binaryPath,
            ["docs", "init", "--path", docsDir, "--force", "--link=false"],
            this.env
          );

          const ascReference = await readFile(join(docsDir, "ASC.md"), "utf8");
          const topLevelHelp = await readProcessText(
            this.binaryPath,
            ["--help"],
            this.env
          );

          return [
            ascReference.trim(),
            "## Runtime Top-Level Help",
            `\`\`\`text\n${extractHelpText(topLevelHelp)}\n\`\`\``
          ].join("\n\n");
        } finally {
          await rm(docsDir, { recursive: true, force: true });
        }
      })();
    }

    return this.ascDocsPromise;
  }

  private async getHelpTextForCommandPath(commandPath: string[]): Promise<string> {
    const cacheKey = commandPath.join(" ");
    const cached = this.helpTextCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = readProcessText(
      this.binaryPath,
      [...commandPath, "--help"],
      this.env
    ).then((result) => extractHelpText(result));
    this.helpTextCache.set(cacheKey, promise);
    return promise;
  }

  private async getAvailableHelpPaths(): Promise<string[][]> {
    if (!this.availableHelpPathsPromise) {
      const promise: Promise<string[][]> = (async () => {
        const results = await Promise.all(
          ASC_DOC_HELP_PATHS.map(async (commandPath) => {
            try {
              await this.getHelpTextForCommandPath([...commandPath]);
              return [...commandPath] as string[];
            } catch {
              return null;
            }
          })
        );

        return results.flatMap((commandPath) =>
          Array.isArray(commandPath) ? [commandPath] : []
        );
      })();

      this.availableHelpPathsPromise = promise;
    }

    return this.availableHelpPathsPromise ?? Promise.resolve([]);
  }

  private async buildFocusedAscDocs(selectedPaths: string[][]): Promise<string> {
    const baseDocs = await this.getAscDocs();
    const availablePaths = await this.getAvailableHelpPaths();
    const expandedPaths = expandCommandPathsForContext(
      selectedPaths,
      availablePaths
    );
    const helpSections = await Promise.all(
      expandedPaths.map(async (commandPath) => {
        const helpText = await this.getHelpTextForCommandPath(commandPath);
        return `## asc ${commandPath.join(" ")} --help\n\n\`\`\`text\n${helpText}\n\`\`\``;
      })
    );

    return [baseDocs, ...helpSections].join("\n\n");
  }

  private async selectCommandPathsForRequest(input: {
    rawCommand: string;
    request: NormalizedActionRequest;
    app: ResolveRequestContext["app"];
  }): Promise<string[][]> {
    const availablePaths = await this.getAvailableHelpPaths();
    const heuristicPaths = suggestCommandPathsFromRequest(input.rawCommand);
    const planner = this.commandRecipePlanner;
    if (!planner) {
      throw new Error(
        "OpenAI command planning is not configured for dynamic asc command generation."
      );
    }

    let modelPaths: string[];
    try {
      modelPaths = await planner.selectCommandPaths({
        rawCommand: input.rawCommand,
        appReference: input.request.appReference,
        appAlias: input.request.appAlias,
        appId: input.app.appId,
        platform: input.app.platform,
        version: input.request.version,
        notes: input.request.notes ?? input.request.releaseNotes,
        commandCatalog: availablePaths.map((path) => commandPathKey(path))
      });
    } catch {
      modelPaths = [];
    }

    const selectedPaths = dedupeCommandPaths([
      ...heuristicPaths,
      ...modelPaths.map((path) => parseCatalogCommandPath(path))
    ]);

    if (selectedPaths.length > 0) {
      return selectedPaths;
    }

    return dedupeCommandPaths(availablePaths.filter((path) => path.length === 1));
  }

  private async planRecipeWithRepair(input: {
    request: NormalizedActionRequest;
    app: ResolveRequestContext["app"];
  }): Promise<{
    recipe: AscCommandRecipe;
    baseVariables: Record<string, string>;
  }> {
    const planner = this.commandRecipePlanner;
    if (!planner) {
      throw new Error(
        "OpenAI command planning is not configured for dynamic asc command generation."
      );
    }

    const selectedPaths = await this.selectCommandPathsForRequest({
      rawCommand: input.request.rawCommand,
      request: input.request,
      app: input.app
    });
    const focusedDocs = await this.buildFocusedAscDocs(selectedPaths);
    const baseVariables = this.buildBaseVariables(input.app, input.request);

    let recipe = await planner.planRecipe({
      rawCommand: input.request.rawCommand,
      appReference: input.request.appReference,
      appAlias: input.request.appAlias,
      appId: input.app.appId,
      platform: input.app.platform,
      version: input.request.version,
      notes: input.request.notes ?? input.request.releaseNotes,
      ascDocs: focusedDocs
    });

    if (!recipe.needsClarification) {
      try {
        await this.validateCommandRecipe(recipe, baseVariables);
      } catch (error) {
        recipe = await planner.repairRecipe({
          rawCommand: input.request.rawCommand,
          appReference: input.request.appReference,
          appAlias: input.request.appAlias,
          appId: input.app.appId,
          platform: input.app.platform,
          version: input.request.version,
          notes: input.request.notes ?? input.request.releaseNotes,
          ascDocs: focusedDocs,
          previousRecipe: recipe,
          validationError: toErrorMessage(error)
        });
      }
    }

    return { recipe, baseVariables };
  }

  private buildBaseVariables(
    app: ResolveRequestContext["app"],
    request: NormalizedActionRequest
  ): Record<string, string> {
    const variables: Record<string, string> = {
      appId: app.appId,
      appAlias: request.appAlias,
      appReference: request.appReference,
      platform: app.platform
    };

    if (request.version) {
      variables.version = request.version;
    }

    return variables;
  }

  private async validateCommandRecipe(
    recipe: AscCommandRecipe,
    variables?: Record<string, string>
  ): Promise<{
    requiresConfirmation: boolean;
    firstWriteStepIndex: number;
  }> {
    let requiresConfirmation = false;
    let firstWriteStepIndex = recipe.steps.length;

    for (const [index, step] of recipe.steps.entries()) {
      const generatedCommand = buildGeneratedStepCommand(
        this.binaryPath,
        step,
        variables
      );
      const commandPath = parseCommandPath(step.args);
      if (commandPath.length === 0) {
        throw new Error(
          `The generated command recipe contains an invalid step with no asc subcommand path at step ${index + 1}. Generated command: ${generatedCommand}`
        );
      }

      const helpText = await this.getHelpTextForCommandPath(commandPath);
      const supportedFlags = new Set(
        (helpText.match(/--[a-z0-9][a-z0-9-]*/gi) ?? []).map((flag) =>
          flag.toLowerCase()
        )
      );
      for (const flag of extractLongFlags(step.args)) {
        if (!supportedFlags.has(flag.toLowerCase())) {
          throw new Error(
            `The generated command recipe uses unsupported flag ${flag} for "asc ${commandPath.join(" ")}". Generated command: ${generatedCommand}`
          );
        }
      }

      const stepReturnsJson = step.args.some(
        (arg, argIndex) =>
          arg === "--output"
            ? step.args[argIndex + 1] === "json"
            : arg.toLowerCase() === "--output=json"
      );
      if (step.captures.length > 0 && !stepReturnsJson) {
        throw new Error(
          `The generated command recipe must use --output json when step ${index + 1} captures variables. Generated command: ${generatedCommand}`
        );
      }

      if (isWriteCommandArgs(step.args)) {
        requiresConfirmation = true;
        firstWriteStepIndex = Math.min(firstWriteStepIndex, index);
      }
    }

    return { requiresConfirmation, firstWriteStepIndex };
  }

  private async executeRecipeSteps(input: {
    recipe: AscCommandRecipe;
    baseVariables: Record<string, string>;
    initialVariables?: Record<string, string>;
    startIndex?: number;
    endIndex?: number;
  }): Promise<CommandExecutionState> {
    const variables: Record<string, string> = {
      ...input.baseVariables,
      ...(input.initialVariables ?? {})
    };
    const outputs: PlannedCommandOutput[] = [];

    for (let index = input.startIndex ?? 0; index < (input.endIndex ?? input.recipe.steps.length); index += 1) {
      const step = input.recipe.steps[index];
      const renderedArgs = renderStepArgs(step.args, variables, true);
      const wantsJson = step.captures.length > 0 || renderedArgs.some(
        (arg, argIndex) =>
          arg === "--output"
            ? renderedArgs[argIndex + 1] === "json"
            : arg.toLowerCase() === "--output=json"
      );

      if (wantsJson) {
        const result = await readProcessOutput(
          this.binaryPath,
          renderedArgs,
          this.env
        );
        Object.assign(variables, extractCapturedVariables(step, result.json));
        outputs.push({
          purpose: step.purpose,
          command: result.displayCommand,
          stdout: result.stdout,
          json: result.json
        });
        continue;
      }

      const result = await readProcessText(this.binaryPath, renderedArgs, this.env);
      outputs.push({
        purpose: step.purpose,
        command: result.displayCommand,
        stdout: result.stdout
      });
    }

    return { variables, outputs };
  }

  private buildPreviewCommands(
    recipe: AscCommandRecipe,
    variables: Record<string, string>
  ): string[] {
    return recipe.steps.map((step) =>
      buildDisplayCommand(
        this.binaryPath,
        renderStepArgs(step.args, variables, false)
      )
    );
  }

  private async summarizeReadOnlyOutputs(
    rawCommand: string,
    fallbackSummary: string,
    fallbackDetails: string[],
    outputs: PlannedCommandOutput[]
  ): Promise<{
    executionSummary: string;
    validationSummary: string[];
  }> {
    if (outputs.length === 0) {
      return {
        executionSummary: fallbackSummary,
        validationSummary: fallbackDetails
      };
    }

    if (this.commandOutputSummarizer) {
      try {
        const summary = await this.commandOutputSummarizer.summarizeOutputs({
          rawCommand,
          outputs
        });
        return {
          executionSummary: summary.shortSummary,
          validationSummary: summary.detailLines
        };
      } catch {
        // Fall through to heuristic summary below.
      }
    }

    const lastJson = [...outputs]
      .reverse()
      .find((output) => output.json)?.json;

    return {
      executionSummary: fallbackSummary,
      validationSummary: lastJson
        ? summarizeGenericPayload(lastJson).slice(0, 6)
        : fallbackDetails
    };
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

    if (request.actionType === "run_asc_commands") {
      const { recipe, baseVariables } = await this.planRecipeWithRepair({
        request,
        app
      });

      if (recipe.needsClarification) {
        throw new Error(
          recipe.clarificationQuestion ??
            "The asc command plan needs one more detail before it can proceed."
        );
      }

      const { requiresConfirmation, firstWriteStepIndex } =
        await this.validateCommandRecipe(recipe, baseVariables);
      const executionState = await this.executeRecipeSteps({
        recipe,
        baseVariables,
        endIndex: requiresConfirmation ? firstWriteStepIndex : undefined
      });
      const previewCommands = this.buildPreviewCommands(
        recipe,
        executionState.variables
      );
      const summaries = requiresConfirmation
        ? {
            executionSummary: recipe.executionSummary,
            validationSummary: recipe.validationSummary
          }
        : await this.summarizeReadOnlyOutputs(
            request.rawCommand,
            recipe.executionSummary,
            recipe.validationSummary,
            executionState.outputs
          );

      return providerExecutionPlanSchema.parse({
        provider: request.provider,
        actionType: request.actionType,
        appAlias: request.appAlias,
        appId: app.appId,
        version: request.version ?? executionState.variables.version,
        releaseMode: request.releaseMode,
        buildStrategy: request.buildStrategy,
        buildId: executionState.variables.buildId,
        buildNumber: executionState.variables.buildNumber,
        requiresConfirmation,
        previewCommands,
        validationSummary: summaries.validationSummary,
        executionSummary: summaries.executionSummary,
        rawProviderData: {
          commandRecipe: recipe,
          capturedVariables: executionState.variables,
          commandOutputs: executionState.outputs
        }
      });
    }

    if (request.actionType === "cancel_review_submission") {
      const version = requireVersion(request);
      const { lookup: versionLookup, versionRecord } = await lookupAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: app.appId,
        version,
        platform: app.platform,
        env: this.env
      });
      const resolvedVersion = requireAppStoreVersionRecord(
        versionRecord,
        version,
        app.platform
      );
      const submissionStatus = await readProcessOutput(
        this.binaryPath,
        buildSubmitStatusArgs(resolvedVersion.versionId),
        this.env
      );

      return providerExecutionPlanSchema.parse({
        provider: request.provider,
        actionType: request.actionType,
        appAlias: request.appAlias,
        appId: app.appId,
        version,
        buildStrategy: request.buildStrategy,
        previewCommands: [
          versionLookup.displayCommand,
          submissionStatus.displayCommand,
          buildDisplayCommand(
            this.binaryPath,
            buildSubmitCancelArgs(resolvedVersion.versionId)
          )
        ],
        validationSummary: summarizeSubmissionCancellationPlan({
          version,
          statusPayload: submissionStatus.json
        }),
        executionSummary: `Prepared cancellation of the App Store review submission for version ${version}.`,
        rawProviderData: {
          versionLookup: versionLookup.json,
          versionId: resolvedVersion.versionId,
          versionState: resolvedVersion.appStoreState,
          submissionStatus: submissionStatus.json
        }
      });
    }

    if (request.actionType === "release_to_app_store") {
      const version = requireVersion(request);
      const { lookup: versionLookup, versionRecord } = await lookupAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: app.appId,
        version,
        platform: app.platform,
        env: this.env
      });
      const resolvedVersion = requireAppStoreVersionRecord(
        versionRecord,
        version,
        app.platform
      );
      const versionDetails = await readVersionDetailsOutput(
        this.binaryPath,
        resolvedVersion.versionId,
        this.env
      );

      return providerExecutionPlanSchema.parse({
        provider: request.provider,
        actionType: request.actionType,
        appAlias: request.appAlias,
        appId: app.appId,
        version,
        buildStrategy: request.buildStrategy,
        previewCommands: [
          versionLookup.displayCommand,
          versionDetails.displayCommand,
          buildDisplayCommand(
            this.binaryPath,
            buildVersionReleaseArgs(resolvedVersion.versionId)
          )
        ],
        validationSummary: summarizeReleaseToAppStorePlan({
          version,
          versionState: resolvedVersion.appStoreState ?? "unknown",
          detailsPayload: versionDetails.json
        }),
        executionSummary: `Release version ${version} on the App Store (customer release after approval).`,
        rawProviderData: {
          versionLookup: versionLookup.json,
          versionId: resolvedVersion.versionId,
          versionState: resolvedVersion.appStoreState,
          versionDetails: versionDetails.json
        }
      });
    }

    if (request.actionType === "create_draft_release") {
      const version = requireVersion(request);
      const { lookup: versionLookup, versionRecord } = await lookupAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: app.appId,
        version,
        platform: app.platform,
        env: this.env
      });
      const previewCommands = [versionLookup.displayCommand];
      if (!versionRecord) {
        previewCommands.push(
          buildDisplayCommand(
            this.binaryPath,
            buildVersionCreateArgs(
              app.appId,
              version,
              app.platform,
              request.releaseMode
            )
          )
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
        requiresConfirmation: true,
        previewCommands,
        validationSummary: [
          versionRecord
            ? `App Store version ${version} already exists for ${formatPlatformLabel(app.platform)}.`
            : `Will create empty App Store version ${version} for ${formatPlatformLabel(app.platform)}.`,
          "No release notes, build attachment, validation, or review submission will be performed."
        ],
        executionSummary: versionRecord
          ? `App Store version ${version} already exists.`
          : `Create empty App Store version ${version}.`,
        rawProviderData: {
          versionLookup: versionLookup.json,
          versionId: versionRecord?.versionId,
          versionState: versionRecord?.appStoreState
        }
      });
    }

    if (
      request.actionType === "prepare_release_for_review" ||
      request.actionType === "update_draft_release"
    ) {
      const version = requireVersion(request);
      const releaseNotes = requireReleaseNotes(request);
      const updatesExistingDraft = request.actionType === "update_draft_release";

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

      const { lookup: versionLookup, versionRecord } = await lookupAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: app.appId,
        version,
        platform: app.platform,
        env: this.env
      });

      if (updatesExistingDraft && !versionRecord) {
        throw new Error(
          `App Store version ${version} was not found for ${formatPlatformLabel(app.platform)}. Create the draft version first, then retry the draft update.`
        );
      }

      const localizationMetadata = await readProcessOutput(
        this.binaryPath,
        buildLocalizationsListArgs({
          appId: app.appId,
          versionId: versionRecord?.versionId
        }),
        this.env
      );
      const locales = extractLocales(localizationMetadata.json);
      const localizedReleaseNotes =
        await this.releaseNotesTranslator.translateReleaseNotes({
          baseNotes: releaseNotes,
          locales
        });

      let versionDetails: AscCommandResult | null = null;
      let attachedBuildId: string | null = null;
      let localizationsDryRun: AscCommandResult | null = null;

      if (versionRecord) {
        versionDetails = await readVersionDetailsOutput(
          this.binaryPath,
          versionRecord.versionId,
          this.env
        );
        attachedBuildId = extractAttachedBuildId(versionDetails.json);
        localizationsDryRun = await withLocalizationStringsDir(
          localizedReleaseNotes,
          async (localizationsDir) =>
            readProcessOutput(
              this.binaryPath,
              buildLocalizationsUploadArgs(
                versionRecord.versionId,
                localizationsDir,
                "dry-run"
              ),
              this.env
            )
        );
      }

      const previewVersionId = versionRecord?.versionId ?? "<version-id-from-create>";
      const previewCommands = [
        latestBuild.displayCommand,
        versionLookup.displayCommand,
        localizationMetadata.displayCommand
      ];
      if (!versionRecord) {
        previewCommands.push(
          buildDisplayCommand(
            this.binaryPath,
            buildVersionCreateArgs(
              app.appId,
              version,
              app.platform,
              request.releaseMode
            )
          )
        );
      }
      previewCommands.push(
        buildLocalizationsUploadDisplayCommand(
          this.binaryPath,
          previewVersionId,
          "dry-run"
        ),
        buildLocalizationsUploadDisplayCommand(
          this.binaryPath,
          previewVersionId,
          "upload"
        )
      );
      if (!versionRecord || attachedBuildId !== buildId) {
        previewCommands.push(
          buildDisplayCommand(
            this.binaryPath,
            buildAttachBuildArgs(previewVersionId, buildId)
          )
        );
      }
      previewCommands.push(
        buildDisplayCommand(
          this.binaryPath,
          buildValidateArgs(app.appId, previewVersionId, app.platform)
        )
      );
      if (!updatesExistingDraft) {
        previewCommands.push(
          ...buildReviewSubmissionPreviewCommands(
            this.binaryPath,
            app.appId,
            previewVersionId,
            app.platform
          )
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
        validationSummary: summarizePrepareReleasePlan({
          version,
          versionExists: Boolean(versionRecord),
          buildNumber,
          buildId,
          locales,
          dryRunValidated: Boolean(localizationsDryRun),
          buildAlreadyAttached: attachedBuildId === buildId
        }),
        executionSummary: versionRecord
          ? updatesExistingDraft
            ? `Prepared draft update for existing version ${version} build ${buildNumber} across ${locales.length} locale(s).`
            : `Prepared release workflow for existing version ${version} build ${buildNumber} across ${locales.length} locale(s).`
          : `Prepared release workflow to create version ${version} with build ${buildNumber} across ${locales.length} locale(s).`,
        rawProviderData: {
          latestBuild: latestBuild.json,
          versionLookup: versionLookup.json,
          versionId: versionRecord?.versionId,
          versionState: versionRecord?.appStoreState,
          versionDetails: versionDetails?.json,
          localizationMetadata: localizationMetadata.json,
          localizationsDryRun: localizationsDryRun?.json,
          attachedBuildId,
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
    const { lookup: versionLookup, versionRecord } = await lookupAppStoreVersion({
      binaryPath: this.binaryPath,
      appId: app.appId,
      version,
      platform: app.platform,
      env: this.env
    });
    const resolvedVersion = requireAppStoreVersionRecord(
      versionRecord,
      version,
      app.platform
    );

    const validation = await readProcessOutput(
      this.binaryPath,
      buildValidateArgs(app.appId, resolvedVersion.versionId, app.platform),
      this.env
    );

    const previewCommands = [
      latestBuild.displayCommand,
      versionLookup.displayCommand,
      validation.displayCommand
    ];

    if (request.actionType === "submit_release_for_review") {
      previewCommands.push(
        ...buildReviewSubmissionPreviewCommands(
          this.binaryPath,
          app.appId,
          resolvedVersion.versionId,
          app.platform
        )
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
        versionLookup: versionLookup.json,
        versionId: resolvedVersion.versionId,
        versionState: resolvedVersion.appStoreState,
        validation: validation.json
      }
    });
  }

  public async revalidate(
    context: RevalidateRequestContext
  ): Promise<ProviderExecutionPlan> {
    if (context.request.actionType === "run_asc_commands") {
      const recipe = extractCommandRecipeFromPlan(context.previousPlan);
      const baseVariables = this.buildBaseVariables(context.app, context.request);
      const { requiresConfirmation, firstWriteStepIndex } =
        await this.validateCommandRecipe(recipe, {
          ...baseVariables,
          ...extractCapturedVariablesFromPlan(context.previousPlan)
        });

      if (!requiresConfirmation) {
        return context.previousPlan;
      }

      const revalidatedState = await this.executeRecipeSteps({
        recipe,
        baseVariables,
        endIndex: firstWriteStepIndex
      });
      const previousVariables = extractCapturedVariablesFromPlan(
        context.previousPlan
      );
      const variableNames = Array.from(
        new Set([
          ...Object.keys(previousVariables),
          ...Object.keys(revalidatedState.variables)
        ])
      );

      for (const name of variableNames) {
        if (previousVariables[name] !== revalidatedState.variables[name]) {
          throw new Error(
            `The command plan changed ${name} from ${previousVariables[name] ?? "(unset)"} to ${revalidatedState.variables[name] ?? "(unset)"}. Request a fresh approval before proceeding.`
          );
        }
      }

      return providerExecutionPlanSchema.parse({
        ...context.previousPlan,
        buildId: revalidatedState.variables.buildId ?? context.previousPlan.buildId,
        buildNumber:
          revalidatedState.variables.buildNumber ??
          context.previousPlan.buildNumber,
        previewCommands: this.buildPreviewCommands(
          recipe,
          revalidatedState.variables
        ),
        requiresConfirmation,
        rawProviderData: {
          ...context.previousPlan.rawProviderData,
          capturedVariables: revalidatedState.variables,
          commandOutputs: revalidatedState.outputs
        }
      });
    }

    const latestPlan = await this.resolve({
      app: context.app,
      request: context.request
    });

    if (
      (context.previousPlan.actionType === "submit_release_for_review" ||
        context.previousPlan.actionType === "update_draft_release" ||
        context.previousPlan.actionType === "prepare_release_for_review") &&
      latestPlan.buildId !== context.previousPlan.buildId
    ) {
      throw new Error(
        `The latest build changed from ${context.previousPlan.buildId} to ${latestPlan.buildId}. Request a fresh approval before proceeding.`
      );
    }

    return latestPlan;
  }

  public async execute(context: ExecuteRequestContext) {
    if (context.request.actionType === "run_asc_commands") {
      const recipe = extractCommandRecipeFromPlan(context.plan);
      const baseVariables = this.buildBaseVariables(context.app, context.request);
      const initialVariables = extractCapturedVariablesFromPlan(context.plan);
      const { requiresConfirmation, firstWriteStepIndex } =
        await this.validateCommandRecipe(recipe, {
          ...baseVariables,
          ...initialVariables
        });

      if (!requiresConfirmation) {
        throw new Error("The dynamic asc command plan is not a write action.");
      }

      const storedOutputs = extractStoredOutputsFromPlan(context.plan);
      const executionState = await this.executeRecipeSteps({
        recipe,
        baseVariables,
        initialVariables,
        startIndex: firstWriteStepIndex
      });
      const allOutputs = [...storedOutputs, ...executionState.outputs];

      let summary = context.plan.executionSummary;
      if (this.commandOutputSummarizer) {
        try {
          const outputSummary =
            await this.commandOutputSummarizer.summarizeOutputs({
              rawCommand: context.request.rawCommand,
              outputs: allOutputs
            });
          summary = outputSummary.shortSummary;
        } catch {
          // Fall back to the plan summary.
        }
      }

      return providerExecutionResultSchema.parse({
        ok: true,
        summary,
        rawResult: {
          commandOutputs: allOutputs,
          capturedVariables: executionState.variables
        }
      });
    }

    const version = requireVersion(context.request);

    if (context.request.actionType === "cancel_review_submission") {
      ensureWriteAction(context.request, context.plan);
      const resolvedVersion = requireAppStoreVersionRecord(
        (
          await lookupAppStoreVersion({
            binaryPath: this.binaryPath,
            appId: context.app.appId,
            version,
            platform: context.app.platform,
            env: this.env
          })
        ).versionRecord,
        version,
        context.app.platform
      );
      const cancel = await readProcessOutput(
        this.binaryPath,
        buildSubmitCancelArgs(resolvedVersion.versionId),
        this.env
      );

      return providerExecutionResultSchema.parse({
        ok: true,
        summary: `Cancelled the App Store review submission for version ${version}.`,
        rawResult: cancel.json
      });
    }

    if (context.request.actionType === "release_to_app_store") {
      const resolvedVersion = requireAppStoreVersionRecord(
        (
          await lookupAppStoreVersion({
            binaryPath: this.binaryPath,
            appId: context.app.appId,
            version,
            platform: context.app.platform,
            env: this.env
          })
        ).versionRecord,
        version,
        context.app.platform
      );
      const release = await readProcessOutput(
        this.binaryPath,
        buildVersionReleaseArgs(resolvedVersion.versionId),
        this.env
      );

      return providerExecutionResultSchema.parse({
        ok: true,
        summary: `Released version ${version} on the App Store.`,
        rawResult: {
          versionId: resolvedVersion.versionId,
          release: release.json
        }
      });
    }

    if (context.request.actionType === "create_draft_release") {
      ensureWriteAction(context.request, context.plan);
      const ensuredVersion = await ensureAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: context.app.appId,
        version,
        platform: context.app.platform,
        releaseMode: context.request.releaseMode,
        env: this.env
      });

      return providerExecutionResultSchema.parse({
        ok: true,
        summary: ensuredVersion.created
          ? `Created empty App Store version ${version}.`
          : `App Store version ${version} already exists.`,
        rawResult: {
          versionLookup: ensuredVersion.lookup.json,
          versionCreate: ensuredVersion.create?.json,
          versionId: ensuredVersion.versionRecord.versionId,
          versionState: ensuredVersion.versionRecord.appStoreState
        }
      });
    }

    ensureWriteAction(context.request, context.plan);
    const buildId = context.plan.buildId;

    if (!buildId) {
      throw new Error("Execution plan is missing a build ID.");
    }

    if (
      context.request.actionType === "prepare_release_for_review" ||
      context.request.actionType === "update_draft_release"
    ) {
      const updatesExistingDraft =
        context.request.actionType === "update_draft_release";
      const localizedReleaseNotes = extractLocalizedReleaseNotesFromPlan(
        context.plan
      );
      const existingVersion = await lookupAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: context.app.appId,
        version,
        platform: context.app.platform,
        env: this.env
      });
      if (updatesExistingDraft && !existingVersion.versionRecord) {
        throw new Error(
          `App Store version ${version} was not found for ${formatPlatformLabel(context.app.platform)}. Create the draft version first, then retry the draft update.`
        );
      }
      const ensuredVersion = await ensureAppStoreVersion({
        binaryPath: this.binaryPath,
        appId: context.app.appId,
        version,
        platform: context.app.platform,
        releaseMode: context.request.releaseMode,
        env: this.env
      });
      const versionId = ensuredVersion.versionRecord.versionId;
      const versionDetails = await readVersionDetailsOutput(
        this.binaryPath,
        versionId,
        this.env
      );
      const attachedBuildId = extractAttachedBuildId(versionDetails.json);
      const localizationResults = await withLocalizationStringsDir(
        localizedReleaseNotes,
        async (localizationsDir) => {
          const dryRun = await readProcessOutput(
            this.binaryPath,
            buildLocalizationsUploadArgs(versionId, localizationsDir, "dry-run"),
            this.env
          );
          const upload = await readProcessOutput(
            this.binaryPath,
            buildLocalizationsUploadArgs(versionId, localizationsDir, "upload"),
            this.env
          );

          return { dryRun, upload };
        }
      );
      let attachBuild: AscCommandResult | null = null;
      if (attachedBuildId !== buildId) {
        attachBuild = await readProcessOutput(
          this.binaryPath,
          buildAttachBuildArgs(versionId, buildId),
          this.env
        );
      }
      const validation = await readProcessOutput(
        this.binaryPath,
        buildValidateArgs(context.app.appId, versionId, context.app.platform),
        this.env
      );
      const submit = updatesExistingDraft
        ? null
        : await submitVersionForReview({
            binaryPath: this.binaryPath,
            appId: context.app.appId,
            versionId,
            platform: context.app.platform,
            env: this.env
          });

      return providerExecutionResultSchema.parse({
        ok: true,
        summary: updatesExistingDraft
          ? `Updated draft version ${version}, localized the release notes, attached build ${context.plan.buildNumber ?? buildId}, and validated it.`
          : `Created or updated version ${version}, localized the release notes, attached build ${context.plan.buildNumber ?? buildId}, validated it, and submitted it for App Store review.`,
        rawResult: {
          versionLookup: ensuredVersion.lookup.json,
          versionCreate: ensuredVersion.create?.json,
          versionDetails: versionDetails.json,
          localizationsDryRun: localizationResults.dryRun.json,
          localizationsUpload: localizationResults.upload.json,
          attachBuild: attachBuild?.json,
          validation: validation.json,
          submit: submit
            ? {
                submissionCreate: submit.submissionCreate.json,
                itemAdd: submit.itemAdd.json,
                submissionSubmit: submit.submissionSubmit.json
              }
            : null
        }
      });
    }

    const resolvedVersion = requireAppStoreVersionRecord(
      (
        await lookupAppStoreVersion({
          binaryPath: this.binaryPath,
          appId: context.app.appId,
          version,
          platform: context.app.platform,
          env: this.env
        })
      ).versionRecord,
      version,
      context.app.platform
    );
    const submit = await submitVersionForReview({
      binaryPath: this.binaryPath,
      appId: context.app.appId,
      versionId: resolvedVersion.versionId,
      platform: context.app.platform,
      env: this.env
    });

    return providerExecutionResultSchema.parse({
      ok: true,
      summary: `Submitted version ${version} build ${context.plan.buildNumber ?? context.plan.buildId} to App Store review.`,
      rawResult: {
        submissionCreate: submit.submissionCreate.json,
        itemAdd: submit.itemAdd.json,
        submissionSubmit: submit.submissionSubmit.json
      }
    });
  }
}
