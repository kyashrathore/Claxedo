import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { createDebugLogger } from "../utils/debug"

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: Accessor<string> }) => {
    const globalSDK = useGlobalSDK()
    const debug = createDebugLogger("layout.process", "layout:process")
    const inst = Math.random().toString(36).slice(2, 7)

    const directory = createMemo(props.directory)
    const client = createMemo(() =>
      globalSDK.createClient({
        directory: directory(),
        throwOnError: true,
      }),
    )

    const emitter = createGlobalEmitter<SDKEventMap>()
    const snap = () => ({
      inst,
      dir: directory() || null,
      url: globalSDK.url,
    })

    onMount(() => {
      debug.verbose("sdk provider mount", snap())
    })

    onCleanup(() => {
      debug.log("sdk provider cleanup", snap())
      queueMicrotask(() => {
        debug.verbose("sdk provider cleanup settled", snap())
      })
    })

    createEffect(() => {
      const dir = directory()
      debug.verbose("sdk event bind", {
        inst,
        dir: dir || null,
      })
      const unsub = globalSDK.event.on(dir, (event) => {
        emitter.emit(event.type, event)
      })
      onCleanup(() => {
        debug.verbose("sdk event unbind", {
          inst,
          dir: dir || null,
        })
        unsub()
      })
    })

    return {
      get directory() {
        return directory()
      },
      get client() {
        return client()
      },
      event: emitter,
      get url() {
        return globalSDK.url
      },
      createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
        return globalSDK.createClient(opts)
      },
    }
  },
})
