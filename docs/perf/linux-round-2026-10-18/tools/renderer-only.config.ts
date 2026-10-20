import { defineConfig } from "electron-vite"
import desktop from "./electron.vite.config"

export default defineConfig(async (env) => {
  const full = typeof desktop === "function" ? await desktop(env) : await desktop
  return { renderer: full.renderer }
})
