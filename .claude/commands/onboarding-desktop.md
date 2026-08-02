---
description: Wipe a throwaway desktop profile and launch the Electron app with onboarding v1 on
---

Run the desktop app from a clean, isolated profile so the onboarding v1 flow can be tested from zero.

Arguments (pass through verbatim to the script): $ARGUMENTS

1. Run the launcher in the background and stream its output:

```bash
script/onboarding-desktop.sh $ARGUMENTS
```

- No arguments = wipe the profile and launch.
- `--keep` resumes the existing profile instead of wiping it (use it to continue a half-finished onboarding run).
- `--no-credentials` also fakes `$HOME` so credential discovery finds nothing.
- `--reset-only` wipes without launching; `--print-env` shows the env only.

2. The first run of `predev` builds the patched opencode CLI, the embedded engine and the bundled claxedo-server — expect several minutes before the window appears. Watch the output for `electron-vite` serving the renderer and for the embedded server reporting ready.

3. Report what you see: which onboarding step the app opened on, and any error in the main-process or server output. Do not claim the flow works without evidence from the running app — screenshot it or read the logs.

Notes:

- Everything the flow persists is inside `~/.claxedo-onboarding/<profile>/` (Electron userData + `CLAXEDO_DATA_DIR`). The real `~/.claxedo` and `~/.local/share/opencode` are never touched — if a reset of the real state is what's wanted, that's `script/reset-claxedo-state.sh` instead.
- The onboarding UI is build-time gated on `VITE_CLAXEDO_ONBOARDING_V1=true`, which the script exports; a desktop instance already running holds the SQLite stores open, so quit it before launching (the script refuses unless `--force`).
