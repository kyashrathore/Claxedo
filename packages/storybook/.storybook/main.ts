import { defineMain } from "storybook-solidjs-vite"
import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { playgroundCss } from "./playground-css-plugin.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const ui = path.resolve(here, "../../ui")
const sessionUi = path.resolve(here, "../../session-ui")
const app = path.resolve(here, "../../claxedo-app/src")
const mocks = path.resolve(here, "./mocks")

export default defineMain({
  framework: {
    name: "storybook-solidjs-vite",
    options: {
      // The TS-language-service docgen indexes the whole monorepo and OOMs a 4GB heap.
      docgen: false,
    },
  },
  addons: [
    "@storybook/addon-onboarding",
    "@storybook/addon-docs",
    "@storybook/addon-links",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",
  ],
  stories: [
    "../../ui/src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../../session-ui/src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
  ],
  async viteFinal(config) {
    const { mergeConfig, searchForWorkspaceRoot } = await import("vite")
    return mergeConfig(config, {
      plugins: [tailwindcss(), playgroundCss()],
      resolve: {
        dedupe: ["solid-js", "solid-js/web", "@solidjs/meta"],
        alias: [
          { find: "@solidjs/router", replacement: path.resolve(mocks, "solid-router.tsx") },
          { find: "@", replacement: app },
        ],
      },
      worker: {
        format: "es",
      },
      server: {
        fs: {
          allow: [searchForWorkspaceRoot(process.cwd()), ui, sessionUi, app, mocks],
        },
      },
    })
  },
})
