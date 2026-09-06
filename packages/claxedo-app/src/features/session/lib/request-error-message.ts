import { readField, readString } from "@/lib/record"

/**
 * Pull a human message out of a failed request.
 *
 * The SDK's rejections carry the useful text on `data.message`, while
 * `Error.message` is often just the transport's status — so the payload shape is
 * checked first. `err` is whatever a promise rejected with, so the read goes
 * through `@/lib/record` rather than asserting the payload shape.
 *
 * One owner for the three surfaces that render a failed request: the composer's
 * submit path, the session screen, and the message timeline's recovery card.
 * The fallback is a parameter rather than an i18n lookup so this stays pure and
 * free of reactive dependencies.
 */
export function requestErrorMessage(err: unknown, fallback: string): string {
  const message = readString(readField(err, "data"), "message")
  if (message) return message
  if (err instanceof Error) return err.message
  return fallback
}
