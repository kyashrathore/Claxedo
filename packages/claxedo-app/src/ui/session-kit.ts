// Centralized upstream session-ui imports. App code imports this file so an
// upstream package reshuffle is localized to one boundary.
export * from "@opencode-ai/session-ui/basic-tool"
export * from "./session-kit-context"
export * from "@opencode-ai/session-ui/dock-prompt"
export * from "@opencode-ai/session-ui/file"
export * from "@opencode-ai/session-ui/format-duration"
export * from "@opencode-ai/session-ui/line-comment"
export * from "@opencode-ai/session-ui/line-comment-annotations"
export * from "@opencode-ai/session-ui/markdown"
export { preloadMarkdown, sanitizeSvg } from "@opencode-ai/session-ui/markdown-cache"
export * from "@opencode-ai/session-ui/message-nav"
export * from "@opencode-ai/session-ui/message-part"
export * from "@opencode-ai/session-ui/subagent-chip"
export * from "@opencode-ai/session-ui/pierre/media"
export * from "@opencode-ai/session-ui/pierre/selection-bridge"
export * from "@opencode-ai/session-ui/session-diff"
export * from "@opencode-ai/session-ui/session-retry"
export * from "@opencode-ai/session-ui/session-turn"
// v2 prompt-input engine (plan 2026-07-25-005 / T2.1+T2.2). Lives in its own
// LIGHT boundary file because the eager composer needs the controller at
// runtime and must not import this barrel (whose `export *` lines above pull
// @pierre/diffs + shiki into the eager main chunk). Re-exported here so lazy
// consumers keep exactly one `@/ui/session-kit` import path.
export * from "./session-kit-prompt"
