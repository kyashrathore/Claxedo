// LIGHT boundary: the session-ui data context alone. The boot-time
// directory-scope provider needs DataProvider at runtime and must not import
// the fat `./session-kit` barrel (whose `export *` lines pull @pierre/diffs +
// shiki into whichever chunk imports it). `session-ui/context` is safe here:
// its only pierre edge is `import type`, which the bundler erases.
export * from "@opencode-ai/session-ui/context"
