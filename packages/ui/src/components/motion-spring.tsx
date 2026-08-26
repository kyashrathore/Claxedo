import { attachSpring, motionValue } from "motion"
import type { SpringOptions } from "motion"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"

type Opt = Partial<Pick<SpringOptions, "visualDuration" | "bounce" | "stiffness" | "damping" | "mass" | "velocity">>
const eq = (a: Opt | undefined, b: Opt | undefined) =>
  a?.visualDuration === b?.visualDuration &&
  a?.bounce === b?.bounce &&
  a?.stiffness === b?.stiffness &&
  a?.damping === b?.damping &&
  a?.mass === b?.mass &&
  a?.velocity === b?.velocity

export function useSpring(target: () => number, options?: Opt | (() => Opt), snapKey?: () => unknown) {
  const read = () => (typeof options === "function" ? options() : options)
  const initial = untrack(target)
  const [value, setValue] = createSignal(initial)
  // Seeds, like `initial`/`config`/`snapValue` below — `untrack` for the same
  // reason: these read the signal once to prime the motion values, and the
  // `spring.on("change")` subscription is what keeps them moving.
  const source = motionValue(untrack(value))
  const spring = motionValue(untrack(value))
  let config = untrack(read)
  let snapValue = untrack(() => snapKey?.())
  let stop = attachSpring(spring, source, config)
  let off = spring.on("change", (next: number) => setValue(next))

  createEffect(
    () => [target(), snapKey?.()] as const,
    ([next, nextSnap]) => {
      if (snapKey && nextSnap !== snapValue) {
        // State boundaries should adopt their target without animating from the previous context.
        snapValue = nextSnap
        stop()
        spring.jump(next)
        source.jump(next)
        stop = attachSpring(spring, source, config)
        setValue(next)
        return
      }
      source.set(next)
    },
  )

  createEffect(
    () => (options ? read() : undefined),
    (next) => {
      if (!options || eq(config, next)) return
      config = next
      stop()
      stop = attachSpring(spring, source, next)
      setValue(spring.get())
    },
  )

  onCleanup(() => {
    off()
    stop()
    spring.destroy()
    source.destroy()
  })

  return value
}
