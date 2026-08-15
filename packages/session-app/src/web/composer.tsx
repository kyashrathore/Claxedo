/**
 * The parity composer — implements docs/visual-spec.md §5 (dock region, card
 * chrome, editor block, toolbar chips, dropdown surfaces) in Solid 2, driven
 * directly by the core's `SessionModel`/`dispatch`.
 *
 * DOM structure, class vocabulary, and data-action names follow the real app
 * (the main repo's e2e selectors — [data-action="prompt-permission-mode"],
 * [data-action="prompt-harness-model"], [data-action="prompt-submit"] — work
 * against this composer unchanged).
 */

import { For, Show, createSignal, createEffect, type JSX } from "solid-js"
import type { SessionModel, SessionMsg } from "../core/model"

type Dispatch = (msg: SessionMsg) => void

export function Composer(props: { model: SessionModel; dispatch: Dispatch }) {
  let editor: HTMLDivElement | undefined
  const composer = () => props.model.composer

  const selectedModel = () =>
    composer().models.find(
      (model) =>
        model.providerID === composer().selectedModel?.providerID &&
        model.modelID === composer().selectedModel?.modelID,
    )
  const modelLabel = () => {
    if (composer().models.length === 0 && composer().selectedHarness) return "Loading models"
    return selectedModel()?.name ?? "Select model"
  }
  const modeLabel = () =>
    composer().permissionModes.find((mode) => mode.id === composer().selectedMode)?.name ?? "Permissions"
  const effortLabel = () =>
    composer().efforts.find((effort) => effort.id === composer().selectedEffort)?.name ?? composer().selectedEffort

  // Solid 2 effect form: compute tracks, apply performs.
  createEffect(
    () => props.model.draft,
    (draft) => {
      if (editor && draft === "" && editor.textContent !== "") editor.textContent = ""
    },
  )

  return (
    <div data-component="session-prompt-dock" class="prompt-dock">
      <div class="prompt-dock-inner">
        <div data-component="composer-frame" class="composer-frame">
          <form
            data-component="session-composer"
            data-dock-surface="shell"
            data-surface="composer"
            data-dock-border-underlay="v2"
            class="composer-card"
            onSubmit={(event) => {
              event.preventDefault()
              props.dispatch({ type: "SubmitPrompt" })
            }}
          >
            <div class="composer-editor-shell" onMouseDown={() => editor?.focus()}>
              <div class="composer-editor-scroll">
                <div
                  ref={editor}
                  data-component="prompt-input"
                  contenteditable={!props.model.sending}
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Ask anything, / for commands, @ for context..."
                  class="composer-editor"
                  onInput={(event) => props.dispatch({ type: "DraftEdited", text: event.currentTarget.textContent ?? "" })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      props.dispatch({ type: "SubmitPrompt" })
                    }
                  }}
                />
                <Show when={props.model.draft === ""}>
                  <div data-component="session-composer-text" class="composer-placeholder">
                    Ask anything, / for commands, @ for context...
                  </div>
                </Show>
              </div>
            </div>

            <div data-slot="composer-toolbar" class="composer-toolbar">
              <div data-slot="composer-controls" class="composer-controls">
                <AddMenu />
                <PermissionChip model={props.model} dispatch={props.dispatch} label={modeLabel()} />
                <ProjectChip model={props.model} dispatch={props.dispatch} />
                <WorktreeChip model={props.model} dispatch={props.dispatch} />
                <div data-slot="composer-selection-controls" class="composer-selection-controls">
                  <HarnessModelPicker
                    model={props.model}
                    dispatch={props.dispatch}
                    label={modelLabel()}
                    effortLabel={effortLabel()}
                  />
                </div>
              </div>
              <button
                type="submit"
                data-action="prompt-submit"
                aria-label="Send"
                class="composer-submit"
                disabled={props.model.sending || props.model.draft.trim() === ""}
              >
                <SendIcon />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

/** Shared dismissal + open-state plumbing for the toolbar menus. */
function useMenu() {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined
  createEffect(
    () => open(),
    (isOpen) => {
      if (!isOpen) return
      const onPointer = (event: PointerEvent) => {
        if (root && !root.contains(event.target as Node)) setOpen(false)
      }
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpen(false)
      }
      document.addEventListener("pointerdown", onPointer)
      document.addEventListener("keydown", onKey)
      return () => {
        document.removeEventListener("pointerdown", onPointer)
        document.removeEventListener("keydown", onKey)
      }
    },
  )
  return { open, setOpen, setRoot: (el: HTMLDivElement) => (root = el) }
}

function MenuItem(props: {
  label: string
  detail?: string | undefined
  checked?: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      class="menu-item"
      data-checked={props.checked ? "" : undefined}
      disabled={props.disabled}
      onClick={() => props.onSelect()}
    >
      <span class="menu-item-text">
        <span class="menu-item-label">{props.label}</span>
        <Show when={props.detail}>
          <span class="menu-item-detail">{props.detail}</span>
        </Show>
      </span>
      <span data-slot="menu-v2-item-indicator" class="menu-item-check">{props.checked ? "✓" : ""}</span>
    </button>
  )
}

function AddMenu() {
  const menu = useMenu()
  const items = [
    { action: "prompt-attach", label: "Images and files", hint: "⌘U" },
    { action: "prompt-commands", label: "Commands", hint: "/" },
    { action: "prompt-context", label: "Context", hint: "@" },
    { action: "prompt-shell-mode", label: "Shell command", hint: "!" },
  ]
  return (
    <div class="menu-root" ref={menu.setRoot}>
      <button
        type="button"
        data-action="prompt-add"
        aria-label="Add"
        aria-haspopup="true"
        data-expanded={menu.open() ? "" : undefined}
        class="composer-add"
        onClick={() => menu.setOpen(!menu.open())}
      >
        <PlusIcon />
      </button>
      <Show when={menu.open()}>
        <div class="claxedo-composer-menu menu-surface" role="menu">
          <div class="menu-group-header">Add</div>
          <For each={items}>{(item) => (
            <button type="button" role="menuitem" class="menu-item" data-action={item.action} onClick={() => menu.setOpen(false)}>
              <span class="menu-item-label">{item.label}</span>
              <span class="menu-item-hint">{item.hint}</span>
            </button>
          )}</For>
        </div>
      </Show>
    </div>
  )
}

function PermissionChip(props: { model: SessionModel; dispatch: Dispatch; label: string }) {
  const menu = useMenu()
  const composer = () => props.model.composer
  const active = () => composer().selectedMode !== undefined
  return (
    <Show when={composer().modesUnsupported === undefined && composer().permissionModes.length > 0}>
      <div class="menu-root" ref={menu.setRoot}>
        <button
          type="button"
          data-action="prompt-permission-mode"
          data-mode={composer().selectedMode}
          aria-haspopup="true"
          data-expanded={menu.open() ? "" : undefined}
          class="composer-chip"
          data-active={active() ? "" : undefined}
          onClick={() => menu.setOpen(!menu.open())}
        >
          <ShieldIcon active={active()} />
          <span data-slot="composer-control-label" class="composer-chip-label">{props.label}</span>
        </button>
        <Show when={menu.open()}>
          <div class="claxedo-composer-menu menu-surface" role="menu">
            <For each={composer().permissionModes}>{(mode) => (
              <MenuItem
                label={mode.name}
                detail={mode.description}
                checked={mode.id === composer().selectedMode}
                onSelect={() => {
                  props.dispatch({ type: "SelectMode", modeId: mode.id })
                  menu.setOpen(false)
                }}
              />
            )}</For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function ProjectChip(props: { model: SessionModel; dispatch: Dispatch }) {
  const menu = useMenu()
  const composer = () => props.model.composer
  const selected = () =>
    composer().workspaces.find((workspace) => workspace.directory === (composer().selectedWorkspace ?? props.model.directory))
  const label = () => selected()?.name ?? basename(composer().selectedWorkspace ?? props.model.directory)
  return (
    <Show when={composer().workspaces.length > 0}>
      <div class="menu-root" ref={menu.setRoot}>
        <button
          type="button"
          data-action="prompt-project"
          aria-haspopup="true"
          data-expanded={menu.open() ? "" : undefined}
          class="composer-chip"
          onClick={() => menu.setOpen(!menu.open())}
        >
          <FolderIcon />
          <span data-slot="composer-control-label" class="composer-chip-label">{label()}</span>
        </button>
        <Show when={menu.open()}>
          <div class="claxedo-composer-menu menu-surface" role="menu">
            <For each={["local", "cloud", "user-hosted"].filter((access) => composer().workspaces.some((w) => w.access === access))}>{(access) => (
              <>
                <div class="menu-group-header">{access.toUpperCase()}</div>
                <For each={composer().workspaces.filter((workspace) => workspace.access === access)}>{(workspace) => (
                  <MenuItem
                    label={workspace.name ?? basename(workspace.directory)}
                    detail={workspace.directory}
                    checked={workspace.directory === (composer().selectedWorkspace ?? props.model.directory)}
                    onSelect={() => {
                      props.dispatch({ type: "SelectWorkspace", directory: workspace.directory })
                      menu.setOpen(false)
                    }}
                  />
                )}</For>
              </>
            )}</For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function WorktreeChip(props: { model: SessionModel; dispatch: Dispatch }) {
  const menu = useMenu()
  const [naming, setNaming] = createSignal(false)
  const composer = () => props.model.composer
  const label = () => (composer().selectedWorktree ? basename(composer().selectedWorktree!) : "Worktree")
  return (
    <Show when={composer().worktrees.length > 0 || composer().selectedWorkspace !== undefined}>
      <div class="menu-root" ref={menu.setRoot}>
        <button
          type="button"
          data-action="prompt-worktree"
          aria-haspopup="true"
          data-expanded={menu.open() ? "" : undefined}
          class="composer-chip"
          onClick={() => menu.setOpen(!menu.open())}
        >
          <BranchIcon />
          <span data-slot="composer-control-label" class="composer-chip-label">
            {composer().creatingWorktree ? "Creating…" : label()}
          </span>
        </button>
        <Show when={menu.open()}>
          <div class="claxedo-composer-menu menu-surface" role="menu">
            <Show
              when={!naming()}
              fallback={
                <div class="inline-prompt">
                  <input
                    class="inline-prompt-input"
                    placeholder="worktree name"
                    ref={(el) => setTimeout(() => el.focus())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        props.dispatch({ type: "CreateWorktree", name: event.currentTarget.value.trim() || undefined })
                        setNaming(false)
                        menu.setOpen(false)
                      }
                      if (event.key === "Escape") setNaming(false)
                    }}
                  />
                </div>
              }
            >
              <For each={composer().worktrees}>{(worktree) => (
                <MenuItem
                  label={basename(worktree)}
                  detail={worktree}
                  checked={worktree === composer().selectedWorktree}
                  onSelect={() => {
                    props.dispatch({ type: "SelectWorktree", directory: worktree })
                    menu.setOpen(false)
                  }}
                />
              )}</For>
              <div class="menu-separator" />
              <button type="button" role="menuitem" class="menu-item menu-footer-action" onClick={() => setNaming(true)}>
                + New worktree
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function HarnessModelPicker(props: {
  model: SessionModel
  dispatch: Dispatch
  label: string
  effortLabel?: string | undefined
}) {
  const menu = useMenu()
  const [section, setSection] = createSignal<"harness" | "model" | "effort">("model")
  const composer = () => props.model.composer
  const providers = () => [...new Set(composer().models.map((model) => model.providerID))]

  return (
    <div class="menu-root" ref={menu.setRoot}>
      <button
        type="button"
        data-action="prompt-harness-model"
        data-harness={composer().selectedHarness}
        data-model={composer().selectedModel?.modelID}
        data-provider={composer().selectedModel?.providerID}
        aria-haspopup="true"
        data-expanded={menu.open() ? "" : undefined}
        class="composer-chip composer-harness-model"
        onClick={() => menu.setOpen(!menu.open())}
      >
        <span data-slot="composer-control-label" class="composer-chip-label">{props.label}</span>
        <Show when={props.effortLabel && composer().efforts.length > 1}>
          <span class="composer-chip-effort">{props.effortLabel}</span>
        </Show>
        <ChevronDownIcon />
      </button>
      <Show when={menu.open()}>
        <div
          class="claxedo-composer-menu claxedo-composer-menu-picker menu-surface harness-picker-surface"
          data-component="harness-model-picker"
          role="menu"
        >
          <button type="button" class="picker-section-header" data-open={section() === "harness" ? "" : undefined} onClick={() => setSection("harness")}>
            Harness
          </button>
          <Show when={section() === "harness"}>
            <div class="picker-section-body">
              <For each={composer().harnesses}>{(harness) => (
                <MenuItem
                  label={harness.name}
                  checked={harness.id === composer().selectedHarness}
                  onSelect={() => {
                    props.dispatch({ type: "SelectHarness", harness: harness.id })
                    setSection("model")
                  }}
                />
              )}</For>
            </div>
          </Show>
          <button type="button" class="picker-section-header" data-open={section() === "model" ? "" : undefined} onClick={() => setSection("model")}>
            Model
          </button>
          <Show when={section() === "model"}>
            <div class="picker-section-body picker-section-models">
              <For each={providers()}>{(provider) => (
                <>
                  <div class="menu-group-header menu-group-sticky">{provider}</div>
                  <For each={composer().models.filter((model) => model.providerID === provider)}>{(model) => (
                    <MenuItem
                      label={model.name}
                      checked={
                        model.providerID === composer().selectedModel?.providerID &&
                        model.modelID === composer().selectedModel?.modelID
                      }
                      onSelect={() => {
                        props.dispatch({ type: "SelectModel", model: { providerID: model.providerID, modelID: model.modelID } })
                        menu.setOpen(false)
                      }}
                    />
                  )}</For>
                </>
              )}</For>
            </div>
          </Show>
          <button type="button" class="picker-section-header" data-open={section() === "effort" ? "" : undefined} onClick={() => setSection("effort")}>
            Effort
          </button>
          <Show when={section() === "effort"}>
            <div class="picker-section-body">
              <Show when={composer().efforts.length > 0} fallback={<div class="picker-prose">The selected model has one thought level.</div>}>
                <For each={composer().efforts}>{(effort) => (
                  <MenuItem
                    label={effort.name}
                    checked={effort.id === composer().selectedEffort}
                    onSelect={() => {
                      props.dispatch({ type: "SelectEffort", effort: effort.id })
                      menu.setOpen(false)
                    }}
                  />
                )}</For>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  )
}

function ShieldIcon(props: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" class={props.active ? "icon-active" : "icon-muted"}>
      <path d="M7 1.5 2.5 3.2v3.2c0 2.9 1.9 5 4.5 6.1 2.6-1.1 4.5-3.2 4.5-6.1V3.2L7 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="icon-muted">
      <path d="M1.8 3.4c0-.5.4-.9.9-.9h2.6l1.2 1.4h4.8c.5 0 .9.4.9.9v5.8c0 .5-.4.9-.9.9H2.7a.9.9 0 0 1-.9-.9V3.4Z" stroke="currentColor" stroke-width="1.1" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="icon-muted">
      <circle cx="3.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.1" />
      <circle cx="3.5" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.1" />
      <circle cx="10.5" cy="5" r="1.6" stroke="currentColor" stroke-width="1.1" />
      <path d="M3.5 5.1v3.8M8.9 5.6c-2 .7-3.6 1.3-4.6 3.1" stroke="currentColor" stroke-width="1.1" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" class="icon-muted">
      <path d="m3.5 5.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

function SendIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 14V4m0 0L4.5 8.5M9 4l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
