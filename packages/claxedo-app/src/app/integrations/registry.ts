import type { Command, CommandHandler } from "./command-bus"
import { createSignal, type JSX } from "solid-js"
import { hasBacking, workspaceKey, type SessionRef } from "@/platform/identity/session-ref"

export type ContributionTier = "shell" | "claxedo-first-party" | "lease-bound-agent"

export type AgentContributionLease = {
  leaseId: string
  agentId: string
  expiresAt?: number
}

export type ContributionGate = {
  workspaceId?: string
  role?: "owner" | "admin" | "editor" | "viewer"
  hosting?: "central" | "workspace"
  backing?: "real" | "none"
}
type ContributionRole = NonNullable<ContributionGate["role"]>

export type ContributionGateContext = {
  sessionRef?: SessionRef
  workspaceId?: string
  role?: ContributionGate["role"]
  hosting?: ContributionGate["hosting"]
}

export type SurfaceContribution<TRenderContext = unknown, TLifecycle = unknown> = {
  id: string
  tier: ContributionTier
  lease?: AgentContributionLease
  surface: string
  slot?: string
  gate?: ContributionGate
  renderer?: (context: TRenderContext) => JSX.Element
  lifecycle?: TLifecycle
}

export type CommandContribution<TCommand extends Command = Command> = {
  id: TCommand["type"]
  tier: ContributionTier
  lease?: AgentContributionLease
  title: string
  category?: string
  gate?: ContributionGate
  handler: CommandHandler<TCommand>
}

export type ToolbarContribution = {
  id: string
  tier: ContributionTier
  lease?: AgentContributionLease
  command: string
  slot: string
  gate?: ContributionGate
}

export type MenuContribution = ToolbarContribution & {
  menu: string
}

export type RendererContribution = {
  id: string
  tier: ContributionTier
  lease?: AgentContributionLease
  kind: string
  gate?: ContributionGate
}

export type SettingsContribution = {
  id: string
  tier: ContributionTier
  lease?: AgentContributionLease
  section: string
  gate?: ContributionGate
}

export type ContributionRegistry = {
  surfaces: SurfaceContribution[]
  commands: CommandContribution[]
  toolbar: ToolbarContribution[]
  menus: MenuContribution[]
  renderers: RendererContribution[]
  settings: SettingsContribution[]
}

export type TrustedAgentContributionBundle = {
  lease: AgentContributionLease
  surfaces?: Array<Omit<SurfaceContribution, "tier" | "lease">>
  commands?: Array<Omit<CommandContribution, "tier" | "lease">>
  toolbar?: Array<Omit<ToolbarContribution, "tier" | "lease">>
  menus?: Array<Omit<MenuContribution, "tier" | "lease">>
  renderers?: Array<Omit<RendererContribution, "tier" | "lease">>
  settings?: Array<Omit<SettingsContribution, "tier" | "lease">>
}

export function trustedAgentContributionBundleFromEvent(event: unknown): TrustedAgentContributionBundle | undefined {
  if (!event || typeof event !== "object") return
  const item = event as { type?: unknown; properties?: unknown }
  if (item.type !== "trusted-agent.contributions.register") return
  const properties = item.properties
  if (!properties || typeof properties !== "object") return
  const bundle = properties as Record<string, unknown>
  const lease = agentContributionLease(bundle.lease)
  if (!lease) return
  return {
    lease,
    surfaces: contributionItems(bundle.surfaces, surfaceContribution),
    commands: contributionItems(bundle.commands, commandContribution),
    toolbar: contributionItems(bundle.toolbar, toolbarContribution),
    menus: contributionItems(bundle.menus, menuContribution),
    renderers: contributionItems(bundle.renderers, rendererContribution),
    settings: contributionItems(bundle.settings, settingsContribution),
  }
}

export function createContributionRegistry(seed: Partial<ContributionRegistry> = {}) {
  const registry: ContributionRegistry = {
    surfaces: [...(seed.surfaces ?? [])],
    commands: [...(seed.commands ?? [])],
    toolbar: [...(seed.toolbar ?? [])],
    menus: [...(seed.menus ?? [])],
    renderers: [...(seed.renderers ?? [])],
    settings: [...(seed.settings ?? [])],
  }

  /**
   * Revision of the registry's contents.
   *
   * The contribution lists are plain mutable arrays, so `addSurface` and
   * `removeSurface` used to be invisible to SolidJS: a renderer that had
   * already resolved a contribution kept the answer it got, which made hosted
   * activation arrive too late to matter and sign-out leave hosted UI mounted.
   *
   * Invalidation lives HERE rather than at the register/unregister helpers in
   * `first-party-content-surfaces.tsx` because this module owns every mutator —
   * `addTrustedAgentContributions` reaches the same arrays without going
   * through those helpers — and because bumping at the mutation site leaves
   * every reader reactive without a single consumer change. Same version-signal
   * shape the metadata slice already uses for `meta.ids()`.
   *
   * Bumped only when the arrays actually changed, so a no-op removal cannot
   * invalidate anything, and read by every accessor below so the tracking scope
   * that asked for the current contributions re-runs when they change.
   */
  const [revision, setRevision] = createSignal(0)
  const changed = () => setRevision((current) => current + 1)
  const track = () => void revision()

  return {
    all: () => {
      track()
      return registry
    },
    addSurface(contribution: SurfaceContribution) {
      if (upsert(registry.surfaces, contribution)) changed()
    },
    /**
     * Removes a surface by id.
     *
     * The counterpart `addSurface` never had: hosted contributions are
     * registered when an account signs in and have to come back OUT when it
     * signs out, and without this the only way to un-register anything was to
     * reload the page.
     */
    removeSurface(id: string) {
      if (remove(registry.surfaces, id)) changed()
    },
    addCommand(contribution: CommandContribution) {
      if (upsert(registry.commands, contribution)) changed()
    },
    addToolbar(contribution: ToolbarContribution) {
      if (upsert(registry.toolbar, contribution)) changed()
    },
    addMenu(contribution: MenuContribution) {
      if (upsert(registry.menus, contribution)) changed()
    },
    addRenderer(contribution: RendererContribution) {
      if (upsert(registry.renderers, contribution)) changed()
    },
    addSettings(contribution: SettingsContribution) {
      if (upsert(registry.settings, contribution)) changed()
    },
    addTrustedAgentContributions(bundle: TrustedAgentContributionBundle) {
      // One bump for the whole bundle: a lease installs its contributions as a
      // unit, and readers should see the unit, not each intermediate list.
      let mutated = false
      for (const contribution of bundle.surfaces ?? []) {
        mutated = upsert(registry.surfaces, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      for (const contribution of bundle.commands ?? []) {
        mutated = upsert(registry.commands, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      for (const contribution of bundle.toolbar ?? []) {
        mutated = upsert(registry.toolbar, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      for (const contribution of bundle.menus ?? []) {
        mutated = upsert(registry.menus, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      for (const contribution of bundle.renderers ?? []) {
        mutated = upsert(registry.renderers, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      for (const contribution of bundle.settings ?? []) {
        mutated = upsert(registry.settings, { ...contribution, tier: "lease-bound-agent", lease: bundle.lease }) || mutated
      }
      if (mutated) changed()
    },
    command(id: string) {
      track()
      return registry.commands.find((command) => command.id === id)
    },
    visibleSurfaces(context: ContributionGateContext) {
      track()
      return registry.surfaces.filter((surface) => contributionGateAllows(surface.gate, context))
    },
    visibleCommands(context: ContributionGateContext) {
      track()
      return registry.commands.filter((command) => contributionGateAllows(command.gate, context))
    },
    trustedAgentCommands() {
      track()
      return registry.commands.filter((command) => command.tier === "lease-bound-agent")
    },
    trustedAgentContributions() {
      track()
      return {
        surfaces: registry.surfaces.filter(leaseBoundAgent),
        commands: registry.commands.filter(leaseBoundAgent),
        toolbar: registry.toolbar.filter(leaseBoundAgent),
        menus: registry.menus.filter(leaseBoundAgent),
        renderers: registry.renderers.filter(leaseBoundAgent),
        settings: registry.settings.filter(leaseBoundAgent),
      }
    },
  }
}

export function contributionGateAllows(gate: ContributionGate | undefined, context: ContributionGateContext) {
  if (!gate) return true
  const workspaceId = context.workspaceId ?? (context.sessionRef ? workspaceKey(context.sessionRef) : undefined)
  const hosting = context.hosting ?? context.sessionRef?.host
  if (gate.workspaceId && gate.workspaceId !== workspaceId) return false
  if (gate.hosting && gate.hosting !== hosting) return false
  if (gate.backing === "real" && (!context.sessionRef || !hasBacking(context.sessionRef))) return false
  if (gate.backing === "none" && context.sessionRef && hasBacking(context.sessionRef)) return false
  if (gate.role && !roleIncludes(context.role, gate.role)) return false
  return true
}

function roleIncludes(actual: ContributionGate["role"] | undefined, minimum: ContributionRole) {
  const order: ContributionRole[] = ["viewer", "editor", "admin", "owner"]
  return actual ? order.indexOf(actual) >= order.indexOf(minimum) : false
}

/** Returns whether the list changed, so only real mutations bump the revision. */
function upsert<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index === -1) {
    items.push(next)
    return true
  }
  if (items[index] === next) return false
  items[index] = next
  return true
}

function remove<T extends { id: string }>(items: T[], id: string) {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return false
  items.splice(index, 1)
  return true
}

function leaseBoundAgent<T extends { tier: ContributionTier }>(contribution: T) {
  return contribution.tier === "lease-bound-agent"
}

function agentContributionLease(input: unknown): AgentContributionLease | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.leaseId !== "string" || item.leaseId.length === 0) return
  if (typeof item.agentId !== "string" || item.agentId.length === 0) return
  return {
    leaseId: item.leaseId,
    agentId: item.agentId,
    ...(typeof item.expiresAt === "number" ? { expiresAt: item.expiresAt } : {}),
  }
}

function contributionItems<T>(input: unknown, decode: (input: unknown) => T | undefined) {
  return Array.isArray(input) ? input.flatMap((item) => {
    const decoded = decode(item)
    return decoded ? [decoded] : []
  }) : undefined
}

function contributionGate(input: unknown): ContributionGate | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  return {
    ...(typeof item.workspaceId === "string" ? { workspaceId: item.workspaceId } : {}),
    ...(item.role === "owner" || item.role === "admin" || item.role === "editor" || item.role === "viewer" ? { role: item.role } : {}),
    ...(item.hosting === "central" || item.hosting === "workspace" ? { hosting: item.hosting } : {}),
    ...(item.backing === "real" || item.backing === "none" ? { backing: item.backing } : {}),
  }
}

function surfaceContribution(input: unknown): Omit<SurfaceContribution, "tier" | "lease"> | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.surface !== "string") return
  return {
    id: item.id,
    surface: item.surface,
    ...(typeof item.slot === "string" ? { slot: item.slot } : {}),
    ...(contributionGate(item.gate) ? { gate: contributionGate(item.gate) } : {}),
  }
}

function commandContribution(input: unknown): Omit<CommandContribution, "tier" | "lease"> | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.title !== "string") return
  return {
    id: item.id,
    title: item.title,
    ...(typeof item.category === "string" ? { category: item.category } : {}),
    ...(contributionGate(item.gate) ? { gate: contributionGate(item.gate) } : {}),
    handler: () => undefined,
  }
}

function toolbarContribution(input: unknown): Omit<ToolbarContribution, "tier" | "lease"> | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.command !== "string" || typeof item.slot !== "string") return
  return {
    id: item.id,
    command: item.command,
    slot: item.slot,
    ...(contributionGate(item.gate) ? { gate: contributionGate(item.gate) } : {}),
  }
}

function menuContribution(input: unknown): Omit<MenuContribution, "tier" | "lease"> | undefined {
  const toolbar = toolbarContribution(input)
  if (!toolbar || !input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.menu !== "string") return
  return { ...toolbar, menu: item.menu }
}

function rendererContribution(input: unknown): Omit<RendererContribution, "tier" | "lease"> | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.kind !== "string") return
  return {
    id: item.id,
    kind: item.kind,
    ...(contributionGate(item.gate) ? { gate: contributionGate(item.gate) } : {}),
  }
}

function settingsContribution(input: unknown): Omit<SettingsContribution, "tier" | "lease"> | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.section !== "string") return
  return {
    id: item.id,
    section: item.section,
    ...(contributionGate(item.gate) ? { gate: contributionGate(item.gate) } : {}),
  }
}
