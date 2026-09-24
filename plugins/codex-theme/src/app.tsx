import { definePlugin } from "@claxedo/plugin-api"
import { darkTokens, lightTokens } from "./tokens"

export default definePlugin({
  activate(api) {
    api.themes.register({ id: "codex", name: "Codex", appearance: "light", tokens: lightTokens })
    api.themes.register({ id: "codex", name: "Codex", appearance: "dark", tokens: darkTokens })
  },
})
