import { agentsScene } from "./scenes/agents.js"
import { deployScene } from "./scenes/deploy.js"
import { loopScene } from "./scenes/loop.js"
import { modelsScene } from "./scenes/models.js"
import { phoneScene } from "./scenes/phone.js"
import { posterScene } from "./scenes/poster.js"
import { sessionScene } from "./scenes/session.js"
import { teamScene } from "./scenes/team.js"
import { whereScene } from "./scenes/where.js"

const FPS = 60

/**
 * A cut is a stage size plus scenes laid on one clock. Each scene owns [start, end)
 * and renders as a pure function of the film time; overlapping scenes cross over.
 */
const assemble = async (stage, { width, height, duration, scenes }) => {
  Object.assign(stage.style, { width: `${width}px`, height: `${height}px` })
  const L = { W: width, H: height, portrait: height > width }
  const cues = []
  const built = []
  for (const make of scenes) {
    const scene = await make({ L, cues })
    stage.append(scene.el)
    built.push(scene)
  }
  await document.fonts.load('16px "Claxedo Mono"')
  await document.fonts.ready
  cues.sort((a, b) => a.t - b.t)
  return {
    width, height, duration, fps: FPS, cues,
    render(t) {
      const frame = Math.round(t * FPS)
      for (const scene of built) {
        const live = t >= scene.start && (t < scene.end || (scene.end >= duration && t <= duration))
        if (scene.el.style.display !== (live ? "" : "none")) scene.el.style.display = live ? "" : "none"
        if (live) scene.render(t, frame)
      }
    },
  }
}

/** Shot times are on the 96 BPM grid in shotlist.md: bar = 2.5 s. */
export const CUTS = {
  film: (stage) =>
    assemble(stage, {
      width: 1920, height: 1080, duration: 62.5,
      scenes: [
        (c) => agentsScene({ ...c, at: 0 }),
        (c) => modelsScene({ ...c, at: 12.5 }),
        (c) => whereScene({ ...c, at: 17.5 }),
        (c) => sessionScene({ ...c, at: 25 }),
        (c) => phoneScene({ ...c, at: 35 }),
        (c) => teamScene({ ...c, at: 42.5 }),
        (c) => deployScene({ ...c, at: 50 }),
        (c) => posterScene({ ...c, at: 55 }),
      ],
    }),
  social: (stage) =>
    assemble(stage, {
      width: 1080, height: 1920, duration: 28.5,
      scenes: [
        (c) => agentsScene({ ...c, at: 0, variant: "social" }),
        (c) => whereScene({ ...c, at: 9.0, variant: "social" }),
        (c) => phoneScene({ ...c, at: 14.6, variant: "social" }),
        (c) => deployScene({ ...c, at: 22.1, duration: 2.9, compact: true }),
        (c) => posterScene({ ...c, at: 25, duration: 3.5 }),
      ],
    }),
  loop: (stage) =>
    assemble(stage, {
      width: 1920, height: 1080, duration: 6,
      scenes: [(c) => loopScene(c)],
    }),
}
