import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import type { PluginApi, WorkbenchTab, WorkbenchTabStatus } from "@claxedo/plugin-api"
import { Keybind } from "@claxedo/app-v2/ui"
import "./switcher.css"

const STATUS_KEYS: Readonly<Record<WorkbenchTabStatus, string>> = {
  idle: "compactTabs.status.idle",
  working: "compactTabs.status.working",
  attention: "compactTabs.status.attention",
  done: "compactTabs.status.done",
  failed: "compactTabs.status.failed",
}

function optionId(tab: WorkbenchTab): string {
  return `compact-tabs-${tab.index}`
}

export function Switcher(props: { readonly api: PluginApi; readonly close: () => void }): JSX.Element {
  const t = props.api.i18n.t
  const tabs = () => props.api.workbench.tabs()
  const [selected, setSelected] = createSignal(Math.max(0, tabs().findIndex((tab) => tab.active)))
  const current = () => tabs()[Math.min(selected(), tabs().length - 1)]
  let list: HTMLUListElement | undefined

  const step = (delta: number) => {
    const count = tabs().length
    if (count > 0) setSelected((index) => (index + delta + count) % count)
  }
  const switchTo = (tab: WorkbenchTab | undefined) => {
    if (!tab) return
    props.api.workbench.activate(tab.id)
    props.close()
  }
  const closeTab = (tab: WorkbenchTab | undefined) => {
    if (tab) props.api.workbench.close(tab.id)
  }
  const keys: Readonly<Record<string, () => void>> = {
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
    Tab: () => step(1),
    Enter: () => switchTo(current()),
    Delete: () => closeTab(current()),
    Backspace: () => closeTab(current()),
    Escape: () => props.close(),
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const action = keys[event.shiftKey && event.key === "Tab" ? "ArrowUp" : event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  onMount(() => list?.focus())

  return (
    <div class="compact-tabs" role="dialog" aria-modal="true" aria-label={t("compactTabs.title")}>
      <Show when={tabs().length > 0} fallback={<p class="compact-tabs-empty">{t("compactTabs.empty")}</p>}>
        <ul
          ref={list}
          class="compact-tabs-list"
          role="listbox"
          tabindex="0"
          aria-label={t("compactTabs.list")}
          aria-activedescendant={current() ? optionId(current()!) : undefined}
          onKeyDown={onKeyDown}
          onFocusOut={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.close()
          }}
        >
          <For each={tabs()}>
            {(tab) => (
              <li
                id={optionId(tab)}
                class="compact-tabs-option"
                role="option"
                aria-selected={current()?.id === tab.id}
                data-status={tab.status}
                onClick={() => switchTo(tab)}
              >
                <span class="compact-tabs-dot" aria-hidden="true" />
                <span class="compact-tabs-title">{tab.title}</span>
                <span class="compact-tabs-status">{t(STATUS_KEYS[tab.status])}</span>
                <Show when={tab.active}>
                  <span class="compact-tabs-current">{t("compactTabs.current")}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="compact-tabs-hints" aria-hidden="true">
        <Keybind keys={["↵"]} variant="ghost" /> {t("compactTabs.hint.switch")}
        <Keybind keys={["⌫"]} variant="ghost" /> {t("compactTabs.hint.close")}
        <Keybind keys={["Esc"]} variant="ghost" /> {t("compactTabs.hint.dismiss")}
      </div>
    </div>
  )
}
