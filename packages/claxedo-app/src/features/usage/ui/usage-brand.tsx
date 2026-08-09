import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

export type UsageBrand = "claude" | "codex" | "opencode" | "claxedo" | "cursor" | "pi" | "neutral"

export function usageBrand(value: string): UsageBrand {
  const normalized = value.trim().toLowerCase()
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude"
  if (normalized.includes("codex") || normalized.includes("openai") || normalized.startsWith("gpt-")) return "codex"
  if (normalized.includes("opencode")) return "opencode"
  if (normalized.includes("claxedo")) return "claxedo"
  if (normalized.includes("cursor")) return "cursor"
  if (normalized === "pi" || normalized.startsWith("pi/")) return "pi"
  return "neutral"
}

const icon = (brand: UsageBrand) => {
  if (brand === "claude") return "claude" as const
  if (brand === "codex") return "openai" as const
  if (brand === "opencode") return "opencode" as const
  if (brand === "cursor") return "cursor" as const
  if (brand === "pi") return "pi" as const
  return "gauge" as const
}

export function UsageBrandLabel(props: { value: string; label: string }) {
  const brand = () => usageBrand(`${props.value} ${props.label}`)
  const label = () => {
    const value = props.label.trim().toLowerCase()
    if (value === "anthropic") return "Claude"
    if (value === "openai") return "Codex"
    return props.label
  }
  return (
    <span class={`usage-brand usage-brand-${brand()}`}>
      <Icon name={icon(brand())} size="small" />
      <span>{label()}</span>
    </span>
  )
}
