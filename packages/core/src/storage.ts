import { createHash } from "node:crypto";

import pg from "pg";

import {
  type ActionType,
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
  response_url TEXT NOT NULL,
  raw_command TEXT NOT NULL,
  normalized_command JSONB NOT NULL,
  execution_plan JSONB NOT NULL,
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

CREATE INDEX IF NOT EXISTS approvals_status_expires_idx
  ON approvals (status, expires_at);

CREATE INDEX IF NOT EXISTS approvals_requested_by_idx
  ON approvals (requested_by);

CREATE INDEX IF NOT EXISTS audit_events_approval_idx
  ON audit_events (approval_id, created_at DESC);
`;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "cancelled"
  | "expired"
  | "executing"
  | "succeeded"
  | "failed";

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

export interface ApprovalRecord {
  approvalId: string;
  provider: ProviderId;
  actionType: ActionType;
  status: ApprovalStatus;
  requestedBy: string;
  approvedBy: string | null;
  channelId: string;
  responseUrl: string;
  rawCommand: string;
  normalizedCommand: NormalizedActionRequest;
  executionPlan: ProviderExecutionPlan;
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
  responseUrl: string;
  rawCommand: string;
  normalizedCommand: NormalizedActionRequest;
  executionPlan: ProviderExecutionPlan;
  idempotencyKey: string;
  approvalTokenHash: string;
  expiresAt: Date;
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

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    approvalId: String(row.approval_id),
    provider: providerIdSchema.parse(row.provider),
    actionType: String(row.action_type) as ActionType,
    status: String(row.status) as ApprovalStatus,
    requestedBy: String(row.requested_by),
    approvedBy: (row.approved_by as string | null) ?? null,
    channelId: String(row.channel_id),
    responseUrl: String(row.response_url),
    rawCommand: String(row.raw_command),
    normalizedCommand: row.normalized_command as NormalizedActionRequest,
    executionPlan: row.execution_plan as ProviderExecutionPlan,
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
          response_url,
          raw_command,
          normalized_command,
          execution_plan,
          idempotency_key,
          approval_token_hash,
          expires_at
        )
        VALUES (
          $1, $2, $3, 'pending', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12
        )
        RETURNING *
      `,
      [
        input.approvalId,
        input.provider,
        input.actionType,
        input.requestedBy,
        input.channelId,
        input.responseUrl,
        input.rawCommand,
        JSON.stringify(input.normalizedCommand),
        JSON.stringify(input.executionPlan),
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
