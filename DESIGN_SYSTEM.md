# Tandem Design System

The visual language for every Tandem surface. Nuxt UI v4 components on Tailwind
CSS v4; colors are Nuxt UI **semantic tokens** — raw palette classes
(`text-zinc-500`, `bg-amber-50`, …) are banned outside `app.config.ts`. Dark
mode is first-class (class strategy); every view must hold in both modes.

## Tokens

| Token            | Value / class                         | Used for                                                |
| ---------------- | ------------------------------------- | ------------------------------------------------------- |
| Primary color    | `amber` (app.config)                  | primary CTAs + brand marks ONLY (see rationing)         |
| Neutral color    | `zinc`                                | everything else                                         |
| Canvas           | `bg-default`                          | page + app shell background                             |
| Elevated surface | `bg-elevated`                         | cards, active segmented toggles, hover rows             |
| Muted surface    | `bg-muted`                            | read-only value chips, subtle fills                     |
| Strong text      | `text-highlighted`                    | headings, values, active states                         |
| Body text        | `text-default`                        | body copy                                               |
| Secondary text   | `text-muted`                          | descriptions, labels, timestamps                        |
| Faint text       | `text-dimmed` (light floor: zinc-500) | placeholders, meta — never darker than zinc-500         |
| Borders          | `border-default` / `divide-default`   | all hairlines                                           |
| SVG fills        | `fill-(--ui-*)` / `stroke-(--ui-*)`   | Tailwind has no `fill-default` namespace                |
| Radius           | `rounded-xl`                          | one radius for brand icon tiles (login, error, sidebar) |
| Icons            | Lucide (`i-lucide-*`) via @nuxt/icon  | dash naming only (`i-lucide-chevron-left`)              |

Set in `app/app.config.ts` (`ui.colors`). The modal/drawer scrim lives there
too: `bg-default/75 backdrop-blur-sm` on overlay slots.

## Accent rationing

Amber is scarce: it belongs to **one primary action per view** (New task,
Create key, Save) and the active nav item. Everything else that marks "active"
— segmented toggles, filter chips, pagination current page — is neutral
(`bg-elevated text-highlighted` or `color=neutral variant=soft`). Status color
comes from `categoryColor()` (`app/utils/ui-labels.ts`), never from amber.

## Shared vocabulary (`app/utils/ui-labels.ts`, auto-imported)

- `categoryColor(category)` — the ONE status→badge-color map (header pills,
  subtask badges, list dots, board dots).
- `categoryLabel(category)` — `waiting_answer` → "Waiting answer" etc.
- `kindLabel(kind)` — `ai` → "AI agent", `human` → "Human".
- Raw enums never reach the DOM (`active`, `ai`, `in_review` are for storage).

## Timestamps

`formatWhenShort()` (`app/utils/format-when.ts`) for dense lists — `HH:MM`
today, `Oct 27, 14:03` otherwise. `formatWhen()` for detail surfaces.
Seconds never render; hydration suppression wraps every locale-dependent span.

## Page anatomy (every page)

1. Navbar title (+ one-line functional subtitle under it, `text-muted`,
   `hidden sm:block`).
2. ONE toolbar row: search left, all actions right, same baseline
   (`size-sm`, `items-center`).
3. Filter chips (horizontally scrollable on mobile, never wrapped).
4. Content. A search input hides while the list is empty and unfiltered.

## Empty states

Rendered by `DataTable` (centered, `py-24`, `size-12` icon, heading + sentence)
with an `#empty-cta` slot — the page's real create button lives INSIDE the
empty state, not only in the toolbar. Filtered-no-results states keep the
search-x icon and never show a CTA.

## Tables & rows

- `DataTable` wraps `UTable`: server paging, debounced search, `:loading`
  always wired; pager hidden at `pageCount <= 1`, current page =
  `color=neutral variant=soft`; no border below the table card.
- Row actions: hover/focus-within reveal on desktop (`md:opacity-0` →
  `group-hover/focus-within:opacity-100`), always visible on mobile. Delete is
  NOT permanently red — `text-muted`, `hover:text-error` — and two-step
  confirmed.
- Status cell: borderless `USelect variant="none"` + `categoryColor` dot.
- Empty assignee renders "Unassigned" with a person icon, never a blank cell.
- Timestamps: `formatWhenShort`.

## Board (kanban)

Single horizontally-scrollable flex row — columns never wrap to a second row.
Each column `min-w-[260px] flex-1`; cards scroll internally; an empty column is
a compact ~120px dashed drop zone (dashed = drop target only). No in-card
status select (the column IS the status; drag & drop moves); card actions live
behind a click kebab (`Auto-assign / Edit / Delete` with the existing confirm).

## Modals & hints

- One modal per page, opened by row action or the toolbar CTA; footer slot
  holds `Cancel` (`variant="outline"`) + a dynamic primary
  ("Create task" / "Save changes").
- `FormHint` icons sit INLINE right after their label text (label slot), open
  on hover, focus, and click (keyboard-reachable).
- One-time secrets render in a `bg-primary/10` alert with a Copy button and a
  "Done — I saved the key" dismiss; delete/revoke confirmations are stacked
  modals whose buttons carry `:loading`.

## Identity chrome

- Version chip renders only for real semver tags — hidden on `dev`/`main`.
- Sidebar footer: one line — name, plus a muted role suffix only when the role
  differs from the name (`Admin` + `admin` shows just "Admin").

## Accessibility floor

- Every icon-only control carries an `aria-label` (always, not only when
  collapsed).
- Toggle/segmented controls expose `aria-pressed`; section labels are real
  headings (`h2`–`h4`), sentence case — no ALL-CAPS tracking-wide eyebrows.
- Touch targets ≥ 32px on mobile-reachable controls; visible focus rings
  everywhere (`focus-visible:`).
- Contrast: `text-dimmed` never below zinc-500-equivalent on light, zinc-400
  on dark; color is never the only signal.

## Do / Don't

- Do use semantic tokens; never raw palette classes in components.
- Don't hand-roll status colors — `categoryColor`.
- Don't build custom tables/modals/pagers — compose `UTable`/`UModal`/UButtons.
- Don't keep `aria-label` only for the collapsed state; don't ship raw enum
  values, internal milestone labels, or codenames in copy.
- Copy: sentence case, active voice, named outcomes ("Note added"), recoverable
  errors ("Couldn't save — try again"), empty states that invite.
