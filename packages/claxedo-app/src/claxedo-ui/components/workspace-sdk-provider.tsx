import { createEffect, createMemo, Show, type Accessor, type ParentProps } from "solid-js"
import { SDKProvider } from "@/context/sdk"
import { useServer } from "@/context/server"
import { createDebugLogger } from "../../overrides/utils/debug"

const loopback = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)

export function WorkspaceSDKProvider(
  props: ParentProps<{
    directory: Accessor<string>
  }>,
) {
  const server = useServer()
  const dir = createMemo(props.directory)
  const debug = createDebugLogger("workspace.sdk", "workspace:sdk", {
    defaultLevel: 0,
  })
  const key = createMemo(() => {
    const url = server.key
    const path = dir()
    if (!url || !path) return
    return `${url}\n${path}`
  })

  createEffect(() => {
    const data = {
      key: key(),
      directory: dir(),
      serverKey: server.key,
      serverUrl: server.url,
      remembered: dir() ? server.forWorkspace(dir()!) : undefined,
    }
    debug.log("key", data)
  })

  createEffect(() => {
    const path = dir()
    if (!path) return
    const url = server.forWorkspace(path)
    const data = {
      directory: path,
      current: server.url,
      remembered: url,
      currentIsLoopback: loopback(server.url),
    }
    debug.log("workspace server check", data)
    if (!url || url === server.url) return
    if (!loopback(server.url)) return
    const next = {
      directory: path,
      url,
      from: server.url,
    }
    debug.log("workspace server add", next)
    server.add(url)
  })

  createEffect(() => {
    const path = dir()
    const url = server.url
    if (!path || !url) return
    if (loopback(url)) return
    const data = {
      directory: path,
      url,
    }
    debug.log("remember workspace server", data)
    server.rememberWorkspace(path, url)
  })
  return (
    <Show when={key()} keyed>
      {(_k) => <SDKProvider directory={dir}>{props.children}</SDKProvider>}
    </Show>
  )
}
