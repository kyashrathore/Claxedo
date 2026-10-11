import { setDefaultTimeout } from "bun:test"

// On the hosted Windows runner a test's first private-file write starts a
// PowerShell runner (1.4 to 5.3 s), `removeTempRoot` waits up to 10 s for a
// closed temp root's handles, and opening a fresh SQLite store has stalled for
// 4.9 s; bun's 5 s default fails on any of them. This default replaces a
// `--timeout` flag rather than raising it, so a package that passes one does
// not preload this file.
if (process.platform === "win32") setDefaultTimeout(20_000)
