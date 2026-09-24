import alert01 from "./assets/ios.mp3"

export const SOUNDS = [{ id: "alert01", src: alert01 }] as const

export type SoundId = (typeof SOUNDS)[number]["id"]
export type SoundChoice = SoundId | "none"

export const DEFAULT_SOUND: SoundId = "alert01"

export function isSoundChoice(value: unknown): value is SoundChoice {
  return value === "none" || SOUNDS.some((sound) => sound.id === value)
}

let playing: HTMLAudioElement | undefined

export function playSound(choice: SoundChoice): void {
  const src = SOUNDS.find((sound) => sound.id === choice)?.src
  if (!src || typeof Audio === "undefined") return
  playing?.pause()
  playing = new Audio(src)
  playing.play().catch((error: unknown) => console.warn("The alert sound could not play", { error }))
}
