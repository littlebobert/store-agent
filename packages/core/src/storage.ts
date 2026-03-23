import { createHash } from "node:crypto";

import pg from "pg";

import {
  type ActionType,
  type ConversationMessage,
  type NormalizedActionRequest,
  type ProviderExecutionPlan,
  providerIdSchema,
  type ProviderId
} from "./actions.js";
import {
  type SlackUserAccess,
  userRoleSchema,
  type UserRole
} from "./policy.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS app_aliases (
  alias TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  app_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'IOS',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_users (
  slack_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_conversation_sessions (
  session_id UUID PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL DEFAULT '',
  owner_slack_user_id TEXT NOT NULL REFERENCES slack_users(slack_user_id),
  status TEXT NOT NULL DEFAULT 'active',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_normalized_request JSONB,
  last_execution_plan JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES slack_users(slack_user_id),
  approved_by TEXT REFERENCES slack_users(slack_user_id),
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  response_url TEXT,
  raw_command TEXT NOT NULL,
  normalized_command JSONB NOT NULL,
  execution_plan JSONB NOT NULL,
  conversation_session_id UUID REFERENCES slack_conversation_sessions(session_id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  approval_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id BIGSERIAL PRIMARY KEY,
  approval_id UUID REFERENCES approvals(approval_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_slack_user_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE approvals
  ALTER COLUMN response_url DROP NOT NULL;

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS thread_ts TEXT;

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS conversation_session_id UUID REFERENCES slack_conversation_sessions(session_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS approvals_status_expires_idx
  ON approvals (status, expires_at);

CREATE INDEX IF NOT EXISTS approvals_requested_by_idx
  ON approvals (requested_by);

CREATE INDEX IF NOT EXISTS audit_events_approval_idx
  ON audit_events (approval_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS slack_conversation_sessions_surface_idx
  ON slack_conversation_sessions (team_id, channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS slack_conversation_sessions_owner_idx
  ON slack_conversation_sessions (owner_slack_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS approvals_conversation_status_idx
  ON approvals (conversation_session_id, status, created_at DESC);
`;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "cancelled"
  | "expired"
  | "executing"
  | "succeeded"
  | "failed";

export type ConversationSessionStatus = "active" | "closed";

export interface AppAliasRecord {
  alias: string;
  provider: ProviderId;
  appId: string;
  platform: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredSlackUser extends SlackUserAccess {
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSessionRecord {
  sessionId: string;
  teamId: string;
  channelId: string;
  threadTs: string | null;
  ownerSlackUserId: string;
  status: ConversationSessionStatus;
  messages: ConversationMessage[];
  lastNormalizedRequest: NormalizedActionRequest | null;
  lastExecutionPlan: ProviderExecutionPlan | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRecord {
  approvalId: string;
  provider: ProviderId;
  actionType: ActionType;
  status: ApprovalStatus;
  requestedBy: string;
  approvedBy: string | null;
  channelId: string;
  threadTs: string | null;
  responseUrl: string | null;
  rawCommand: string;
  normalizedCommand: NormalizedActionRequest;
  executionPlan: ProviderExecutionPlan;
  conversationSessionId: string | null;
  idempotencyKey: string;
  approvalTokenHash: string;
  expiresAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApprovalInput {
  approvalId: string;
  provider: ProviderId;
  actionType: ActionType;
  requestedBy: string;
  channelId: string;
  threadTs?: string | null;
  responseUrl?: string | null;
  rawCommand: string;
  normalizedCommand: NormalizedActionRequest;
  executionPlan: ProviderExecutionPlan;
  conversationSessionId?: string | null;
  idempotencyKey: string;
  approvalTokenHash: string;
  expiresAt: Date;
}

export interface UpsertConversationSessionInput {
  sessionId: string;
  teamId: string;
  channelId: string;
  threadTs?: string | null;
  ownerSlackUserId: string;
  status?: ConversationSessionStatus;
  messages?: ConversationMessage[];
  lastNormalizedRequest?: NormalizedActionRequest | null;
  lastExecutionPlan?: ProviderExecutionPlan | null;
}

export interface UpsertAppAliasInput {
  alias: string;
  provider: ProviderId;
  appId: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertSlackUserInput {
  slackUserId: string;
  displayName?: string | null;
  role: UserRole;
  isActive?: boolean;
}

function mapAppAlias(row: Record<string, unknown>): AppAliasRecord {
  return {
    alias: String(row.alias),
    provider: providerIdSchema.parse(row.provider),
    appId: String(row.app_id),
    platform: String(row.platform),
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function normalizeAppMetadataIdentifier(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addMetadataIdentifierValues(
  target: Set<string>,
  value: unknown
): void {
  if (typeof value === "string") {
    const normalized = normalizeAppMetadataIdentifier(value);
    if (normalized) {
      target.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addMetadataIdentifierValues(target, item);
    }
  }
}

function collectAppAliasMetadataIdentifiers(
  metadata: Record<string, unknown>
): string[] {
  const identifiers = new Set<string>();

  for (const key of [
    "bundleId",
    "packageName",
    "bundleIds",
    "packageNames",
    "bundleIdentifier",
    "packageIdentifier",
    "bundleIdentifiers",
    "packageIdentifiers",
    "identifiers"
  ]) {
    addMetadataIdentifierValues(identifiers, metadata[key]);
  }

  return [...identifiers];
}

function mapSlackUser(row: Record<string, unknown>): StoredSlackUser {
  return {
    slackUserId: String(row.slack_user_id),
    displayName: (row.display_name as string | null) ?? null,
    role: userRoleSchema.parse(row.role),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function mapConversationSession(
  row: Record<string, unknown>
): ConversationSessionRecord {
  const threadTs =
    typeof row.thread_ts === "string" && row.thread_ts.length > 0
      ? row.thread_ts
      : null;

  return {
    sessionId: String(row.session_id),
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs,
    ownerSlackUserId: String(row.owner_slack_user_id),
    status: String(row.status) as ConversationSessionStatus,
    messages: Array.isArray(row.messages)
      ? (row.messages as ConversationMessage[])
      : [],
    lastNormalizedRequest:
      (row.last_normalized_request as NormalizedActionRequest | null) ?? null,
    lastExecutionPlan:
      (row.last_execution_plan as ProviderExecutionPlan | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  const threadTs =
    typeof row.thread_ts === "string" && row.thread_ts.length > 0
      ? row.thread_ts
      : null;

  return {
    approvalId: String(row.approval_id),
    provider: providerIdSchema.parse(row.provider),
    actionType: String(row.action_type) as ActionType,
    status: String(row.status) as ApprovalStatus,
    requestedBy: String(row.requested_by),
    approvedBy: (row.approved_by as string | null) ?? null,
    channelId: String(row.channel_id),
    threadTs,
    responseUrl: (row.response_url as string | null) ?? null,
    rawCommand: String(row.raw_command),
    normalizedCommand: row.normalized_command as NormalizedActionRequest,
    executionPlan: row.execution_plan as ProviderExecutionPlan,
    conversationSessionId:
      (row.conversation_session_id as string | null) ?? null,
    idempotencyKey: String(row.idempotency_key),
    approvalTokenHash: String(row.approval_token_hash),
    expiresAt: row.expires_at as Date,
    approvedAt: (row.approved_at as Date | null) ?? null,
    executedAt: (row.executed_at as Date | null) ?? null,
    result: (row.result as Record<string, unknown> | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PostgresStore {
  private readonly pool: pg.Pool;

  public constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(MIGRATION_SQL);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async recordProcessedRequest(
    requestKey: string,
    source: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO processed_requests (request_key, source, payload)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (request_key) DO NOTHING
        RETURNING request_key
      `,
      [requestKey, source, JSON.stringify(payload)]
    );

    return result.rowCount === 1;
  }

  public async upsertAppAlias(
    input: UpsertAppAliasInput
  ): Promise<AppAliasRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO app_aliases (alias, provider, app_id, platform, metadata)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (alias) DO UPDATE
        SET provider = EXCLUDED.provider,
            app_id = EXCLUDED.app_id,
            platform = EXCLUDED.platform,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        RETURNING *
      `,
      [
        input.alias,
        input.provider,
        input.appId,
        input.platform ?? "IOS",
        JSON.stringify(input.metadata ?? {})
      ]
    );

    return mapAppAlias(result.rows[0] as Record<string, unknown>);
  }

  public async getAppAlias(alias: string): Promise<AppAliasRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM app_aliases WHERE alias = $1`,
      [alias]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapAppAlias(result.rows[0] as Record<string, unknown>);
  }

  public async findAppAliasesByMetadataIdentifier(
    provider: ProviderId,
    identifier: string
  ): Promise<AppAliasRecord[]> {
    const normalizedIdentifier = normalizeAppMetadataIdentifier(identifier);
    if (!normalizedIdentifier) {
      return [];
    }

    const result = await this.pool.query(
      `SELECT * FROM app_aliases WHERE provider = $1`,
      [provider]
    );

    return result.rows
      .map((row) => mapAppAlias(row as Record<string, unknown>))
      .filter((appAlias) =>
        collectAppAliasMetadataIdentifiers(appAlias.metadata).includes(
          normalizedIdentifier
        )
      );
  }

  public async upsertSlackUser(
    input: UpsertSlackUserInput
  ): Promise<StoredSlackUser> {
    const result = await this.pool.query(
      `
        INSERT INTO slack_users (slack_user_id, display_name, role, is_active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slack_user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            role = EXCLUDED.role,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()
        RETURNING *
      `,
      [
        input.slackUserId,
        input.displayName ?? null,
        input.role,
        input.isActive ?? true
      ]
    );

    return mapSlackUser(result.rows[0] as Record<string, unknown>);
  }

  public async getSlackUser(
    slackUserId: string
  ): Promise<StoredSlackUser | null> {
    const result = await this.pool.query(
      `SELECT * FROM slack_users WHERE slack_user_id = $1`,
      [slackUserId]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapSlackUser(result.rows[0] as Record<string, unknown>);
  }

  public async getConversationSession(
    teamId: string,
    channelId: string,
    threadTs?: string | null
  ): Promise<ConversationSessionRecord | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM slack_conversation_sessions
        WHERE team_id = $1
          AND channel_id = $2
          AND thread_ts = $3
      `,
      [teamId, channelId, threadTs ?? ""]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapConversationSession(result.rows[0] as Record<string, unknown>);
  }

  public async deleteConversationSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM slack_conversation_sessions
        WHERE session_id = $1
      `,
      [sessionId]
    );
  }

  public async upsertConversationSession(
    input: UpsertConversationSessionInput
  ): Promise<ConversationSessionRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO slack_conversation_sessions (
          session_id,
          team_id,
          channel_id,
          thread_ts,
          owner_slack_user_id,
          status,
          messages,
          last_normalized_request,
          last_execution_plan
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb
        )
        ON CONFLICT (team_id, channel_id, thread_ts) DO UPDATE
        SET owner_slack_user_id = EXCLUDED.owner_slack_user_id,
            status = EXCLUDED.status,
            messages = EXCLUDED.messages,
            last_normalized_request = EXCLUDED.last_normalized_request,
            last_execution_plan = EXCLUDED.last_execution_plan,
            updated_at = NOW()
        RETURNING *
      `,
      [
        input.sessionId,
        input.teamId,
        input.channelId,
        input.threadTs ?? "",
        input.ownerSlackUserId,
        input.status ?? "active",
        JSON.stringify(input.messages ?? []),
        input.lastNormalizedRequest
          ? JSON.stringify(input.lastNormalizedRequest)
          : null,
        input.lastExecutionPlan ? JSON.stringify(input.lastExecutionPlan) : null
      ]
    );

    return mapConversationSession(result.rows[0] as Record<string, unknown>);
  }

  public async createApproval(
    input: CreateApprovalInput
  ): Promise<ApprovalRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO approvals (
          approval_id,
          provider,
          action_type,
          status,
          requested_by,
          channel_id,
          thread_ts,
          response_url,
          raw_command,
          normalized_command,
          execution_plan,
          conversation_session_id,
          idempotency_key,
          approval_token_hash,
          expires_at
        )
        VALUES (
          $1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14
        )
        RETURNING *
      `,
      [
        input.approvalId,
        input.provider,
        input.actionType,
        input.requestedBy,
        input.channelId,
        input.threadTs ?? null,
        input.responseUrl ?? null,
        input.rawCommand,
        JSON.stringify(input.normalizedCommand),
        JSON.stringify(input.executionPlan),
        input.conversationSessionId ?? null,
        input.idempotencyKey,
        input.approvalTokenHash,
        input.expiresAt
      ]
    );

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  public async getApprovalById(
    approvalId: string
  ): Promise<ApprovalRecord | null> {
    await this.pool.query(
      `
        UPDATE approvals
        SET status = 'expired',
            updated_at = NOW()
        WHERE approval_id = $1
          AND status = 'pending'
          AND expires_at < NOW()
      `,
      [approvalId]
    );

    const result = await this.pool.query(
      `SELECT * FROM approvals WHERE approval_id = $1`,
      [approvalId]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  public async cancelPendingApprovalsForConversationSession(
    conversationSessionId: string
  ): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE approvals
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE conversation_session_id = $1
          AND status = 'pending'
      `,
      [conversationSessionId]
    );

    return result.rowCount ?? 0;
  }

  public async appendAuditEvent(
    approvalId: string,
    eventType: string,
    actorSlackUserId: string | null,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO audit_events (approval_id, event_type, actor_slack_user_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [approvalId, eventType, actorSlackUserId, JSON.stringify(payload)]
    );
  }

  public async approvePendingApproval(
    approvalId: string,
    approvalTokenHash: string,
    approvedBy: string
  ): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `
        UPDATE approvals
        SET status = 'approved',
            approved_by = $3,
            approved_at = NOW(),
            updated_at = NOW()
        WHERE approval_id = $1
          AND approval_token_hash = $2
          AND status = 'pending'
          AND expires_at > NOW()
        RETURNING *
      `,
      [approvalId, approvalTokenHash, approvedBy]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  public async cancelApproval(
    approvalId: string
  ): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `
        UPDATE approvals
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE approval_id = $1
          AND status IN ('pending', 'approved')
        RETURNING *
      `,
      [approvalId]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  public async startExecution(
    approvalId: string
  ): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `
        UPDATE approvals
        SET status = 'executing',
            updated_at = NOW()
        WHERE approval_id = $1
          AND status = 'approved'
        RETURNING *
      `,
      [approvalId]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }

  public async completeExecution(
    approvalId: string,
    success: boolean,
    resultPayload: Record<string, unknown>,
    errorMessage?: string
  ): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `
        UPDATE approvals
        SET status = $2,
            result = $3::jsonb,
            error_message = $4,
            executed_at = NOW(),
            updated_at = NOW()
        WHERE approval_id = $1
          AND status = 'executing'
        RETURNING *
      `,
      [
        approvalId,
        success ? "succeeded" : "failed",
        JSON.stringify(resultPayload),
        errorMessage ?? null
      ]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapApproval(result.rows[0] as Record<string, unknown>);
  }
}
