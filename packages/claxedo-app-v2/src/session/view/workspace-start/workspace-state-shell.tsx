import { Show, type JSX, type ParentProps } from "solid-js"

export function WorkspaceStateShell(
  props: ParentProps<{
    readonly label: string
    readonly eyebrow: string
    readonly title: string
    readonly detail?: string
    readonly tone?: "neutral" | "critical"
    readonly actions?: JSX.Element
  }>,
) {
  const critical = () => props.tone === "critical"
  return (
    <section aria-label={props.label} class="w-full text-left">
      <div class="flex items-center gap-2 text-xs font-medium text-text-weaker">
        <span
          classList={{
            "inline-flex size-1.5 shrink-0 rounded-full bg-text-weaker/70": true,
            "animate-pulse motion-reduce:animate-none": !critical(),
          }}
        />
        <span class="truncate">{props.eyebrow}</span>
      </div>
      <div class="mt-3 min-w-0">
        <div class="text-title-sm font-medium leading-6 text-text-strong">{props.title}</div>
        <Show when={props.detail}>
          <div class="mt-1 text-13-regular text-text-weak">{props.detail}</div>
        </Show>
      </div>
      {props.children}
      <Show when={props.actions}>
        <div class="mt-6 flex items-center gap-2">{props.actions}</div>
      </Show>
    </section>
  )
}

export function WorkspaceStateNote(props: ParentProps) {
  return <div class="mt-5 flex items-start gap-2 rounded-md border border-border-weak-base/45 bg-surface-base/35 px-3 py-2">{props.children}</div>
}
