import { asRecord, asString } from "@claxedo/helpers/guards"
import { orgId, userId } from "../ids"
import type { OrgMember, OrgMembership, OrgRole } from "../types"

function roleFromWire(value: unknown): OrgRole | undefined {
  return value === "owner" || value === "admin" || value === "member" ? value : undefined
}

export function membershipFromWire(value: unknown): OrgMembership | undefined {
  const row = asRecord(value)
  const id = asString(row?.org_id)
  const name = asString(row?.name)
  const role = roleFromWire(row?.role)
  return id && name && role ? { orgId: orgId(id), name, role } : undefined
}

export function memberFromWire(value: unknown): OrgMember | undefined {
  const row = asRecord(value)
  const id = asString(row?.user_id)
  const role = roleFromWire(row?.role)
  const name = asString(row?.name)
  return id && role ? { userId: userId(id), role, you: row?.you === true, ...(name ? { name } : {}) } : undefined
}
