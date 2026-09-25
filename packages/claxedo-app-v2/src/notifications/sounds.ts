import alert01 from "./assets/ios.mp3"

export const SOUNDS = [{ id: "alert01", src: alert01 }] as const

export type SoundId = (typeof SOUNDS)[number]["id"]
export type SoundChoice = SoundId | "none"

export const DEFAULT_SOUND: SoundId = "alert01"

export function isSoundChoice(value: unknown): value is SoundChoice {
  return value === "none" || SOUNDS.some((sound) => sound.id === value)
}

export type SoundPlayer = { readonly play: (choice: SoundChoice) => void }

export function createSoundPlayer(): SoundPlayer {
  const state: { playing?: HTMLAudioElement } = {}
  return {
    play: (choice) => {
      const src = SOUNDS.find((sound) => sound.id === choice)?.src
      if (!src || typeof Audio === "undefined") return
      state.playing?.pause()
      state.playing = new Audio(src)
      state.playing.play().catch((error: unknown) => console.warn("The alert sound could not play", { error }))
    },
  }
}
