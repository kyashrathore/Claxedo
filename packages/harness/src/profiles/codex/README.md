# Codex profile

Codex reads skills from `CODEX_HOME/skills` and project `.agents/skills`, MCP configuration from `config.toml`, and plugins from marketplace entries plus `plugins/cache`. The profile composes the broker provider with a local marketplace and preserves the cache while credentials rotate. The format follows the Codex skills, configuration, and plugins documentation listed in `docs/harness-v2/profiles.md`.
