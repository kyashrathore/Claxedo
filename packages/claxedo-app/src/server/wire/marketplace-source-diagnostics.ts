import { asArray, isRecord } from "@claxedo/helpers/guards"
import type { PluginSourceDiagnostic } from "../marketplace-types"

export function sourceDiagnosticsFromWire(value: unknown): readonly PluginSourceDiagnostic[] {
  const error = isRecord(value) && isRecord(value.error) ? value.error : undefined
  return asArray(error?.diagnostics).flatMap((item) =>
    isRecord(item) &&
    typeof item.sourceId === "string" &&
    typeof item.relativePath === "string" &&
    typeof item.code === "string" &&
    typeof item.message === "string"
      ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
      : [],
  )
}
