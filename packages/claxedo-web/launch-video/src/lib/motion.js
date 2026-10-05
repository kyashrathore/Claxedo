import { ease, mix, span } from "./time.js"

/** Caret blink with soft edges, like macOS: on for half of `period`, eased in and out over 7% of it. */
export const blink = (t, period = 1.06) => {
  const phase = (((t % period) + period) % period) / period
  const edge = 0.07
  if (phase < 0.5 - edge) return 1
  if (phase < 0.5) return 1 - ease.soft((phase - (0.5 - edge)) / edge)
  if (phase < 1 - edge) return 0
  return ease.soft((phase - (1 - edge)) / edge)
}

/**
 * Position along a list of stops [{ at, value }]: holds each value, then glides to the
 * next over `glide` seconds before its `at`.
 */
export const glide = (t, stops, glideDur = 0.24, curve = ease.inOut) => {
  let value = stops[0].value
  for (let i = 1; i < stops.length; i++) {
    const p = curve(span(t, stops[i].at - glideDur, glideDur))
    if (p <= 0) break
    value = mix(stops[i - 1].value, stops[i].value, p)
  }
  return value
}

/** A press: dips to `depth` and springs back, centred on `at`. */
export const press = (t, at, depth = 0.94) => {
  const down = ease.out(span(t, at - 0.08, 0.08))
  const up = ease.spring(span(t, at, 0.4))
  return t < at ? mix(1, depth, down) : mix(depth, 1, up)
}

/** Camera keyframes [{ at, dur, s, x, y }]: each move eases in-out over `dur` seconds and lands at `at`. */
export const camera = (t, keys) => {
  const pose = { x: keys[0].x ?? 0, y: keys[0].y ?? 0, s: keys[0].s ?? 1 }
  for (const key of keys.slice(1)) {
    const p = ease.inOut(span(t, key.at - key.dur, key.dur))
    if (p <= 0) break
    for (const axis of ["x", "y", "s"]) if (key[axis] !== undefined) pose[axis] = mix(pose[axis], key[axis], p)
  }
  return pose
}
