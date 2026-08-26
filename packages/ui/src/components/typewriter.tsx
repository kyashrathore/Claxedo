import { storePath } from "solid-js"
import { createTrackedEffect, onCleanup, Show } from "solid-js"
import type { ValidComponent } from "@solidjs/web"
import { createStore } from "solid-js"
import { Dynamic } from "@solidjs/web"

export const Typewriter = <T extends ValidComponent = "p">(props: { text?: string; class?: string; as?: T }) => {
  const [store, setStore] = createStore({
    typing: false,
    displayed: "",
    cursor: true,
  })

  createTrackedEffect(() => {
    const text = props.text
    if (!text) return

    let i = 0
    const timeouts: ReturnType<typeof setTimeout>[] = []
    setStore(storePath("typing", true))
    setStore(storePath("displayed", ""))
    setStore(storePath("cursor", true))

    const getTypingDelay = () => {
      const random = Math.random()
      if (random < 0.05) return 150 + Math.random() * 100
      if (random < 0.15) return 80 + Math.random() * 60
      return 30 + Math.random() * 50
    }

    const type = () => {
      if (i < text.length) {
        setStore(storePath("displayed", text.slice(0, i + 1)))
        i++
        timeouts.push(setTimeout(type, getTypingDelay()))
      } else {
        setStore(storePath("typing", false))
        timeouts.push(setTimeout(() => setStore(storePath("cursor", false)), 2000))
      }
    }

    timeouts.push(setTimeout(type, 200))

    return () => {
      for (const timeout of timeouts) clearTimeout(timeout)
    }
  })

  return (
    <Dynamic component={props.as || "p"} class={props.class}>
      {store.displayed}
      <Show when={store.cursor}>
        <span class={{ "blinking-cursor": !store.typing }}>│</span>
      </Show>
    </Dynamic>
  )
}
