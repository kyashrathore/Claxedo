import { rng } from "./lib/time.js"

const BEAT = 60 / 96
const BAR = BEAT * 4
const RATE = 48000
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)

/** Two bars per chord: Fmaj9, Dm9, B♭maj9, C6/9. The ending always resolves on Fmaj9. */
const CHORDS = [
  [53, 57, 60, 64, 67],
  [50, 53, 57, 60, 64],
  [46, 50, 53, 57, 60],
  [48, 55, 62, 64, 69],
]
const ARP = [0, 2, 4, 3, 1, 3, 4, 2]
const PENTATONIC = [77, 79, 81, 84, 86, 89]

/** Layer levels by section, on the bar lines of shotlist.md. `end` is where the closing hit lands. */
const SECTIONS = {
  film: {
    end: 55,
    parts: [
      { at: 0, pad: 0.55, arp: 0, bass: 0, kick: 0, hat: 0 },
      { at: 2.5, pad: 0.8, arp: 0.55, bass: 0, kick: 0, hat: 0 },
      { at: 12.5, pad: 0.8, arp: 0.7, bass: 0.6, kick: 0.45, hat: 0, half: true },
      { at: 25, pad: 0.8, arp: 0.8, bass: 0.8, kick: 0.65, hat: 0.5 },
      { at: 35, pad: 1, arp: 0.35, bass: 0.3, kick: 0, hat: 0 },
      { at: 42.5, pad: 0.8, arp: 0.9, bass: 0.9, kick: 0.75, hat: 0.6 },
    ],
  },
  social: {
    end: 25,
    parts: [
      { at: 0, pad: 0.55, arp: 0, bass: 0, kick: 0, hat: 0 },
      { at: 2.5, pad: 0.8, arp: 0.6, bass: 0.4, kick: 0, hat: 0 },
      { at: 9, pad: 0.8, arp: 0.75, bass: 0.7, kick: 0.5, hat: 0.3, half: true },
      { at: 14.6, pad: 0.8, arp: 0.85, bass: 0.85, kick: 0.7, hat: 0.55 },
    ],
  },
}

const levelAt = (score, t) => {
  if (t >= score.end) return { pad: 0, arp: 0, bass: 0, kick: 0, hat: 0 }
  let part = score.parts[0]
  for (const candidate of score.parts) if (t >= candidate.at) part = candidate
  return part
}

/**
 * Renders the cut's score: the music on the beat grid, and every cue the picture
 * registered (keys, ticks, selects, sends, swells) at its exact frame time.
 *
 * Synthesis is plain JS into Float32 buses rather than an OfflineAudioContext graph:
 * Chromium sums a node's inputs in an order that varies between runs, so a WebAudio
 * render differs by ±1 LSB on ~0.03% of samples each time (measured twice, 1790 and
 * 770 samples). This renders bit-identically.
 */
export const renderScore = async (film, cut) => {
  const score = SECTIONS[cut]
  const length = Math.round(film.duration * RATE)
  const dry = new Float32Array(length)
  const send = new Float32Array(length)
  const random = rng(77)
  const musicBus = { send: 0.45 }
  const cueBus = { send: 0.18 }

  const lowpass = (cutoff) => {
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE)
    let y1 = 0
    let y2 = 0
    return (x) => {
      y1 += a * (x - y1)
      y2 += a * (y1 - y2)
      return y2
    }
  }
  const write = (bus, i, value) => {
    if (i < 0 || i >= length) return
    dry[i] += value
    send[i] += value * bus.send
  }

  const tone = ({ type = "sine", freq, at, attack = 0.005, peak, decay, hold, out = musicBus, cutoff, detune = 0, glideTo }) => {
    if (peak <= 0) return
    const start = Math.round(at * RATE)
    const releaseAt = hold ? (hold - at) * RATE : attack * RATE
    const total = Math.ceil(hold ? releaseAt + decay * RATE : attack * RATE + decay * 2.4 * RATE)
    const filter = cutoff ? lowpass(cutoff) : null
    const base = freq * 2 ** (detune / 1200)
    const glideSamples = 0.12 * RATE
    let phase = 0
    for (let n = 0; n < total; n++) {
      const f = glideTo ? base * (glideTo / freq) ** Math.min(1, n / glideSamples) : base
      phase += f / RATE
      phase -= Math.floor(phase)
      const wave = type === "triangle" ? 1 - 4 * Math.abs(phase - 0.5) : Math.sin(2 * Math.PI * phase)
      let level
      if (n < attack * RATE) level = (peak * n) / (attack * RATE)
      else if (hold) level = n < releaseAt ? peak : peak * Math.max(0, 1 - (n - releaseAt) / (decay * RATE))
      else level = peak * Math.exp(-(n - attack * RATE) / ((decay / 4) * RATE))
      write(out, start + n, (filter ? filter(wave) : wave) * level)
    }
  }

  const biquad = (type, freq, q) => {
    let b0, b1, b2, a1, a2
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    const set = (f) => {
      const w = (2 * Math.PI * Math.min(f, RATE * 0.45)) / RATE
      const alpha = Math.sin(w) / (2 * q)
      const cos = Math.cos(w)
      const a0 = 1 + alpha
      if (type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
      else if (type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
      else [b0, b1, b2] = [alpha, 0, -alpha]
      ;[b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
    }
    set(freq)
    const run = (x) => {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      return y
    }
    return { set, run }
  }

  const burst = ({ at, peak, decay, type = "highpass", freq = 4000, q = 0.7, out = cueBus, sweepTo, attack = 0.001 }) => {
    const start = Math.round(at * RATE)
    const attackN = Math.max(1, Math.round(attack * RATE))
    const total = attackN + Math.round(decay * RATE)
    const filter = biquad(type, freq, q)
    for (let n = 0; n < total; n++) {
      if (sweepTo && n % 32 === 0) filter.set(freq * (sweepTo / freq) ** (n / total))
      const level = n < attackN ? (peak * n) / attackN : peak * 0.0001 ** ((n - attackN) / (total - attackN))
      write(out, start + n, filter.run(random() * 2 - 1) * level)
    }
  }

  const bars = Math.ceil(film.duration / BAR)
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * BAR
    if (start >= score.end) break
    if (bar % 2 === 0) {
      const level = levelAt(score, start + 0.01)
      CHORDS[(bar / 2) % 4].forEach((note, i) => {
        const end = Math.min(start + BAR * 2, score.end)
        for (const detune of [-5, 5]) tone({ type: i % 2 ? "triangle" : "sine", freq: hz(note), at: start, attack: 1.4, peak: 0.022 * level.pad, decay: 1.6, hold: end - 0.2, cutoff: 1500, detune })
      })
    }
    const chord = CHORDS[Math.floor(bar / 2) % 4]
    for (let step = 0; step < 8; step++) {
      const at = start + step * BEAT / 2
      if (at >= score.end) break
      const level = levelAt(score, at)
      if (level.arp) tone({ type: "triangle", freq: hz(chord[ARP[step]] + 12), at, peak: 0.05 * level.arp * (step % 2 ? 0.7 : 1), decay: 0.45, cutoff: 2600 })
      if (level.hat && step % 2 === 1) burst({ at, peak: 0.018 * level.hat, decay: 0.05, freq: 7500, out: musicBus })
      if (step % 2 === 0) {
        const beat = step / 2
        if (level.kick && (!level.half || beat % 2 === 0)) tone({ freq: 120, glideTo: 46, at, peak: 0.42 * level.kick, decay: 0.35 })
        if (level.bass && beat % 2 === 0) tone({ type: "triangle", freq: hz(chord[0] - 12), at, attack: 0.02, peak: 0.08 * level.bass, decay: 0.3, hold: at + BEAT * 1.6, cutoff: 600 })
      }
    }
  }

  const resolve = score.end
  tone({ freq: 110, glideTo: 38, at: resolve, peak: 0.6, decay: 1.4 })
  burst({ at: resolve - 0.9, attack: 0.88, peak: 0.05, decay: 0.12, type: "lowpass", freq: 300, sweepTo: 5000, out: musicBus })
  for (const note of [41, 53, 57, 60, 64, 67, 72]) for (const detune of [-4, 4]) tone({ type: note < 50 ? "sine" : "triangle", freq: hz(note), at: resolve, attack: 0.02, peak: note < 50 ? 0.05 : 0.02, decay: 2.2, hold: film.duration - 2.4, cutoff: 2400, detune })
  for (const [i, note] of [77, 81, 84, 88].entries()) tone({ freq: hz(note), at: resolve + 0.3 + i * BEAT / 2, peak: 0.035, decay: 1.6 })

  for (const cue of film.cues) {
    const at = cue.t
    if (at < 0 || at >= film.duration - 0.1) continue
    const soft = cue.soft ? 0.55 : 1
    if (cue.kind === "key") {
      burst({ at, peak: 0.07 * soft, decay: 0.018, freq: 2600 + random() * 1600, q: 1.2 })
      tone({ freq: 180 + random() * 40, at, peak: 0.03 * soft, decay: 0.025, out: cueBus })
    } else if (cue.kind === "tick") {
      burst({ at, peak: 0.05 * soft, decay: 0.012, type: "bandpass", freq: 5200, q: 2 })
    } else if (cue.kind === "click" || cue.kind === "select") {
      tone({ freq: cue.kind === "select" ? 1760 : 1320, at, peak: 0.06, decay: 0.05, out: cueBus })
      burst({ at, peak: 0.06, decay: 0.02, type: "bandpass", freq: 3000, q: 1.5 })
    } else if (cue.kind === "pop") {
      tone({ freq: hz(PENTATONIC[(cue.pitch ?? 0) % PENTATONIC.length]), at, peak: 0.07, decay: 0.32, out: cueBus })
    } else if (cue.kind === "whoosh") {
      burst({ at: at - 0.1, attack: 0.35, peak: 0.05, decay: 0.55, type: "bandpass", freq: 500, sweepTo: 3200, q: 0.9 })
    } else if (cue.kind === "send") {
      tone({ freq: 660, glideTo: 1320, at, peak: 0.06, decay: 0.12, out: cueBus })
      burst({ at, peak: 0.05, decay: 0.03, type: "bandpass", freq: 2400, q: 1.2 })
    } else if (cue.kind === "rise") {
      burst({ at: at - 0.7, attack: 0.68, peak: 0.04, decay: 0.15, type: "lowpass", freq: 400, sweepTo: 4000 })
    } else if (cue.kind === "chime") {
      for (const [ratio, peak] of [[1, 0.05], [2.76, 0.015], [5.4, 0.006]]) tone({ freq: hz(84) * ratio, at, peak, decay: 1.4, out: cueBus })
    }
  }

  return master2(dry, send, film.duration)
}

/**
 * Freeverb-style stereo reverb on the send bus, the closing fade, loudness to about
 * −17 dBFS RMS, and a tanh soft clip for peaks.
 */
const COMBS = { left: [1557, 1617, 1491, 1422], right: [1580, 1640, 1514, 1445] }
const ALLPASS = { left: [556, 441], right: [579, 464] }

const freeverb = (input, combs, allpasses, room = 0.86, damp = 0.25) => {
  const out = new Float32Array(input.length)
  for (const size of combs) {
    const line = new Float32Array(size * 2)
    let index = 0
    let low = 0
    for (let i = 0; i < input.length; i++) {
      const delayed = line[index]
      low = delayed * (1 - damp) + low * damp
      line[index] = input[i] + low * room
      out[i] += delayed
      index = (index + 1) % line.length
    }
  }
  for (const size of allpasses) {
    const line = new Float32Array(size * 2)
    let index = 0
    for (let i = 0; i < out.length; i++) {
      const delayed = line[index]
      line[index] = out[i] + delayed * 0.5
      out[i] = delayed - out[i]
      index = (index + 1) % line.length
    }
  }
  return out
}

const master2 = (dry, send, duration) => {
  const wet = 0.09
  const left = freeverb(send, COMBS.left, ALLPASS.left)
  const right = freeverb(send, COMBS.right, ALLPASS.right)
  const fadeFrom = Math.round((duration - 2.2) * RATE)
  const L = new Float32Array(dry.length)
  const R = new Float32Array(dry.length)
  let sum = 0
  for (let i = 0; i < dry.length; i++) {
    L[i] = dry[i] + left[i] * wet
    R[i] = dry[i] + right[i] * wet
    sum += L[i] * L[i] + R[i] * R[i]
  }
  const rms = Math.sqrt(sum / (dry.length * 2))
  const gain = 10 ** (-17 / 20) / rms
  for (let i = 0; i < dry.length; i++) {
    const fade = i < fadeFrom ? 1 : Math.max(0, 1 - (i - fadeFrom) / (dry.length - 60 - fadeFrom))
    L[i] = Math.tanh(L[i] * gain * fade * 1.1) / 1.1
    R[i] = Math.tanh(R[i] * gain * fade * 1.1) / 1.1
  }
  return [L, R]
}
