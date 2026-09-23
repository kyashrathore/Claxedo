---
description: Wipe a throwaway desktop profile and launch the Electron app on its first run
---

Run the desktop app from a clean, isolated profile so the first run can be tested from zero.

Arguments (pass through verbatim to the script): $ARGUMENTS

1. Run the launcher and stream its output:

```bash
script/onboarding-desktop.sh $ARGUMENTS
```

- No arguments = wipe the profile and launch.
- `--keep` resumes the existing profile instead of wiping it (use it to continue a half-finished first run).
- `--no-credentials` also fakes `$HOME` so credential discovery finds nothing.
- `--reset-only` wipes without launching; `--print-env` shows the env only.

2. The first run of `predev` builds the patched opencode CLI, the embedded engine and the bundled claxedo-server — expect several minutes before the window appears.

3. Report what the app opened on and any error in the main-process or server output. Do not claim the flow works without evidence from the running app.

Notes:

- Everything the flow persists is inside `~/.claxedo-onboarding/<profile>/` (Electron userData + `CLAXEDO_DATA_DIR`). The real `~/.claxedo` and `~/.local/share/opencode` are never touched — resetting the real state is `script/reset-claxedo-state.sh` instead.
- A running desktop instance holds the SQLite stores open, so quit it first (the script refuses unless `--force`).
