import { createSignal, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { createDraftPlacementResolver, NewSessionContextRow, type WhereCreation } from "@/projects"
import { toAppError, useServer, type PlacementId } from "@/server"
import type { PaneProps } from "@/shell"
import { ClaxedoIcon, ClaxedoLogo } from "@/ui"
import { useWorkbench } from "@/workbench"
import { useTerminalRuntime } from "../context"
import { terminalCreatorPaneKind } from "../creator-pane"
import { terminalDictionary } from "../i18n"
import { terminalLaunchers, type TerminalLauncher } from "../launchers"
import "./terminal-creator.css"

export type TerminalCreatorState = { readonly placementId: PlacementId }

function LauncherTile(props: {
  readonly launcher: TerminalLauncher
  readonly index: number
  readonly starting: string | undefined
  readonly onLaunch: (launcher: TerminalLauncher) => void
}): JSX.Element {
  const t = useTranslator(terminalDictionary)
  return (
    <button
      type="button"
      data-launcher-id={props.launcher.id}
      disabled={!!props.starting}
      onClick={() => props.onLaunch(props.launcher)}
      style={{ "--terminal-launcher-index": String(props.index) }}
      class="ui-terminal-launcher group/launcher flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-border-base bg-surface-base-active px-3 py-2.5 text-left shadow-sm transition-[background-color,border-color,transform] hover:border-border-strong-base hover:bg-surface-base-hover focus-visible:bg-surface-base-hover active:translate-y-px disabled:cursor-default disabled:opacity-50"
    >
      <span class="flex w-full items-center gap-2">
        <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised-base text-icon-base">
          <ClaxedoIcon name={props.launcher.icon} size="small" />
        </span>
        <span class="truncate text-compact font-medium text-text-base">{props.launcher.name}</span>
        <span
          aria-hidden="true"
          class="ml-auto shrink-0 text-xs text-v2-text-text-faint opacity-0 transition-opacity group-hover/launcher:opacity-100 group-focus-visible/launcher:opacity-100"
        >
          ↵
        </span>
      </span>
      <span class="w-full truncate text-2xs text-v2-text-text-faint">
        {props.starting === props.launcher.id ? t("terminal.creator.starting") : t(props.launcher.description)}
      </span>
    </button>
  )
}

function LauncherGrid(props: {
  readonly placementId: PlacementId
  readonly starting: string | undefined
  readonly onLaunch: (launcher: TerminalLauncher) => void
}): JSX.Element {
  const t = useTranslator(terminalDictionary)
  const server = useServer()
  const agents = useQuery(() => server.queries.terminals.agents(props.placementId))
  const launchers = () => terminalLaunchers(t("terminal.creator.shell"), agents.data ?? [])
  return (
    <>
      <div class="grid gap-2 p-3" style={{ "grid-template-columns": "repeat(auto-fill, minmax(9.5rem, 1fr))" }}>
        <For each={launchers()}>
          {(launcher, index) => (
            <LauncherTile launcher={launcher} index={index()} starting={props.starting} onLaunch={props.onLaunch} />
          )}
        </For>
      </div>
      <Show when={agents.isPending || agents.isError}>
        <div class="px-3.5 pb-2.5 text-xs text-v2-text-text-faint">
          {t(agents.isError ? "terminal.creator.agentsFailed" : "terminal.creator.agentsLoading")}
        </div>
      </Show>
    </>
  )
}

export function TerminalCreator(props: PaneProps<TerminalCreatorState>): JSX.Element {
  const t = useTranslator(terminalDictionary)
  const errorCopy = useErrorCopy()
  const runtime = useTerminalRuntime()
  const server = useServer()
  const workbench = useWorkbench()
  const projectId = () => server.placements.byId(props.state.placementId)?.projectId
  const [starting, setStarting] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [creating, setCreating] = createSignal<WhereCreation>()
  const draft = createDraftPlacementResolver()
  const launch = async (launcher: TerminalLauncher) => {
    if (starting()) return
    setStarting(launcher.id)
    setError(undefined)
    try {
      const project = projectId()
      const placementId = project
        ? await draft.resolve({ projectId: project, placementId: props.state.placementId })
        : props.state.placementId
      const terminal = await runtime.store(placementId).create({ command: launcher.command, title: launcher.title })
      runtime.open({ placementId, terminalId: terminal.id }, props.paneId)
    } catch (cause) {
      setError(errorCopy(toAppError(cause)).message)
    } finally {
      setStarting(undefined)
    }
  }
  return (
    <div data-testid="terminal-creator" class="relative size-full overflow-hidden bg-background-base">
      <div class="absolute inset-x-0 top-[34%] flex justify-center px-6">
        <div class="w-full max-w-[720px]">
          <div class="mb-5 flex justify-center">
            <ClaxedoLogo class="w-12 opacity-14" />
          </div>
          <Show when={projectId()}>
            {(project) => (
              <div class="relative">
                <NewSessionContextRow
                  projectId={project()}
                  placementId={props.state.placementId}
                  branch={false}
                  resolver={draft}
                  onCreatingChange={setCreating}
                  onOpen={(target) =>
                    workbench.replacePane(props.paneId, terminalCreatorPaneKind, { placementId: target.placementId })
                  }
                />
              </div>
            )}
          </Show>
          <div class="relative z-10 -mt-2">
            <div
              data-component="terminal-new-launchers"
              class="w-full overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base"
            >
              <div class="flex items-center gap-2 border-b border-border-weaker-base px-3.5 py-2.5">
                <ClaxedoIcon name="terminal" size="small" class="text-icon-weak-base" />
                <span class="text-sm font-medium text-text-weak">{t("terminal.creator.title")}</span>
          <Show when={creating()}>
            {(kind) => (
              <span class="truncate text-xs text-v2-text-text-faint">
                {t(kind() === "cloud" ? "terminal.creator.inNewCloudWorkspace" : "terminal.creator.inNewWorktree")}
              </span>
            )}
          </Show>
              </div>
              <LauncherGrid placementId={props.state.placementId} starting={starting()} onLaunch={(next) => void launch(next)} />
              <Show when={error()}>
                {(message) => (
                  <div
                    class="border-t border-border-weaker-base px-3.5 py-2.5 text-xs text-icon-critical-base"
                  >
                    {message()}
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
