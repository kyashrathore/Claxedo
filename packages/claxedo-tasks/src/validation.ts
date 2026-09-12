import { isRecord } from "@claxedo/helpers/guards"
import { utf8ByteLength } from "@claxedo/helpers/string"
import type { InvalidField, InvalidFieldReason } from "./contracts"

export type FieldCollector = {
  add(path: string, reason: InvalidFieldReason): void
  readonly fields: readonly InvalidField[]
  readonly ok: boolean
}

export function collectFields(): FieldCollector {
  const fields: InvalidField[] = []
  return {
    add(path, reason) {
      fields.push({ path, reason })
    },
    get fields() {
      return fields
    },
    get ok() {
      return fields.length === 0
    },
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; fields: readonly InvalidField[] }

export function parsedOk<T>(value: T): Parsed<T> {
  return { ok: true, value }
}

export function parsedInvalid<T>(fields: readonly InvalidField[]): Parsed<T> {
  return { ok: false, fields }
}

/**
 * Readers over untrusted JSON. Each one reports the field it could not read
 * and returns undefined; none coerces, defaults or trims, so a wrong type is
 * always a named 400 rather than a value the caller never sent.
 */
export type Reader = {
  record(value: unknown, path: string): Record<string, unknown> | undefined
  string(value: unknown, path: string): string | undefined
  nonEmptyString(value: unknown, path: string): string | undefined
  boundedText(value: unknown, path: string, maxBytes: number): string | undefined
  nullableString(value: unknown, path: string): string | null | undefined
  integer(value: unknown, path: string): number | undefined
  boolean(value: unknown, path: string): boolean | undefined
  array(value: unknown, path: string): readonly unknown[] | undefined
}

/** A collector and the readers writing into it, threaded through one decode. */
export type DecodeContext = {
  fields: FieldCollector
  read: Reader
}

export function decodeContext(): DecodeContext {
  const fields = collectFields()
  return { fields, read: reader(fields) }
}

/** Builds the value first, because the build is what reports the invalid fields. */
export function finishDecode<T>(ctx: DecodeContext, build: () => T): Parsed<T> {
  const value = build()
  return ctx.fields.ok ? parsedOk(value) : parsedInvalid(ctx.fields.fields)
}

export function reader(fields: FieldCollector): Reader {
  const miss = (path: string, reason: InvalidFieldReason) => {
    fields.add(path, reason)
    return undefined
  }
  return {
    record(value, path) {
      if (value === undefined) return miss(path, "required")
      return isRecord(value) ? value : miss(path, "type")
    },
    string(value, path) {
      if (value === undefined) return miss(path, "required")
      return typeof value === "string" ? value : miss(path, "type")
    },
    nonEmptyString(value, path) {
      if (value === undefined) return miss(path, "required")
      if (typeof value !== "string") return miss(path, "type")
      return value.trim().length > 0 ? value : miss(path, "required")
    },
    boundedText(value, path, maxBytes) {
      if (value === undefined) return miss(path, "required")
      if (typeof value !== "string") return miss(path, "type")
      return utf8ByteLength(value) <= maxBytes ? value : miss(path, "too_long")
    },
    nullableString(value, path) {
      if (value === undefined) return miss(path, "required")
      if (value === null) return null
      if (typeof value !== "string") return miss(path, "type")
      return value.trim().length > 0 ? value : miss(path, "required")
    },
    integer(value, path) {
      if (value === undefined) return miss(path, "required")
      if (typeof value !== "number") return miss(path, "type")
      return Number.isSafeInteger(value) ? value : miss(path, "out_of_range")
    },
    boolean(value, path) {
      if (value === undefined) return miss(path, "required")
      return typeof value === "boolean" ? value : miss(path, "type")
    },
    array(value, path) {
      if (value === undefined) return miss(path, "required")
      return Array.isArray(value) ? value : miss(path, "type")
    },
  }
}
