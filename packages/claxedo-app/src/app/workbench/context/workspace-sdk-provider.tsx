import { createTrackedEffect, createMemo, Show, type Accessor, type ParentProps } from "solid-js"
import { SDKProvider } from "@/app/providers/sdk/sdk"
import { useServer } from "@/app/connection/server"

const loopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)

export function WorkspaceSDKProvider(
  props: ParentProps<{
    directory: Accessor<string>
    // Explicit relay-routing identity for this scope. When the directory is the
    // runtime's filesystem path (which the inventory can't map back), this keeps
    // the scope routing through the relay. See the directory-shape routing plan.
    workspaceId?: Accessor<string | undefined>
  }>,
) {
  const server = useServer()
  const dir = createMemo(props.directory)
  const key = createMemo(() => {
    const url = server.key
    const path = dir()
    if (!url || !path) return
    return `${url}\n${path}`
  })

  createTrackedEffect(() => {
    const path = dir()
    if (!path) return
    const url = server.forWorkspace(path)
    if (!url || url === server.url) return
    if (!loopback(server.url)) return
    server.add(url)
  })

  createTrackedEffect(() => {
    const path = dir()
    const url = server.url
    if (!path || !url) return
    if (loopback(url)) return
    server.rememberWorkspace(path, url)
  })
  return (
    <Show when={key()} keyed>
      {(_k) => (
        <SDKProvider directory={dir} workspaceId={props.workspaceId}>
          {props.children}
        </SDKProvider>
      )}
    </Show>
  )
}
