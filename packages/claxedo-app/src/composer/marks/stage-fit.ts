import { createSignal } from "solid-js"
import { createElementSize } from "@solid-primitives/resize-observer"
import type { Size } from "./marks"

export function createStageFit() {
  const [size, setSize] = createSignal<Size>()
  const [stage, setStage] = createSignal<HTMLDivElement>()
  const stageSize = createElementSize(stage)
  const measured = () => !!size() && !!stageSize.width && !!stageSize.height
  const shown = () => {
    const natural = size()
    const width = stageSize.width
    const height = stageSize.height
    if (!natural || !width || !height) return { visibility: "hidden" as const }
    const scale = Math.min(width / natural.width, height / natural.height, 1)
    return { width: `${natural.width * scale}px`, height: `${natural.height * scale}px` }
  }
  return { size, setSize, setStage, stageSize, measured, shown }
}
