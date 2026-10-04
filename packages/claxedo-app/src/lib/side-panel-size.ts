import { createMemo, createSignal, type Accessor } from "solid-js"
import { usePhone } from "./viewport"

export type SidePanelSizeInput = {
  readonly available: number
  readonly phone: boolean
  readonly fullWidth: boolean
  readonly chosen: number | null
}

export function createSidePanelSize(input: {
  readonly chosen: Accessor<number | null>
  readonly onChoose: (width: number) => void
  readonly width: (state: SidePanelSizeInput) => number
  readonly clamp: (width: number, available: number) => number
}) {
  const phone = usePhone()
  const [available, setAvailable] = createSignal(typeof window === "undefined" ? 1024 : window.innerWidth)
  const [fullWidth, setFullWidth] = createSignal(false)
  const width = createMemo(() =>
    input.width({ available: available(), phone: phone(), fullWidth: fullWidth(), chosen: input.chosen() }),
  )
  return {
    phone,
    available,
    setAvailable: (value: number) => setAvailable(value),
    fullWidth,
    setFullWidth: (value: boolean) => setFullWidth(value),
    toggleFullWidth: () => setFullWidth((value) => !value),
    width,
    chooseWidth: (value: number) => input.onChoose(Math.round(input.clamp(value, available()))),
  }
}
