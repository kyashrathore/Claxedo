# Onboarding

Owns: the first run. A full-screen route (`/welcome`) the shell shows when the server lists no project, drawing the add-project steps as a three-step wizard.

## Concepts

- **Route entry**: `onboardingRoute` (`id`, `path`, `view`) for the shell's `routes` registry; `RouteEntry` is typed here until the shell exports the registry type.
- **Needed?**: `onboardingNeeded(projects)` is true when the project list is ready and empty. The shell decides when to route there.

## State

The wizard has one state per step plus done: `project`, `agent`, `placement`, `done(projectId)`. It is derived (`onboardingState`) from the add-project machine in `@/projects`, which owns the steps, the draft and creation; this domain adds no second machine over the same flow. Where a created project opens is `createdDestination` from `@/projects`.

## Rules the view keeps

- No page scroll: the route is `100dvh` with `overflow: hidden`; only the card body scrolls.
- The card animates its height between steps (`animateHeightChanges`, Web Animations, off under `prefers-reduced-motion`).
- The footer (Back, Skip, Next or Create) stays visible below the scrolling panels.
- Back keeps state: visited step panels stay mounted and hidden.
- One scan: the AI step lists the harnesses the server reports in `capabilities().harnesses`; nothing is re-scanned by the view.
- The AI step reuses the Models rows once `@/settings` exports them; until then it lists the harnesses with a link to Settings → Accounts.

## Phone

One column, 16 px gutters, the steps list wraps, every control is a kit component with a 44 px hit area.

## Flows

- Flow 1: first run on an unsigned desktop: detect agents, add a project, first prompt.
