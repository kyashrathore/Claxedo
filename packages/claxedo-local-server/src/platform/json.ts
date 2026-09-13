/**
 * The names this package reads untrusted JSON through — request bodies,
 * runtime event payloads, subprocess output, files written by other tools.
 *
 * Every test belongs to server-core's `platform/runtime/lib/json` or to
 * `@claxedo/helpers`; none is implemented here. The string readers differ in
 * whether they trim and whether they accept `""` — pick by what the field is.
 */
import { isNonEmptyString } from "@claxedo/server-core/platform/runtime/lib/json"

export {
  isJsonRecord as isRecord,
  jsonNumber as num,
  jsonRecord as record,
  jsonStringEntries as stringRecord,
} from "@claxedo/server-core/platform/runtime/lib/json"
/** A string exactly as sent, `""` included — for ids and opaque tokens. */
export { asString as raw } from "@claxedo/helpers/guards"
/** A trimmed, non-blank string — for names and identifiers read from a request. */
export { trimToUndefined as trimmed } from "@claxedo/helpers/string"

/** A string with visible content, returned exactly as sent (no trimming). */
export function text(input: unknown): string | undefined {
  return isNonEmptyString(input) ? input : undefined
}
