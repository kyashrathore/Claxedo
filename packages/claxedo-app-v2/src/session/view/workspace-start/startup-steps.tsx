import { For, Match, Show, Switch, type ParentProps } from "solid-js"
import type { WorkspaceBootMode } from "@/server"
import type { SessionScreenText } from "../text"

type StepState = "active" | "pending"

function firstStep(t: SessionScreenText, bootMode: WorkspaceBootMode | undefined) {
  if (bootMode === "restore") return t("sessionScreen.workspace.step.restoring")
  if (bootMode === "resume") return t("sessionScreen.workspace.step.resuming")
  return t("sessionScreen.workspace.step.acquiring")
}

function StepRow(props: ParentProps<{ readonly state: StepState; readonly connector: boolean }>) {
  return (
    <div class="relative grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 py-2">
      <Show when={props.connector}>
        <span class="absolute left-[9.5px] top-7 h-4 w-px bg-border-weak-base/45" aria-hidden="true" />
      </Show>
      <span class="relative z-10 flex size-5 items-center justify-center">
        <Switch fallback={<span class="size-1.5 rounded-full bg-text-weaker/35" />}>
          <Match when={props.state === "active"}>
            <span
              class="size-3.5 rounded-full border-2 border-border-base border-t-text-base animate-spin motion-reduce:animate-none"
              style={{ "animation-duration": "0.7s" }}
            />
          </Match>
        </Switch>
      </span>
      {props.children}
    </div>
  )
}

export function StartupSteps(props: { readonly t: SessionScreenText; readonly bootMode?: WorkspaceBootMode }) {
  const steps = () => [
    firstStep(props.t, props.bootMode),
    props.t("sessionScreen.workspace.step.cloning"),
    props.t("sessionScreen.workspace.step.runtime"),
    props.t("sessionScreen.workspace.step.health"),
  ]
  return (
    <ol class="mt-6 flex flex-col text-compact" aria-label={props.t("sessionScreen.workspace.starting.title")}>
      <For each={steps()}>
        {(label, index) => (
          <li aria-current={index() === 0 ? "step" : undefined}>
            <StepRow connector={index() < steps().length - 1} state={index() === 0 ? "active" : "pending"}>
              <span class="truncate" classList={{ "text-text-base": index() === 0, "text-text-weaker/40": index() > 0 }}>
                {label}
              </span>
            </StepRow>
          </li>
        )}
      </For>
    </ol>
  )
}
