import { asRecord } from "@claxedo/helpers/guards"
import type { AccountCheck } from "./account-types"
import { contractMismatch, ServerError } from "./errors"
import { accountCheckFromWire } from "./wire/accounts"

export function accountCheckAnswer(raw: unknown): AccountCheck {
  const check = accountCheckFromWire(raw)
  if (!check) throw contractMismatch("account check")
  return check
}

export function accountRemovalAnswer(raw: unknown): void {
  const deleted = asRecord(raw)?.deleted
  if (deleted === true) return
  if (deleted === false) throw new ServerError({ class: "not_found", message: "This account is no longer stored here." })
  throw contractMismatch("account removal")
}
