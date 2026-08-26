import { createSignal, type Accessor } from "solid-js"

export type TerminalRendererRetentionMode = "active" | "active+1" | "4" | "all"

export type TerminalRendererRetentionEntry = {
  id: string
  visible: boolean
  activated: boolean
  lastActive: number
}

export const TERMINAL_RENDERER_RETENTION_KEY = "claxedo.terminal.rendererRetention"
export const DEFAULT_TERMINAL_RENDERER_RETENTION: TerminalRendererRetentionMode = "active+1"

export function parseTerminalRendererRetentionMode(value: string | null | undefined): TerminalRendererRetentionMode {
  if (value === "active" || value === "active+1" || value === "4" || value === "all") return value
  return DEFAULT_TERMINAL_RENDERER_RETENTION
}

export function terminalRendererRetentionMode(): TerminalRendererRetentionMode {
  if (typeof localStorage === "undefined") return DEFAULT_TERMINAL_RENDERER_RETENTION
  try {
    return parseTerminalRendererRetentionMode(localStorage.getItem(TERMINAL_RENDERER_RETENTION_KEY))
  } catch {
    return DEFAULT_TERMINAL_RENDERER_RETENTION
  }
}

/**
 * Selects accelerated renderer owners only. Every activated Terminal component
 * remains mounted and therefore keeps its PTY socket and canonical xterm model;
 * entries outside this set merely release their optional WebGL addon.
 */
export function retainedTerminalRendererIds(
  entries: readonly TerminalRendererRetentionEntry[],
  mode: TerminalRendererRetentionMode,
): Set<string> {
  const eligible = entries.filter((entry) => entry.activated || entry.visible)
  if (mode === "all") return new Set(eligible.map((entry) => entry.id))

  const retained = new Set(eligible.filter((entry) => entry.visible).map((entry) => entry.id))
  const hidden = eligible
    .filter((entry) => !entry.visible)
    .sort((a, b) => b.lastActive - a.lastActive || a.id.localeCompare(b.id))
  const hiddenBudget = mode === "active" ? 0 : mode === "active+1" ? 1 : Math.max(0, 4 - retained.size)
  for (const entry of hidden.slice(0, hiddenBudget)) retained.add(entry.id)
  return retained
}

type RegistryEntry = TerminalRendererRetentionEntry & {
  token: symbol
  setRetained: (value: boolean) => void
  wasVisible: boolean
}

type RegistryState = {
  entries: Map<symbol, RegistryEntry>
  recency: number
}

const REGISTRY_STATE_KEY = "__claxedoTerminalRendererRetention"

function registryState(): RegistryState {
  const host = globalThis as typeof globalThis & { [REGISTRY_STATE_KEY]?: RegistryState }
  return (host[REGISTRY_STATE_KEY] ??= { entries: new Map(), recency: 0 })
}

function recompute() {
  const registry = registryState().entries
  const retained = retainedTerminalRendererIds([...registry.values()], terminalRendererRetentionMode())
  for (const entry of registry.values()) entry.setRetained(retained.has(entry.id))
}

/** Register one terminal surface in the page-wide renderer budget. */
export function registerTerminalRendererRetention(id: string): {
  retained: Accessor<boolean>
  mode: () => TerminalRendererRetentionMode
  update: (input: { visible: boolean; activated: boolean }) => void
  dispose: () => void
} {
  const token = Symbol(id)
  const [retained, setRetained] = createSignal(false)
  const entry: RegistryEntry = {
    token,
    id,
    visible: false,
    activated: false,
    lastActive: 0,
    wasVisible: false,
    setRetained,
  }
  registryState().entries.set(token, entry)
  recompute()

  return {
    retained,
    mode: terminalRendererRetentionMode,
    update(input) {
      entry.visible = input.visible
      entry.activated = input.activated
      if (input.visible && !entry.wasVisible) entry.lastActive = ++registryState().recency
      entry.wasVisible = input.visible
      recompute()
    },
    dispose() {
      registryState().entries.delete(token)
      recompute()
    },
  }
}
