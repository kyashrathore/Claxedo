/**
 * Applied to every dropdown surface that hangs off the composer dock: the `+`
 * action menu, the effort menu inside the model control, the model popover, and
 * the project/environment/worktree pickers in the context row.
 *
 * Those four are built on three different primitives — MenuV2 (28px rows, 12px
 * padding, 2px container), Select (2px/8px rows, 4px container, 104px min-width)
 * and List-in-a-Popover (6px/8px rows) — so left alone they open at three
 * different widths with three different row rhythms right next to each other.
 * The class normalises row height, padding, radius and width across all three;
 * see `.claxedo-composer-menu` in src/app/styles/index.css.
 */
export const COMPOSER_MENU_CLASS = "claxedo-composer-menu"
export const COMPOSER_COMPACT_MENU_CLASS = `${COMPOSER_MENU_CLASS} claxedo-composer-menu-compact`
export const COMPOSER_HARNESS_MENU_CLASS = `${COMPOSER_MENU_CLASS} claxedo-composer-menu-harness`
