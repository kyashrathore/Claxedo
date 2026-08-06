# Codex theme contract

## Contract

The Codex theme uses the existing colour-only `ThemeVariantBase.overrides` schema. Colour roles live in `codex.json`. Typography, radius, ring, and elevation values live in one `html[data-theme="codex"]` custom-property block in the application appearance layer. Shared component styles continue to own the declarations that consume those properties.

The v2 scale remains a parallel vocabulary. `MenuV2`, `SelectV2`, `TooltipV2`, and `ToastV2` retain their `--v2-background-*`, `--v2-text-*`, `--v2-icon-*`, `--v2-border-*`, and `--v2-elevation-*` consumers. The Codex appearance layer bridges their surface colours and elevation values at the component root.

## Icon selection

Icon selection is an internal `auto | codex | opencode` API:

- `auto` selects Codex glyphs only for the `codex` theme and OpenCode glyphs for every other theme.
- An explicit `codex` or `opencode` selection has precedence until reset to `auto`.
- The override is process-local. The active theme remains the only persisted user preference.
- Theme previews and committed live switches update the shared `Icon`, `ClaxedoIcon`, and `ClaxedoIconV2` consumers through the same signal.

The proprietary Codex sprite remains bundled for every user. Theme-driven selection changes rendering exposure; distribution exposure is unchanged.

## Visual deltas

| Workstream | Surface | Approved delta |
| --- | --- | --- |
| W1 | Non-Codex themes | Shared and application icons render OpenCode glyphs. Codex remains unchanged. |
| W2 | Codex colours | No colour delta. All in-scope v1 dark surface values already use the supplied Codex ramp; the v2 ramp remains independently owned. |
| W4 | Rail sidebar | Proposed: remove the Codex-only ambient edge shadow and retain the semantic sidebar border. |
| W4 | New-session and session composers | Proposed: use the component-owned dock elevation and 0.5px underlay ring instead of the Codex-only inset edge and raised shadow. |
| W4 | Floating context card, environment card, and switcher metadata card | Proposed: use component-owned v2 raised elevation and 8px radius. |
| W4 | Collapsed context-card rail | Proposed: use its component-owned 1px semantic border and 8px radius without the Codex card shadow. |
| W4 | Dialog, dropdown, context menu, popover, select, tooltip, and hand-authored overlay shells | Proposed: preserve the token-driven radius and shadow; use each component's 1px semantic outer border in place of the Codex-only 0.5px shadow ring. |
| W4 | MenuV2 and SelectV2 | Proposed: use the component-owned 6px radius while retaining the Codex surface palette and token-driven elevation. |
| W4 | TooltipV2 | Proposed: use the component-owned 4px radius while retaining the Codex surface palette and token-driven elevation. |
| W4 | Toast and ToastV2 | Proposed: retain their inverted palette and component-owned radius; resolve elevation from their existing shadow tokens. |

W4 begins after the proposed rows are owner-approved.

## Release and rollback

W1, W2, and W4 form separate commits so each visual risk can be reverted independently. A rollback reverts the affected commit and ships a replacement build. Existing `opencode-theme-id` values remain valid: a profile storing `codex` continues to render the restored Codex values, while a profile storing another theme continues to render that theme. Verification covers both a cleared profile, where Codex is selected by default, and a profile carrying a pre-existing theme id.

The validation window is the first release containing each workstream. The owner checks theme-switch errors, missing icon sprite references, unreadable borders, dropped `box-shadow` declarations, and overlay clipping. Any missing glyph, invalid computed shadow, or unapproved visual diff triggers a revert of that workstream.
