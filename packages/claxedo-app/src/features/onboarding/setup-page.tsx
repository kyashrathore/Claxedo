import { For, Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import type { OnboardingStepId } from "./registry"
import { stepPosition, type SetupLocation, type SetupStepView } from "./navigation"
import "./setup-page.css"

export type SetupPageStep = SetupStepView & {
  title: string
}

export type SetupPageProps = {
  steps: readonly SetupPageStep[]
  location: SetupLocation
  /** Eyebrow line above the title. Defaults to "Step N of M". */
  eyebrow?: string
  title: string
  lede?: string
  children: JSX.Element
  /**
   * Primary action. Omit on screens whose body owns its own submit — the nav
   * row still renders a disabled Next, so the frame never changes shape.
   */
  primary?: { label: string; disabled?: boolean; busy?: boolean; hint?: string; onClick: () => void }
  /**
   * Why the disabled Next cannot be pressed yet, as a hover title. A dead
   * button with no explanation is the thing this row must not become.
   */
  nextHint?: string
  /** Skip label must state its consequence, e.g. "Skip — add compute later". */
  skip?: { label: string; onClick: () => void }
  back?: () => void
  onSelectStep?: (id: OnboardingStepId) => void
}

export function SetupPage(props: SetupPageProps) {
  const position = () => stepPosition(props.steps, props.location)
  const activeId = () => (props.location.kind === "step" ? props.location.step : undefined)
  // The header already counts the steps. Repeating "Step 1 of 2" directly above
  // the title says nothing new, so the eyebrow names the step's *purpose* and is
  // otherwise absent.
  const eyebrow = () => props.eyebrow
  // Position-based, so the rail always tells the same story as "Step N of M".
  // A done step AFTER the current one must not light up ahead of the user —
  // a filled segment reads as progress reached, whatever the checklist says.
  const segmentState = (step: SetupPageStep, index: number) => {
    const at = props.steps.findIndex((item) => item.id === activeId())
    if (step.id === activeId()) return "current"
    if (at !== -1 && index < at) return "done"
    if (at === -1 && step.done) return "done"
    if (step.locked) return "locked"
    return "upcoming"
  }

  return (
    <div class="setup-page" data-component="setup-page" data-step={activeId() ?? "done"}>
      <header class="setup-header">
        <div class="setup-header-inner">
          <h1 class="text-14-medium text-text-strong">Set up Claxedo</h1>
          <Show when={position()}>
            {(at) => (
              <span class="setup-counter text-12-regular">
                Step {at().index} of {at().total}
              </span>
            )}
          </Show>
        </div>
        {/*
          The rail is a progress indicator, not a menu. Its accessible name lives
          on the counter above; segments are decorative and clicking one is an
          affordance for going back, never for skipping ahead.
        */}
        <ol class="setup-rail" aria-hidden="true">
          <For each={props.steps}>
            {(step, index) => (
              <li
                class="setup-rail-segment"
                data-state={segmentState(step, index())}
                data-step={step.id}
                onClick={() => step.done && props.onSelectStep?.(step.id)}
              />
            )}
          </For>
        </ol>
      </header>

      <div class="setup-body" data-testid="setup-content-pane">
        <div class="setup-body-inner">
          {/* Keyed on the step so each screen replays its entrance. */}
          <Show when={props.location} keyed>
            <section class="setup-screen">
              <div>
                <Show when={eyebrow()}>{(text) => <span class="setup-eyebrow">{text()}</span>}</Show>
                <h2 class="setup-title">{props.title}</h2>
                <Show when={props.lede}>{(text) => <p class="setup-lede text-13-regular">{text()}</p>}</Show>
              </div>
              {props.children}
            </section>
          </Show>
        </div>
      </div>

      {/*
        The nav row never changes shape: Back and Next are always present and
        disable rather than disappear, so the frame stays still while the user
        moves through it. Skip is the one conditional — it only exists where
        skipping is a real choice.
      */}
      <div class="setup-actions">
        <div class="setup-actions-inner">
          <Button variant="ghost" icon="chevron-left" disabled={!props.back} onClick={() => props.back?.()}>
            Back
          </Button>
          <div class="setup-actions-end">
            <Show when={props.skip}>
              {(skip) => (
                <Button variant="ghost" onClick={() => skip().onClick()}>
                  {skip().label}
                </Button>
              )}
            </Show>
            <Show
              when={props.primary}
              fallback={
                <Button disabled title={props.nextHint}>
                  Next
                </Button>
              }
            >
              {(primary) => (
                <Button
                  disabled={primary().disabled || primary().busy}
                  title={primary().disabled ? (primary().hint ?? props.nextHint) : undefined}
                  onClick={() => primary().onClick()}
                >
                  {primary().busy ? "Working…" : primary().label}
                </Button>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A full-width option row: label, one line of consequence, trailing chevron. */
export function SetupOptionRow(props: { label: string; consequence: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="setup-row" disabled={props.disabled} onClick={() => props.onClick()}>
      <span class="setup-row-copy">
        <span class="text-13-medium text-text-strong">{props.label}</span>
        <span class="setup-row-consequence text-12-regular">{props.consequence}</span>
      </span>
      <Icon name="chevron-right" size="small" class="setup-row-chevron" />
    </button>
  )
}

export function SetupRows(props: { children: JSX.Element }) {
  return <div class="setup-rows">{props.children}</div>
}
