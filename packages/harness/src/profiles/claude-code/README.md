# Claude Code profile

Claude plugins are local folders containing `.claude-plugin/plugin.json`, skills, agents, commands and optional `.mcp.json`. The Agent SDK accepts them as `{ type: "local", path }` entries in `options.plugins`. See [Claude plugin documentation](https://code.claude.com/docs/en/plugins.md) and the installed SDK `Options.plugins` declaration.

The SDK `settingSources` values `user`, `project` and `local` load the corresponding settings tiers. A brokered session points `CLAUDE_CONFIG_DIR` at a Claxedo owned directory so the person's account files are not loaded. The directory contains freshly copied settings files with credential helpers and credential environment entries removed. The person's settings files are read only. The SDK's `CLAUDE_CONFIG_DIR`, `settingSources` and `plugins` options are documented in [environment variables](https://code.claude.com/docs/en/env-vars.md), [settings](https://code.claude.com/docs/en/settings.md), and its installed `sdk.d.ts`.

An unbrokered machine owner session uses the user's own Claude home and login. Neither path writes settings in that home.
