import { CUTS } from "./cuts.js"
import { renderScore } from "./score.js"

const params = new URLSearchParams(location.search)
const name = params.get("cut") ?? "film"
const cut = CUTS[name]
const stage = document.getElementById("stage")
const film = await cut(stage)
window.film = film
window.renderScore = async () => {
  const channels = await renderScore(film, name)
  const pcm = new Int16Array(channels[0].length * 2)
  channels[0].forEach((left, i) => {
    pcm[i * 2] = Math.max(-1, Math.min(1, left)) * 32767
    pcm[i * 2 + 1] = Math.max(-1, Math.min(1, channels[1][i])) * 32767
  })
  let binary = ""
  const bytes = new Uint8Array(pcm.buffer)
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}

if (params.has("play")) {
  const begin = performance.now() - Number(params.get("t") ?? 0) * 1000
  const tick = (now) => {
    film.render(((now - begin) / 1000) % film.duration)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
} else {
  film.render(Number(params.get("t") ?? 0))
}
document.documentElement.dataset.ready = "true"
