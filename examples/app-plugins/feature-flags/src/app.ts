import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceProgram } from "@claxedo/plugin-api"
import {
  ENVIRONMENTS,
  applyPending,
  changeStat,
  createFlag,
  envTitle,
  isEnvId,
  killSwitch,
  pendingChanges,
  promotionWarnings,
  revertPending,
  seedFlags,
  stageEdits,
  unstage,
  validateFlagDraft,
  type FlagStore,
} from "./model"
import { changedEntries, displayEntries, emptyDraft, initialData, openingMessages, update } from "./surface"

const PAGE_ID = "feature-flags"
const ACTOR = "You"

function openFlags(api: PluginApi, state: { store: FlagStore }, channel: SurfaceChannel): SurfaceProgram {
  const { surfaceId } = channel
  const time = new Intl.DateTimeFormat(api.context.locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  let query = ""
  const view = () => displayEntries(state.store, { query, formatTime: (iso) => time.format(new Date(iso)) })
  let shown = view()
  channel.send(...openingMessages(surfaceId, initialData(shown, query)))

  const refresh = () => {
    const next = view()
    const messages = changedEntries(surfaceId, shown, next)
    shown = next
    if (messages.length > 0) channel.send(...messages)
  }

  const absorbEdits = (context: Readonly<Record<string, unknown>>) => {
    for (const env of ENVIRONMENTS) {
      const rows = context[env.id]
      if (!Array.isArray(rows)) continue
      state.store = stageEdits(state.store, env.id, rows)
      shown.set(`/envs/${env.id}/rows`, structuredClone(rows))
    }
  }

  const apply = async () => {
    const changes = pendingChanges(state.store)
    if (changes.length === 0) {
      api.ui.toast({ kind: "info", title: "Nothing to apply", description: "Edit a flag, then stage it." })
      return
    }
    const stat = changeStat(changes)
    const envs = ENVIRONMENTS.filter((env) => changes.some((change) => change.env === env.id)).map((env) => env.title)
    const warnings = promotionWarnings(state.store, changes)
    const confirmed = await api.ui.confirm({
      title: `Apply ${changes.length} flag change${changes.length === 1 ? "" : "s"}?`,
      description: [
        `${stat.additions} enabled, ${stat.deletions} disabled, ${stat.updates} retargeted in ${envs.join(", ")}.`,
        envs.includes("Production") ? "Production traffic changes as soon as you apply." : "",
        ...warnings,
      ].filter((line) => line !== "").join(" "),
      confirmLabel: "Apply changes",
    })
    if (!confirmed) return
    const result = applyPending(state.store, new Date().toISOString(), ACTOR)
    state.store = result.store
    api.ui.toast({ kind: "success", title: "Flags applied", description: `${result.applied.length} change${result.applied.length === 1 ? "" : "s"} recorded in the audit log.` })
  }

  return {
    async action(action) {
      absorbEdits(action.context)
      switch (action.name) {
        case "stage": {
          const count = pendingChanges(state.store).length
          api.ui.toast({ kind: "info", title: count === 0 ? "No edits to stage" : `${count} change${count === 1 ? "" : "s"} staged`, description: "Review & apply sends them to their environments." })
          break
        }
        case "search":
          query = typeof action.context.query === "string" ? action.context.query.slice(0, 200) : ""
          break
        case "clearSearch":
          query = ""
          channel.send(update(surfaceId, "/search/query", ""))
          break
        case "undo": {
          const env = action.context.env
          const key = typeof action.context.key === "string" ? action.context.key : ""
          if (isEnvId(env)) state.store = unstage(state.store, env, key)
          break
        }
        case "apply":
          await apply()
          break
        case "revert": {
          const count = pendingChanges(state.store).length
          if (count === 0) break
          const confirmed = await api.ui.confirm({ title: `Discard ${count} pending change${count === 1 ? "" : "s"}?`, description: "Every flag returns to its applied state.", confirmLabel: "Discard" })
          if (!confirmed) break
          state.store = revertPending(state.store)
          api.ui.toast({ kind: "info", title: "Pending changes reverted" })
          break
        }
        case "killProd": {
          const on = state.store.flags.filter((flag) => flag.envs.prod.enabled).map((flag) => flag.key)
          if (on.length === 0) {
            api.ui.toast({ kind: "info", title: "Production is already dark", description: "Every production flag is off." })
            break
          }
          const confirmed = await api.ui.confirm({
            title: `Disable all ${on.length} production flags?`,
            description: `${on.join(", ")} turn off immediately for every ${envTitle("prod")} user, skipping review.`,
            confirmLabel: "Disable everything",
          })
          if (!confirmed) break
          const result = killSwitch(state.store, "prod", new Date().toISOString(), ACTOR)
          state.store = result.store
          api.ui.toast({ kind: "warning", title: "Kill switch engaged", description: `${result.disabled.length} production flags are off.` })
          break
        }
        case "create": {
          const checked = validateFlagDraft(state.store, action.context.draft)
          if (!checked.ok) {
            api.ui.toast({ kind: "error", title: "Flag not created", description: checked.error })
            break
          }
          state.store = createFlag(state.store, checked.draft, new Date().toISOString(), ACTOR)
          channel.send(update(surfaceId, "/draft", emptyDraft()))
          api.ui.toast({ kind: "success", title: `Created ${checked.draft.key}`, description: "It is off in every environment until you stage and apply a change." })
          break
        }
      }
      refresh()
    },
  }
}

export default definePlugin({
  activate(api) {
    const state = { store: seedFlags(new Date()) }
    api.pages.register({ id: PAGE_ID, path: "/feature-flags", title: "Feature flags", surface: (channel) => openFlags(api, state, channel) })
    api.sidebar.item({ id: PAGE_ID, label: "Feature flags", pageId: PAGE_ID, icon: "outline-sliders", badge: () => pendingChanges(state.store).length || undefined })
    api.commands.register({ id: "feature-flags.open", title: "Open feature flags", category: "Feature flags", run: () => api.pages.open(PAGE_ID) })
    api.commands.register({
      id: "feature-flags.review",
      title: "Review pending flag changes",
      category: "Feature flags",
      run: () => {
        const count = pendingChanges(state.store).length
        api.ui.toast({ kind: "info", title: count === 0 ? "No pending flag changes" : `${count} pending flag change${count === 1 ? "" : "s"}` })
        api.pages.open(PAGE_ID)
      },
    })
  },
})
