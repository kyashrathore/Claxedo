import { createSignal, type Accessor } from "solid-js"

export type ImageAvailability = "pending" | "loaded" | "failed"

const availability = new Map<string, Accessor<ImageAvailability>>()

function startImageProbe(src: string): Accessor<ImageAvailability> {
  const [state, setState] = createSignal<ImageAvailability>("pending")
  const image = new Image()
  image.onload = () => setState("loaded")
  image.onerror = () => setState("failed")
  image.src = src
  return state
}

export function imageAvailability(src: string): Accessor<ImageAvailability> {
  const known = availability.get(src)
  if (known) return known
  const state = startImageProbe(src)
  availability.set(src, state)
  return state
}
