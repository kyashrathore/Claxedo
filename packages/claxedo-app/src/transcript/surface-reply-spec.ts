import { checkSurfaceSpec, type SurfaceSpec } from "@claxedo/plugin-api/surface"
import { claxedoToolArguments } from "./claxedo-tool-view"

export function surfaceReplySpecInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const { title, components, data } = claxedoToolArguments(input)
  return data === undefined ? { title, components } : { title, components, data }
}

export function surfaceReplySpec(specInput: unknown): SurfaceSpec | undefined {
  const check = checkSurfaceSpec(specInput)
  return check.ok ? check.spec : undefined
}
