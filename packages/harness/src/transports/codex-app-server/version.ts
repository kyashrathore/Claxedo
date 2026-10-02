import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessVersionRange } from "../../contract"

export const CODEX_RANGE = { transport: "codex", program: "Codex", min: "0.156.1", max: "0.159.2" } as const satisfies HarnessVersionRange

export function codexReportedVersion(initialize: unknown): unknown {
  const userAgent = asString(asRecordOrEmpty(initialize).userAgent)
  return userAgent?.match(/^[^/\s]+\/(\d+\.\d+\.\d+)(?:[\s(]|$)/)?.[1] ?? userAgent
}
