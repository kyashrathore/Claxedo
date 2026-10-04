import { asArray, asRecord } from "@claxedo/helpers/guards"
import type { DecodeResult } from "./operation-definition"

export function object(raw: unknown): DecodeResult<Record<string, unknown>> {
  const value = asRecord(raw)
  if (!value) return { ok: false, reason: "expected an object" }
  return { ok: true, value }
}

export function withStrings(...fields: string[]) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    for (const field of fields) {
      if (typeof shape.value[field] !== "string" || shape.value[field] === "") {
        return { ok: false, reason: `expected a non-empty "${field}"` }
      }
    }
    return shape
  }
}

export function array(raw: unknown): DecodeResult<unknown[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: "expected an array" }
  return { ok: true, value: raw }
}

export function withArrays(...fields: string[]) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    for (const field of fields) {
      if (!Array.isArray(shape.value[field])) return { ok: false, reason: `expected an array "${field}"` }
    }
    return shape
  }
}

export function sessionPeople(raw: unknown): DecodeResult<Record<string, unknown>> {
  const shape = withArrays("grants")(raw)
  if (!shape.ok) return shape
  if (typeof shape.value.can_manage_shares !== "boolean") {
    return { ok: false, reason: 'expected a boolean "can_manage_shares"' }
  }
  for (const [index, grant] of asArray(shape.value.grants).entries()) {
    const row = object(grant)
    if (!row.ok || typeof row.value.grant_id !== "string") {
      return { ok: false, reason: `expected grants[${index}].grant_id to be a string` }
    }
    if (typeof row.value.granted_to_user_id !== "string") {
      return { ok: false, reason: `expected grants[${index}].granted_to_user_id to be a string` }
    }
  }
  return shape
}

export function withRecord(field: string, inner: (raw: unknown) => DecodeResult<unknown>) {
  return (raw: unknown): DecodeResult<Record<string, unknown>> => {
    const shape = object(raw)
    if (!shape.ok) return shape
    const nested = inner(shape.value[field])
    if (!nested.ok) return { ok: false, reason: `expected "${field}": ${nested.reason}` }
    return shape
  }
}

export function nullable<T>(decode: (raw: unknown) => DecodeResult<T>) {
  return (raw: unknown): DecodeResult<T | null> => (raw === null ? { ok: true, value: null } : decode(raw))
}

export function connection(raw: unknown): DecodeResult<Record<string, unknown>> {
  const shape = object(raw)
  if (!shape.ok) return shape
  if (shape.value["status"] === "provisioning" || shape.value["status"] === "stopped") return shape
  return withStrings("relayUrl")(raw)
}

export function statusResult(raw: unknown): DecodeResult<{ status: number; body?: unknown }> {
  const shape = object(raw)
  if (!shape.ok) return shape
  const status = shape.value.status
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    return { ok: false, reason: "expected a response status" }
  }
  return { ok: true, value: { status, ...(Object.hasOwn(shape.value, "body") ? { body: shape.value.body } : {}) } }
}
