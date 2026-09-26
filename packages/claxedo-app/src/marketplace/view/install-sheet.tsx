import { createSignal, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer, type PluginCandidate, type PluginHarness } from "@/server"
import { Button, Dialog, showToast, useDialog, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { pluginLabel } from "../model"
import { InstallHarnesses, InstallPlacement, harnessRows } from "./install-sections"

function SheetHeader(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const name = () => pluginLabel(props.plugin)
  const monogram = () => (name().trim()[0] ?? "?").toUpperCase()
  return (
    <span class="flex items-center gap-3">
      <Show
        when={props.plugin.icon?.kind === "url" ? props.plugin.icon : undefined}
        fallback={
          <span
            aria-hidden="true"
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-interactive-base text-14-medium text-text-on-interactive-base"
          >
            {props.plugin.icon?.kind === "monogram" ? props.plugin.icon.text : monogram()}
          </span>
        }
      >
        {(icon) => <img src={icon().url} alt="" class="size-10 shrink-0 rounded-lg object-cover" />}
      </Show>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{t("marketplace.install.title", { name: name() })}</span>
        <span class="flex items-center gap-1.5 text-12-regular text-text-weaker">
          <span class="text-text-base">{t("marketplace.install.stepWhere")}</span>
        </span>
      </span>
    </span>
  )
}

function createInstall(props: {
  readonly plugin: PluginCandidate
  readonly revision: number
  readonly done: () => void
}) {
  const t = useTranslator(marketplaceDictionary)
  const server = useServer()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const install = async (harnessIds: readonly PluginHarness[]) => {
    setError(undefined)
    setBusy(true)
    try {
      if (harnessIds.length === 0) throw new Error(t("marketplace.install.noHarness"))
      const change = await server.marketplace.setActivation({
        pluginInstanceId: props.plugin.pluginInstanceId,
        harnessIds,
        choice: true,
        revision: props.revision,
      })
      if (change.reconciliation.state === "failed") {
        showToast({
          title: t("marketplace.install.syncPending", { name: pluginLabel(props.plugin) }),
          description: change.reconciliation.message ?? t("marketplace.install.syncLater"),
        })
      }
      props.done()
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, install }
}

export function InstallPluginSheet(props: {
  readonly plugin: PluginCandidate
  readonly revision: number
  readonly supportedHarnesses: readonly PluginHarness[]
  readonly onDone: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const dialog = useDialog()
  const rows = () => harnessRows(props.plugin, props.supportedHarnesses)
  const [selected, setSelected] = createSignal(
    new Set(
      rows()
        .filter((row) => row.available)
        .map((row) => row.harnessId),
    ),
  )
  const finish = () => {
    props.onDone()
    dialog.close()
  }
  const sheet = createInstall({ plugin: props.plugin, revision: props.revision, done: finish })
  return (
    <Dialog fit containerClass="install-sheet-container">
      <DialogHeader>
        <DialogTitle>
          <SheetHeader plugin={props.plugin} />
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col px-4 pb-4">
        <InstallPlacement />
        <InstallHarnesses rows={rows()} selected={selected()} onChange={setSelected} />
        <Show when={sheet.error()}>
          {(message) => (
            <div role="alert" class="py-2 text-13-regular text-icon-critical-base">
              {message()}
            </div>
          )}
        </Show>
        <footer class="flex items-center justify-between gap-2 border-t border-border-weak-base pt-3">
          <span class="text-12-regular text-text-weaker">{t("marketplace.install.stepCount")}</span>
          <div class="flex gap-2">
            <Button size="large" variant="neutral" disabled={sheet.busy()} onClick={finish}>
              {t("marketplace.cancel")}
            </Button>
            <Button
              size="large"
              variant="contrast"
              disabled={sheet.busy()}
              onClick={() => void sheet.install([...selected()])}
            >
              {sheet.busy() ? t("marketplace.install.adding") : t("marketplace.install.add")}
            </Button>
          </div>
        </footer>
      </DialogBody>
    </Dialog>
  )
}

export function useInstallSheet() {
  const dialog = useDialog()
  return (plugin: PluginCandidate, revision: number, supportedHarnesses: readonly PluginHarness[]) =>
    new Promise<void>((resolve) => {
      void dialog.show(() => (
        <InstallPluginSheet
          plugin={plugin}
          revision={revision}
          supportedHarnesses={supportedHarnesses}
          onDone={resolve}
        />
      ))
    })
}
