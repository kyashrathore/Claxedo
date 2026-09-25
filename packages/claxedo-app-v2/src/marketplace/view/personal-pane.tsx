import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { marketplaceDictionary } from "../i18n"
import type { PersonalEntry } from "../sections"
import { PluginIconTile } from "./plugin-icon"

const HARNESS_LABEL: Record<Exclude<PersonalEntry["harnessId"], "agents">, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  opencode: "OpenCode",
}

function PersonalFacts(props: { readonly entry: PersonalEntry; readonly harness: string }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const marketplace = () => (props.entry.kind === "plugin" ? props.entry.marketplace : undefined)
  const kind = () =>
    t(props.entry.kind === "skill" ? "marketplace.personal.kindSkill" : "marketplace.personal.kindPlugin")
  return (
    <dl class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular">
      <dt class="text-text-weak">{t("marketplace.personal.harness")}</dt>
      <dd class="text-text-base">{props.harness}</dd>
      <dt class="text-text-weak">{t("marketplace.personal.kind")}</dt>
      <dd class="text-text-base">{kind()}</dd>
      <Show when={marketplace()}>
        {(value) => (
          <>
            <dt class="text-text-weak">{t("marketplace.personal.marketplace")}</dt>
            <dd class="text-text-base">{value()}</dd>
          </>
        )}
      </Show>
      <dt class="text-text-weak">{t("marketplace.personal.location")}</dt>
      <dd class="break-all text-12-mono text-text-base">{props.entry.root}</dd>
    </dl>
  )
}

export function PersonalPane(props: { readonly entry: PersonalEntry; readonly onClose: () => void }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const harness = () =>
    props.entry.harnessId === "agents" ? t("marketplace.personal.agentsHarness") : HARNESS_LABEL[props.entry.harnessId]
  const version = () => (props.entry.kind === "plugin" ? props.entry.version : undefined)
  const installedBy = () =>
    version()
      ? t("marketplace.personal.installedByVersion", { version: version() ?? "", harness: harness() })
      : t("marketplace.personal.installedBy", { harness: harness() })
  const manages = () =>
    t(props.entry.kind === "skill" ? "marketplace.personal.managesSkill" : "marketplace.personal.managesPlugin", {
      harness: harness(),
    })
  return (
    <aside
      aria-label={t("marketplace.details", { name: props.entry.name })}
      class="flex h-full min-h-0 flex-col overflow-auto border-l border-border-weak-base bg-surface-base"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        props.onClose()
      }}
    >
      <header class="grid grid-cols-[3rem_1fr_auto] items-start gap-3 border-b border-border-weak-base p-4">
        <PluginIconTile name={props.entry.name} size="pane" />
        <div class="min-w-0">
          <h3 class="truncate text-14-medium text-text-strong">{props.entry.name}</h3>
          <p class="text-12-regular text-text-weak">{installedBy()}</p>
        </div>
        <button
          type="button"
          aria-label={t("marketplace.close")}
          onClick={() => props.onClose()}
          class="rounded px-1.5 text-text-weak hover:bg-surface-base-hover hover:text-text-strong"
        >
          ×
        </button>
      </header>
      <PersonalFacts entry={props.entry} harness={harness()} />
      <p class="px-4 py-3 text-12-regular text-text-weak">{manages()}</p>
    </aside>
  )
}
