export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
export const mix = (a, b, p) => a + (b - a) * p
export const span = (t, start, duration) => clamp((t - start) / duration)

const bezier = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const x = (s) => ((ax * s + bx) * s + cx) * s
  const dx = (s) => (3 * ax * s + 2 * bx) * s + cx
  const y = (s) => ((ay * s + by) * s + cy) * s
  return (p) => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let s = p
    for (let i = 0; i < 8; i++) {
      const d = dx(s)
      if (Math.abs(d) < 1e-6) break
      s -= (x(s) - p) / d
    }
    return y(clamp(s))
  }
}

export const ease = {
  linear: (p) => p,
  /** The site's own rise curve (`cubic-bezier(.2, .7, .2, 1)` in HomeHero). */
  rise: bezier(0.2, 0.7, 0.2, 1),
  out: bezier(0.16, 1, 0.3, 1),
  inOut: bezier(0.65, 0, 0.35, 1),
  in: bezier(0.55, 0, 1, 0.45),
  soft: bezier(0.4, 0, 0.2, 1),
  /** A damped spring: overshoots 3.4% at p = 0.45, within 0.1% of rest by p = 1. */
  spring: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-7.5 * p) * Math.cos(7 * p)),
}

export const rng = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296
}

/** Keystroke times for typing `text` from `start`, with seeded human jitter; spaces and punctuation linger. */
export const keystrokes = (text, start, { rate = 0.072, seed = 7 } = {}) => {
  const random = rng(seed)
  const times = []
  let at = start
  for (const char of text) {
    times.push(at)
    const pause = char === " " ? 1.35 : /[.,]/.test(char) ? 2.2 : 1
    at += rate * pause * (0.7 + random() * 0.6)
  }
  return { times, end: at }
}

export const typed = (text, strokes, t) => {
  let count = 0
  while (count < strokes.times.length && strokes.times[count] <= t) count++
  return text.slice(0, count)
}

/** Text reveal as if streamed by a model: whole words, chunked, at `wps` words a second. */
export const streamed = (text, start, t, wps = 14) => {
  const words = text.split(/(?<=\s)/)
  const count = Math.floor(clamp((t - start) * wps, 0, words.length))
  return { text: words.slice(0, count).join(""), done: count >= words.length }
}
