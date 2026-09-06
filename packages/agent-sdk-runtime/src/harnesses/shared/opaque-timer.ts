import { isRecord } from "@claxedo/agent-runtime-contract"

/**
 * The lifecycle timers accept an injectable clock, so a handle is whatever that
 * clock returned. The platform issues either a numeric id (browsers, Bun) or a
 * `Timeout` object (Node); anything else was not issued by `setTimeout` and is
 * left alone.
 */
export function clearOpaqueTimer(handle: unknown): void {
  if (typeof handle === "number") clearTimeout(handle)
  else if (isNodeTimeout(handle)) clearTimeout(handle)
}

function isNodeTimeout(value: unknown): value is NodeJS.Timeout {
  return isRecord(value) && typeof value.unref === "function"
}
