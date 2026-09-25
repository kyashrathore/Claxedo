import { createSignal } from "solid-js"
import { useTranslator, type DomainTranslate } from "@/i18n"
import {
  useServer,
  type MarketplaceCatalog,
  type PluginCandidate,
  type PluginChange,
  type PluginToolGroup,
} from "@/server"
import { requestConfirm, showToast, useDialog } from "@/ui"
import { marketplaceDictionary, type MarketplaceKey } from "./i18n"
import { isBuiltIn, pluginLabel, toolGroups } from "./model"
import { withCurrentRevision } from "./revision"

type ActionInput = {
  readonly catalog: () => MarketplaceCatalog | undefined
  readonly reread: () => Promise<void>
}

type Translate = DomainTranslate<MarketplaceKey>

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createActivator(input: ActionInput) {
  const server = useServer()
  const harnesses = () => input.catalog()?.supportedHarnesses ?? []
  return async (subjects: readonly string[], choice: boolean | null) => {
    let expected = input.catalog()?.revision
    const changes: PluginChange[] = []
    for (const pluginInstanceId of subjects) {
      const change = await withCurrentRevision({
        revision: () => expected,
        reread: async () => {
          await input.reread()
          expected = input.catalog()?.revision
        },
        run: (revision) =>
          server.marketplace.setActivation({ pluginInstanceId, harnessIds: harnesses(), choice, revision }),
      })
      expected = change.revision
      changes.push(change)
    }
    return changes
  }
}

function createPending() {
  const [pending, setPending] = createSignal<string>()
  const run = async (plugin: PluginCandidate, failure: string, work: () => Promise<void>) => {
    setPending(plugin.pluginInstanceId)
    try {
      await work()
    } catch (error) {
      showToast({ title: failure, description: errorMessage(error) })
    } finally {
      setPending(undefined)
    }
  }
  return { pending, run }
}

function confirmDisable(dialog: ReturnType<typeof useDialog>, t: Translate, plugin: PluginCandidate) {
  const builtIn = isBuiltIn(plugin)
  return requestConfirm(dialog, {
    title: builtIn
      ? t("marketplace.confirm.builtInTitle")
      : t("marketplace.confirm.disableTitle", { name: pluginLabel(plugin) }),
    body: t(builtIn ? "marketplace.confirm.builtInBody" : "marketplace.confirm.disableBody"),
    confirmLabel: t(builtIn ? "marketplace.confirm.turnOff" : "marketplace.action.disable"),
    cancelLabel: t("marketplace.cancel"),
  })
}

function reportFailedSync(t: Translate, changes: readonly PluginChange[]) {
  const failed = changes.find((change) => change.reconciliation.state === "failed")
  if (!failed) return
  showToast({
    title: t("marketplace.toast.activationSaved"),
    description: failed.reconciliation.message ?? t("marketplace.toast.reconcileRetry"),
  })
}

export function createPluginActions(input: ActionInput) {
  const server = useServer()
  const dialog = useDialog()
  const t = useTranslator(marketplaceDictionary)
  const activateAll = createActivator(input)
  const { pending, run } = createPending()
  const activate = async (plugin: PluginCandidate, choice: boolean | null) => {
    if (!input.catalog()) return
    const subjects = isBuiltIn(plugin)
      ? toolGroups(plugin).map((group) => group.pluginInstanceId)
      : [plugin.pluginInstanceId]
    if (choice === false && !(await confirmDisable(dialog, t, plugin))) return
    const decision = isBuiltIn(plugin) && choice === true ? null : choice
    await run(plugin, t("marketplace.toast.changeFailed"), async () =>
      reportFailedSync(t, await activateAll(subjects, decision)),
    )
  }
  const setToolGroup = (plugin: PluginCandidate, group: PluginToolGroup, enabled: boolean) => {
    const failure = t(enabled ? "marketplace.toast.groupOnFailed" : "marketplace.toast.groupOffFailed", {
      group: group.id,
    })
    return run(plugin, failure, async () => void (await activateAll([group.pluginInstanceId], enabled)))
  }
  const update = (plugin: PluginCandidate) =>
    run(plugin, t("marketplace.toast.updateFailed"), async () => {
      await withCurrentRevision({
        revision: () => input.catalog()?.revision,
        reread: input.reread,
        run: (revision) => server.marketplace.update(plugin.pluginInstanceId, revision),
      })
    })
  return { pending, activate, setToolGroup, update }
}
