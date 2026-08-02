/**
 * The shell-ready marker payload, emitted as `OSC 777 ; <payload> BEL` by the
 * shell wrappers in `agent-hooks/templates/*` (zsh, bash) and by the inline
 * fish hook in `agent-hooks/core/shell.ts`.
 *
 * Those are shell scripts and cannot import this constant, so the literal is
 * duplicated there by necessity. `shell-ready.test.ts` asserts every emitter
 * still carries this exact payload, so a rename fails CI instead of silently
 * disabling shell-readiness detection (which degrades to the 1200ms fallback
 * timer — slow, but invisible, which is why it needs a guard).
 */
export const SHELL_READY_MARKER = "claxedo-shell-ready"

/** Full OSC form, for tests and for anything matching the complete sequence. */
export const SHELL_READY_SEQUENCE = `\x1b]777;${SHELL_READY_MARKER}\x07`
