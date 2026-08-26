import { createMemo, omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface ProgressCircleProps extends Pick<ComponentProps<"svg">, "class" | "style"> {
  percentage: number
  size?: number
  strokeWidth?: number
}

export function ProgressCircle(props: ProgressCircleProps) {
  const split = props,
    rest = omit(props, "percentage", "size", "strokeWidth", "class")

  const size = () => split.size || 16
  const strokeWidth = () => split.strokeWidth || 3

  const viewBoxSize = 16
  const center = viewBoxSize / 2
  const radius = () => center - strokeWidth() / 2
  const circumference = createMemo(() => 2 * Math.PI * radius())

  const offset = createMemo(() => {
    const clampedPercentage = Math.max(0, Math.min(100, split.percentage || 0))
    const progress = clampedPercentage / 100
    return circumference() * (1 - progress)
  })

  return (
    <svg
      {...rest}
      width={size()}
      height={size()}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      fill="none"
      data-component="progress-circle"
      class={split.class}
    >
      <circle
        cx={center}
        cy={center}
        r={radius()}
        data-slot="progress-circle-background"
        stroke-width={strokeWidth()}
      />
      <circle
        cx={center}
        cy={center}
        r={radius()}
        data-slot="progress-circle-background-overlay"
        stroke-width={strokeWidth()}
      />
      <circle
        cx={center}
        cy={center}
        r={radius()}
        data-slot="progress-circle-progress"
        stroke-width={strokeWidth()}
        stroke-dasharray={circumference().toString()}
        stroke-dashoffset={offset()}
      />
    </svg>
  )
}
