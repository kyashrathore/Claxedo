import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginHarness } from "@/server"
import { marketplaceDictionary, type MarketplaceKey } from "../i18n"

export type HarnessRow = {
  readonly harnessId: PluginHarness
  readonly available: boolean
  readonly reason?: { readonly key: MarketplaceKey } | { readonly text: string }
}

export function harnessRows(plugin: PluginCandidate, supported: readonly PluginHarness[]): HarnessRow[] {
  return supported.map((harnessId): HarnessRow => {
    const activation = plugin.harnesses[harnessId] as PluginCandidate["harnesses"][PluginHarness] | undefined
    if (!activation) return { harnessId, available: false, reason: { key: "marketplace.install.notServed" } }
    if (activation.effective.status !== "artifact-unavailable") return { harnessId, available: true }
    const reason = plugin.artifactError
      ? { text: plugin.artifactError }
      : { key: "marketplace.install.artifactUnavailable" as const }
    return { harnessId, available: false, reason }
  })
}

function optionClass(selected: boolean, disabled: boolean) {
  return [
    "grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-lg border bg-surface-raised-base px-2.5 py-2.5",
    selected ? "border-border-interactive-base" : "border-border-weak-base",
    disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
  ].join(" ")
}

function Environment(props: { readonly title: string; readonly detail: string }): JSX.Element {
  return (
    <label class={optionClass(false, true)}>
      <input type="checkbox" checked disabled />
      <span>
        <span class="block text-13-medium text-text-strong">{props.title}</span>
        <span class="block text-12-regular text-text-weak">{props.detail}</span>
      </span>
    </label>
  )
}

export function InstallPlacement(): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <>
      <section
        class="flex flex-col gap-2.5 border-b border-border-weak-base py-3"
        aria-label={t("marketplace.install.environments")}
      >
        <div class="flex items-baseline justify-between gap-2">
          <h4 class="text-13-medium text-text-strong">{t("marketplace.install.environments")}</h4>
          <span class="text-11-regular text-text-weaker">{t("marketplace.install.bothAlways")}</span>
        </div>
        <p class="text-12-regular text-text-weak">{t("marketplace.install.environmentsNote")}</p>
        <div class="grid grid-cols-2 gap-1.5">
          <Environment title={t("marketplace.install.machines")} detail={t("marketplace.install.machinesDetail")} />
          <Environment title={t("marketplace.install.cloud")} detail={t("marketplace.install.cloudDetail")} />
        </div>
      </section>
      <section
        class="flex flex-col gap-2.5 border-b border-border-weak-base py-3"
        aria-label={t("marketplace.install.projects")}
      >
        <h4 class="text-13-medium text-text-strong">{t("marketplace.install.projects")}</h4>
        <p class="text-12-regular text-text-weak">{t("marketplace.install.everyProject")}</p>
      </section>
    </>
  )
}

export function InstallHarnesses(props: {
  readonly rows: readonly HarnessRow[]
  readonly selected: ReadonlySet<PluginHarness>
  readonly onChange: (next: Set<PluginHarness>) => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const reason = (row: HarnessRow) =>
    row.reason ? ("key" in row.reason ? t(row.reason.key) : row.reason.text) : undefined
  const toggle = (harnessId: PluginHarness, on: boolean) => {
    const next = new Set(props.selected)
    if (on) next.add(harnessId)
    else next.delete(harnessId)
    props.onChange(next)
  }
  return (
    <section class="flex flex-col gap-2.5 py-3" aria-label={t("marketplace.install.harnesses")}>
      <h4 class="text-13-medium text-text-strong">{t("marketplace.install.harnesses")}</h4>
      <p class="text-12-regular text-text-weak">{t("marketplace.install.harnessesNote")}</p>
      <div class="flex flex-wrap gap-2">
        <For each={props.rows}>
          {(row) => (
            <label
              class="inline-flex items-center gap-1.5 rounded-lg border border-border-weak-base bg-surface-raised-base px-2.5 py-1.5 text-13-regular text-text-base"
              classList={{ "cursor-not-allowed opacity-55": !row.available }}
              title={reason(row)}
            >
              <input
                type="checkbox"
                checked={props.selected.has(row.harnessId)}
                disabled={!row.available}
                onChange={(event) => toggle(row.harnessId, event.currentTarget.checked)}
              />
              {row.harnessId}
              <Show when={reason(row)}>{(text) => <span class="text-11-regular text-text-weaker">{text()}</span>}</Show>
            </label>
          )}
        </For>
      </div>
    </section>
  )
}
