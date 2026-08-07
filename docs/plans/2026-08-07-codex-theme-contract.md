# Codex theme contract

## Contract

The Codex theme uses the existing colour-only `ThemeVariantBase.overrides` schema. Colour roles live in `codex.json`. Typography, radius, ring, and elevation values live in one `html[data-theme="codex"]` custom-property block in the application appearance layer. Shared component styles own the declarations that consume those properties and provide their existing values as fallbacks, so themes that do not assign the generic geometry inputs remain byte-for-byte equivalent at computed style.

The v2 scale remains a parallel vocabulary. `MenuV2`, `SelectV2`, `TooltipV2`, and `ToastV2` retain their `--v2-background-*`, `--v2-text-*`, `--v2-icon-*`, `--v2-border-*`, and `--v2-elevation-*` consumers. Their floating shells also consume the same generic overlay geometry inputs as v1, with their current hard-coded radii and v2 elevations as fallbacks. The Codex appearance layer bridges their surface colours and assigns the shared geometry values at the theme root.

## Geometry ownership

| Role | Component-owned declaration | Codex value |
| --- | --- | --- |
| Overlay shell | `border-radius: var(--surface-overlay-radius, <existing radius>)` | `10px` |
| Overlay edge | `border: var(--surface-overlay-border, <existing border>)` | `0` |
| Overlay elevation | `box-shadow: var(--surface-overlay-shadow, <existing shadow>)` | two-layer drop plus a 0.5px outset ring |
| Raised card | radius, border, and shadow read `--surface-card-*` with existing component values as fallbacks | `10px`, `0`, and the Codex card ring plus two washes |
| Composer | the dock shell reads `--surface-composer-shadow` with its existing v2 elevation as fallback | 1px inset composer edge plus the Codex raised shadow |
| Sidebar | the sidebar owns its shadow declaration and reads `--surface-sidebar-shadow` | Codex card ring plus the sidebar washes |

The variables are role-based rather than theme-based. A component may consume a role only where it owns the corresponding declaration. The theme block supplies values; it does not select components or restate `border`, `border-radius`, or `box-shadow` declarations.

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
| W4 | Rail sidebar | No visual delta. Preserve the Codex sidebar ring and ambient washes through `--surface-sidebar-shadow`. |
| W4 | New-session and session composers | No visual delta. Preserve the 1px inset composer edge and Codex raised shadow through `--surface-composer-shadow`. |
| W4 | Floating context card, environment card, switcher metadata card, and collapsed context-card rail | No visual delta. Preserve the 10px radius, zero border, and Codex card elevation through `--surface-card-*`. |
| W4 | Dialog, dropdown, context menu, popover, select, tooltip, and hand-authored overlay shells | No visual delta. Preserve the 10px radius, zero border, two-layer drop, and 0.5px outset ring through `--surface-overlay-*`. |
| W4 | MenuV2, SelectV2, and TooltipV2 | No visual delta in Codex. Bridge their shell geometry to `--surface-overlay-*`; retain their existing 6px or 4px radius and v2 elevation in every other theme. |
| W4 | Toast and ToastV2 | No visual delta. Retain their inverted palette and existing component-owned geometry. |

## Release and rollback

W1, W2, and W4 form separate commits so each visual risk can be reverted independently. A rollback reverts the affected commit and ships a replacement build. Existing `opencode-theme-id` values remain valid: a profile storing `codex` continues to render the restored Codex values, while a profile storing another theme continues to render that theme. Verification covers both a cleared profile, where Codex is selected by default, and a profile carrying a pre-existing theme id.

The validation window is the first release containing each workstream. The owner checks theme-switch errors, missing icon sprite references, unreadable borders, dropped `box-shadow` declarations, and overlay clipping. Any missing glyph, invalid computed shadow, or unapproved visual diff triggers a revert of that workstream.
