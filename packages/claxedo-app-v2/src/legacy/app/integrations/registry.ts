import type { Command, CommandHandler } from "./command-bus"
import { createSignal, type JSX } from "solid-js"
import { hasBacking, workspaceKey, type SessionRef } from "@/platform/identity/session-ref"
import type { AppIconName } from "@/ui/icons/catalog"

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

/** The group of Settings tabs a contributed section is listed under. */
export type SettingsSection = "desktop" | "workspace" | "account"

export type SettingsContribution = {
  /** Also the tab value, which is what `DialogSettings` takes as `initialTab`. */
  id: string
  tier: ContributionTier
  lease?: AgentContributionLease
  section: SettingsSection
  label: string
  icon?: AppIconName
  gate?: ContributionGate
  renderer: () => JSX.Element
}

export type ContributionRegistry = {
  /**
   * `never` is the variance-correct render context for STORAGE: the registry
   * cannot know what a contribution's renderer wants, and a renderer that
   * accepts any specific context is assignable to one accepting `never`. Typing
   * it `unknown` instead made every typed contribution need a cast on the way
   * in and another on the way out.
   */
  surfaces: SurfaceContribution<never>[]
  commands: CommandContribution[]
  toolbar: ToolbarContribution[]
  menus: MenuContribution[]
  renderers: RendererContribution[]
  settings: SettingsContribution[]
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
   * The contribution lists are plain mutable arrays, invisible to SolidJS on
   * their own: a renderer that has already resolved a contribution keeps the
   * answer it got, which would let hosted activation arrive too late to matter
   * and leave hosted UI mounted after sign-out. This revision signal is what
   * makes `addSurface` and `removeSurface` visible instead.
   *
   * Invalidation lives HERE rather than at the register/unregister helpers in
   * `first-party-content-surfaces.tsx` because this module owns every mutator
   * and because bumping at the mutation site leaves
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
    addSurface(contribution: SurfaceContribution<never>) {
      if (upsert(registry.surfaces, contribution)) changed()
    },
    /**
     * Removes a surface by id.
     *
     * The counterpart `addSurface` never had: hosted contributions are
     * registered when an account signs in and have to come back out when it
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
    visibleSettings(context: ContributionGateContext) {
      track()
      return registry.settings.filter((entry) => contributionGateAllows(entry.gate, context))
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

function remove(items: { id: string }[], id: string) {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return false
  items.splice(index, 1)
  return true
}
