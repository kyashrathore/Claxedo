import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { mock } from "bun:test"

GlobalRegistrator.register()

// Mock Vite-specific imports that Bun cannot resolve.
// `?worker&url` is a Vite convention for getting a worker script URL;
// in tests we just provide a no-op stub.
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({
  default: "",
}))

mock.module("../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({
  default: "",
}))

// Vite `define` constants — not available in Bun's test runner.
;(globalThis as Record<string, unknown>).__DEMO_ENABLED__ = false
