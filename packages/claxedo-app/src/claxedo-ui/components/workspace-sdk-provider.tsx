import { createEffect, createMemo, Show, type Accessor, type ParentProps } from "solid-js"
import { SDKProvider } from "@/context/sdk"
import { useServer } from "@/context/server"

const loopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)

export function WorkspaceSDKProvider(
  props: ParentProps<{
    directory: Accessor<string>
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

  createEffect(() => {
    const path = dir()
    if (!path) return
    const url = server.forWorkspace(path)
    if (!url || url === server.url) return
    if (!loopback(server.url)) return
    server.add(url)
  })

  createEffect(() => {
    const path = dir()
    const url = server.url
    if (!path || !url) return
    if (loopback(url)) return
    server.rememberWorkspace(path, url)
  })
  return (
    <Show when={key()} keyed>
      {(_k) => <SDKProvider directory={dir}>{props.children}</SDKProvider>}
    </Show>
  )
}
