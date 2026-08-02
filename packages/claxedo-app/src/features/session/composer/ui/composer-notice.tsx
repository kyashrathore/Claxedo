// The composer's single error surface.
//
// Before this existed, a failing harness reported itself through four separate
// widgets crammed into the composer's control row: a readiness "Unavailable"
// pill, the model trigger's label ALSO reading "Unavailable", an unlabeled
// colored dot whose tooltip held the only real explanation, and a bare "Retry"
// button — plus a fifth raw-`configError` string underneath. They could stack,
// they ate three control slots, and the actual reason required a hover.
//
// Everything now publishes into one channel and renders as one row that peeks
// out above the composer stack (above the project/worktree context row on the
// new-session screen, above the composer card everywhere else). The row states
// the problem in words and carries its own action button.
//
// Publishing is deliberately a channel rather than props: the producer
// (`AgentHarnessSelector`) sits deep inside the composer toolbar, while the row
// renders outside the composer card entirely. Threading ~6 props up through
// toolbar → frame → composer → region → screen would couple five components to
// a detail none of them own.
import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"

export type ComposerNoticeTone = "critical" | "warning"

export type ComposerNotice = {
  /** Which condition produced this, for `data-notice` and tests. */
  kind: string
  tone: ComposerNoticeTone
  /** The whole message, in words. Readable without hovering anything. */
  message: string
  /** The runtime's own wording, if there is some. Truncates before `message` does. */
  detail?: string
  /**
   * Native `title`. Carries the full text for pointer users when the row is
   * squeezed, and preserves the selectors the harness e2e specs already assert.
   */
  title?: string
  action?: { label: string; ariaLabel?: string; run: () => void }
}

export type ComposerNoticeChannel = {
  current: Accessor<ComposerNotice | undefined>
  publish: (notice: ComposerNotice | undefined) => void
}

export function createComposerNoticeChannel(): ComposerNoticeChannel {
  const [current, setCurrent] = createSignal<ComposerNotice | undefined>()
  return { current, publish: (notice) => setCurrent(() => notice) }
}

const ComposerNoticeContext = createContext<ComposerNoticeChannel>()

export function ComposerNoticeProvider(props: { channel: ComposerNoticeChannel; children: JSX.Element }) {
  return <ComposerNoticeContext.Provider value={props.channel}>{props.children}</ComposerNoticeContext.Provider>
}

/**
 * The nearest channel, or undefined when the composer is rendered outside any
 * host (unit tests, storybook). Producers must tolerate its absence.
 */
export function useComposerNoticeChannel() {
  return useContext(ComposerNoticeContext)
}

/**
 * Publish a derived notice for as long as the calling component is alive.
 * Clears on unmount so a disposed composer cannot leave a stale row behind.
 */
export function publishComposerNotice(notice: Accessor<ComposerNotice | undefined>) {
  const channel = useComposerNoticeChannel()
  if (!channel) return
  createEffect(() => channel.publish(notice()))
  onCleanup(() => channel.publish(undefined))
}

/**
 * The peeking row. Uses the same stacked-card idiom as `SessionContextRow`:
 * rounded top, no bottom border, and more bottom padding than the content needs
 * — that extra padding is the lip that stays visible once the row below
 * overlaps it by `-mt-2`.
 */
export function ComposerNoticeRow(props: { notice: ComposerNotice | undefined; class?: string }) {
  return (
    <Show when={props.notice}>
      {(notice) => (
        <div
          data-component="composer-notice"
          data-notice={notice().kind}
          data-tone={notice().tone}
          // A settled failure interrupts; a soft warning does not.
          role={notice().tone === "critical" ? "alert" : "status"}
          aria-live={notice().tone === "critical" ? "assertive" : "polite"}
          title={notice().title ?? [notice().message, notice().detail].filter(Boolean).join(" — ")}
          class={
            "flex min-w-0 items-start gap-2 overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-3 pt-2 pb-4" +
            (props.class ? " " + props.class : "")
          }
        >
          <span
            aria-hidden="true"
            // Optically centred on the title's cap height, not on the whole
            // two-line block.
            class="mt-[6px] size-1.5 shrink-0 rounded-full"
            classList={{
              "bg-surface-critical-strong": notice().tone === "critical",
              "bg-surface-warning-strong": notice().tone === "warning",
            }}
          />
          {/* Title over description, not side by side. On one line a long detail
              (a config path, a stack line) competed with the message for width
              and squeezed it to "Could…" — the one part that must always be
              readable. Stacked, the title always gets the full row. */}
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span data-slot="composer-notice-message" class="truncate text-12-medium text-v2-text-text-base">
              {notice().message}
            </span>
            <Show when={notice().detail}>
              {(detail) => (
                <span
                  data-slot="composer-notice-detail"
                  // Two lines, then ellipsis: enough for a path plus the reason,
                  // without letting a stack trace grow the composer unbounded.
                  class="line-clamp-2 text-12-regular text-v2-text-text-faint"
                >
                  {detail()}
                </span>
              )}
            </Show>
          </div>
          <Show when={notice().action}>
            {(action) => (
              <button
                type="button"
                data-action="composer-notice-action"
                aria-label={action().ariaLabel ?? action().label}
                // Explicit height, not padding: the inherited button box is 40px
                // tall, which floated the label 8px below the title it sits beside.
                // h-5 matches the title's line box so the two read as one line.
                class="inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-12-medium text-v2-text-text-base transition-colors duration-150 hover:bg-surface-raised-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  action().run()
                }}
              >
                {action().label}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
