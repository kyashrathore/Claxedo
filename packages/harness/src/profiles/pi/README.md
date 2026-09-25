# Pi profile

Pi 0.85.1 discovers global extensions from `$PI_CODING_AGENT_DIR/extensions` and skills from its agent and project directories. Its `-e` and `--skill` flags add entries to that discovery set. There is no MCP intake. Sources: pinned Pi `docs/extensions.md`, `docs/skills.md`, and `README.md` under `packages/harness/e2e/.artifacts/pi/node_modules/@earendil-works/pi-coding-agent`.

`PI_CODING_AGENT_DIR` also contains `auth.json`, `models.json`, settings, packages and sessions. Replacing it hides the person's login and extensions. Source: pinned Pi `docs/environment-variables.md`. Owner turns use that folder without writing it. Member turns use a Claxedo folder scoped to the workspace and session, so simultaneous members cannot replace each other's credential overlay. Its `models.json` carries broker placeholders; the placeholder paths and provider environment keys follow Pi's built-in provider definitions and the existing `packages/agent-sdk-runtime/src/harnesses/pi/auth.ts` mapping.

Session files are placed under Claxedo state with `--session-dir` for both kinds. This keeps the person's profile files untouched while allowing resume. Pi RPC's `--session-dir`, `--session`, and `get_commands` are documented in pinned Pi `docs/rpc.md`.
