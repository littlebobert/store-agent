import { z } from "zod";

export const userRoleSchema = z.enum(["requester", "approver", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export interface SlackUserAccess {
  slackUserId: string;
  role: UserRole;
  isActive: boolean;
}

function hasAtLeastRole(
  actualRole: UserRole,
  expectedRole: UserRole
): boolean {
  const rank: Record<UserRole, number> = {
    requester: 1,
    approver: 2,
    admin: 3
  };

  return rank[actualRole] >= rank[expectedRole];
}

export function canRequestWrite(access: SlackUserAccess | null): boolean {
  return access !== null && access.isActive && hasAtLeastRole(access.role, "requester");
}

export function canApproveWrite(access: SlackUserAccess | null): boolean {
  return access !== null && access.isActive && hasAtLeastRole(access.role, "approver");
}

export function canCancelApproval(
  access: SlackUserAccess | null,
  requesterId: string
): boolean {
  return (
    access !== null &&
    access.isActive &&
    (access.slackUserId === requesterId || hasAtLeastRole(access.role, "approver"))
  );
}

export function requireRequestAccess(access: SlackUserAccess | null): void {
  if (!canRequestWrite(access)) {
    throw new Error("You are not allowed to request release actions.");
  }
}

export function requireApprovalAccess(access: SlackUserAccess | null): void {
  if (!canApproveWrite(access)) {
    throw new Error("You are not allowed to approve release actions.");
  }
}
