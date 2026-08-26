---
name: figma
description: Use when the user wants to work with Figma — implementing a design from a Figma URL, inspecting frames/components/variables, extracting design tokens, or creating and updating Figma files, frames, components, and design-system content on the canvas. Triggers on "figma", Figma file/frame links, "implement this design", "design to code", or "create a figma file".
license: MIT
---

# Figma

The `figma` MCP server (remote, `https://mcp.figma.com/mcp`) is configured for this workspace. Use its tools directly; do not shell out to the Figma REST API unless a tool is missing.

## First use

- The remote server authenticates via OAuth. If a tool call returns an authorization error, tell the user to complete the OAuth flow in their client (the harness will surface the auth URL). No personal access token is required.
- The user must have access to any file or project they ask you to modify.

## Reading designs

- Ask for a Figma file or frame link (URL containing a node-id) and pass it to the server's read tools to get structured design context: layout, typography, variables/tokens, component metadata, and code.
- Prefer Code Connect mappings when the file's components are connected to this codebase.

## Writing to the canvas

- The remote server supports creating and updating native Figma content: frames, auto layout, components, and variables.
- When building new screens, mirror the user's design system: reuse existing variables and components instead of hardcoding values.
- Confirm scope before writing: which file, which page, and whether to create new pages or frames.

## Workflow

1. Resolve the target file from the user's link (or ask for one).
2. Read the relevant nodes and summarize what you found before making changes.
3. Make the change with the smallest set of write calls.
4. Re-read the modified nodes and report the result with a link.

Reference: https://github.com/figma/mcp-server-guide
