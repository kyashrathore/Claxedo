// Bundled cross-platform notification sound for agent completion.
import iosSound from "./assets/ios.mp3"

export const SOUND_OPTIONS = [
  { id: "ios", label: "sound.option.alert01", src: iosSound },
] as const

export type SoundOption = (typeof SOUND_OPTIONS)[number]
export type SoundID = SoundOption["id"]
export const DEFAULT_SOUND_ID: SoundID = SOUND_OPTIONS[0].id

export function isSoundID(id: unknown): id is SoundID {
  return typeof id === "string" && SOUND_OPTIONS.some((sound) => sound.id === id)
}

export function soundSrc(id: string | undefined): string | undefined {
  if (!id) return undefined
  return SOUND_OPTIONS.find((sound) => sound.id === id)?.src
}

export function playSound(src: string | undefined): VoidFunction | undefined {
  if (typeof Audio === "undefined") return undefined
  if (!src) return undefined
  const audio = new Audio(src)
  audio.play().catch(() => undefined)

  // Return a cleanup function to pause the sound.
  return () => {
    audio.pause()
    audio.currentTime = 0
  }
}

export function playSoundById(id: string | undefined) {
  return Promise.resolve(playSound(soundSrc(id)))
}
