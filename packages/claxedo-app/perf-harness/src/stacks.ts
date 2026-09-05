// Only list implementations with a real driver. Labels cannot select another renderer.
export const STACKS: Record<string, { id: string; label: string }> = {
  "solid-1": { id: "solid-1", label: "shipping renderer (Solid 1, web bundle)" },
}

export const DEFAULT_STACK_ID = "solid-1"

export function stackLabel(id: string) {
  return STACKS[id]?.label ?? id
}

export function requireSupportedStack(id: string) {
  if (!STACKS[id]) throw new Error(`Unsupported --stack ${id}: no driver is implemented. Available: ${Object.keys(STACKS).join(", ")}`)
  return id
}
