# Tandem Design System

The visual language for every Tandem surface. Nuxt UI v4 components on Tailwind
CSS v4; tokens are Nuxt UI theme aliases — no custom CSS beyond `main.css`
imports. Dark mode is first-class (class strategy).

## Tokens

| Token | Value | Used for |
|---|---|---|
| Primary color | `amber` | brand marks, primary buttons, focus rings, active nav |
| Neutral color | `zinc` | text, borders, backgrounds, all neutral surfaces |
| App background | `bg-zinc-50` / `dark:bg-zinc-950` | page canvas |
| Body text | `text-zinc-900` / `dark:text-white` | headings + strong text |
| Muted text | `text-zinc-500` / `text-zinc-400` | descriptions, secondary labels |
| Version label | `font-mono text-xs text-zinc-400` | version chips (`v{{ appVersion }}`) |
| Radius scale | Tailwind default (`rounded-xl`, `rounded-2xl`) | logo tiles `2xl`, cards/buttons via UCard/UButton |
| Icons | Lucide (`i-lucide-*`) via @nuxt/icon | every icon, no other sets |
| Fonts | Nuxt UI default stack + `font-mono` for versions/ids | — |

Set in `app/app.config.ts`:

```ts
export default defineAppConfig({
  ui: { colors: { primary: 'amber', neutral: 'zinc' } },
})
```

## Layout

- **Shell**: fixed left sidebar (`USlideover`-free, collapsible) + top bar with
  user chip; content scrolls in the main region. `min-h-screen` canvas.
- **Login**: centered card (`max-w-sm`), logo tile above, brand lockup below.
  Never inside the app shell.
- **Logo tile**: square icon container — `size-12 rounded-2xl bg-primary` with
  `i-lucide-users` in `text-inverted` (login), or `size-9 rounded-xl
  bg-primary/10` with `text-primary` icon (sidebar, compact).

## Components (Nuxt UI laws)

- **Record lists are `UTable` + a single add/edit modal** — never `v-for` +
  `v-model` in pages (the dxup namedLayoutSlots transform breaks v-model over
  v-for aliases in pages). Rows render via slot-scoped cells.
- **Forms**: `UForm` + `UFormField` + `UInput` (`size="lg"` on login). Icons in
  inputs: `i-lucide-mail`, `i-lucide-lock`.
- **Buttons**: `UButton` — primary actions default color; destructive = `color="error"`,
  variant `soft` or `ghost` for row actions.
- **Feedback**: `UAlert` for form errors (login), toasts via `useToast()`.
- **Avatars**: `UAvatar :alt="user.name"` — initials fallback; size `xs` in the
  top bar.
- **Badges/status**: `UBadge` with `color="success" | "warning" | "error" |
  "neutral"` — run/task states map onto these.
- **Modals**: `UModal` for create/edit; one modal per page, opened by row action
  or "New" button.

## Content patterns

- **Milestone placeholder cards** (Overview page): heading + one-line purpose +
  arrival note. Keeps empty states informative.
- **Truncation**: `truncate` on any name/email in chips and table cells;
  min-width guarded by `min-w-0`.
- **Version display**: everywhere the app names itself, the version follows in
  mono zinc-400 — brand consistency signal.

## Do / Don't

- Do use token aliases (`text-primary`, `bg-primary/10`) — never raw amber hex.
- Do keep dark-mode pairs on every custom color class (`dark:` variant).
- Don't introduce a second icon set or font family.
- Don't build custom tables/modals — compose UTable/UModal.
- Don't hand-roll toasts; `useToast()`.
- Empty states get a sentence, not a blank region.

## Accessibility floor

- Every icon-only control carries an `aria-label`.
- Form fields use `UFormField` labels (real `<label>` association).
- Color is never the only signal (badges also carry text).

## Realtime indicators (M2+)

- Live data pages carry a pulsing emerald dot + `live` label next to the page
  title (`animate-ping` outer, solid inner, `size-1.5`)
- Probe results render as `UBadge` `success`/`error` subtle, `sm`, followed by
  the detail line in `text-xs text-zinc-400` truncated with a `:title` tooltip
- Tables are snapshots of a stream: no skeletons after first load — the rows
  swap in place when the SSE snapshot lands
