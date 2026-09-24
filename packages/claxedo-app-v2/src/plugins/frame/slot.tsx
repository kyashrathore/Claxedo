import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import { failureReason } from "../failure"
import { FRAME_DOCUMENT } from "./document"
import type { HostLink } from "./host-link"

export function FrameSlot(props: { readonly title: string; readonly open: (frame: HTMLIFrameElement) => Promise<HostLink> }): JSX.Element {
  const [failure, setFailure] = createSignal<string>()
  let link: HostLink | undefined
  let closed = false
  onCleanup(() => {
    closed = true
    link?.dispose()
  })
  const load = (frame: HTMLIFrameElement) =>
    props.open(frame).then(
      (opened) => {
        if (closed) opened.dispose()
        else link = opened
      },
      (error: unknown) => setFailure(failureReason(error)),
    )
  return (
    <>
      <Show when={failure()}>
        {(reason) => (
          <p role="alert" class="plugin-slot-failure-reason">
            {reason()}
          </p>
        )}
      </Show>
      <iframe class="plugin-frame" title={props.title} sandbox="allow-scripts" srcdoc={FRAME_DOCUMENT} onLoad={(event) => void load(event.currentTarget)} />
    </>
  )
}
