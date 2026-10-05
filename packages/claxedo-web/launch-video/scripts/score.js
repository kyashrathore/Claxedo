import { mkdir } from "node:fs/promises"
import { arg, launch, OUT } from "./film.js"

/** Renders a cut's score in Chromium's OfflineAudioContext and writes 48 kHz 16-bit stereo WAV. */
export const renderWav = async (studio, cut, path) => {
  const { page } = await studio.open(cut)
  const pcm = Buffer.from(await page.evaluate(() => window.renderScore()), "base64")
  await page.close()
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  await Bun.write(path, Buffer.concat([header, pcm]))
  return path
}

if (import.meta.main) {
  const cut = arg("cut", "film")
  await mkdir(OUT, { recursive: true })
  const studio = await launch()
  console.log(`score → ${await renderWav(studio, cut, `${OUT}${cut}.wav`)}`)
  await studio.close()
}
