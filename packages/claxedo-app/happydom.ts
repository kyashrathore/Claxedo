import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { plugin } from "bun"
import { mock } from "bun:test"

GlobalRegistrator.register()

// Vite serves `*.svg?url` as an asset URL string. Bun's resolver has no such
// convention, so every sprite-sheet import (`@claxedo/ui` icon components)
// resolves to an empty URL here instead of a module-resolution error.
plugin({
  name: "vite-asset-url-imports",
  setup(build) {
    build.onResolve({ filter: /\.svg\?url$/ }, (args) => ({ path: args.path, namespace: "vite-asset-url" }))
    build.onLoad({ filter: /.*/, namespace: "vite-asset-url" }, () => ({ contents: 'export default ""', loader: "js" }))
  },
})

// Mock Vite-specific imports that Bun cannot resolve.
// `?worker&url` is a Vite convention for getting a worker script URL;
// in tests we just provide a no-op stub.
await mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({
  default: "",
}))

await mock.module("../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({
  default: "",
}))
