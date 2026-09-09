# UI_UX_DESIGN.md

## Direction

70% premium minimalism, 30% selective glassmorphism. Predominantly white and
warm ivory, with peach and deep red as accents rather than fields of colour.

---

## Palette

Surfaces carry almost all the area. Brand colours are used sparingly and
deliberately.

| Token | Hex | Used for |
|---|---|---|
| `canvas` | `#FCFAF8` | Page background, warm off-white |
| `canvas-tint` | `#F5F0EC` | Premium ivory, secondary fills |
| `canvas-deep` | `#EFE7E1` | Rare third level |
| `surface` | `#FFFFFF` | Cards, tables, panels |
| `surface-raised` | `#FBF7F4` | Nested surfaces |
| `peach-light` | `#FCE6DC` | AI accents, active nav |
| `peach-soft` | `#F8C7B5` | Gradient midpoint |
| `peach` | `#F3A58B` | Chart fills, brand highlight |
| `wine` | `#7A1F2B` | Primary buttons, links, emphasis |
| `wine-deep` | `#5A1420` | Gradient end, auth panel |
| `wine-rose` | `#A63A45` | Rose accent |
| `ink` | `#1C1717` | Primary text |
| `ink-muted` | `#6F6663` | Secondary text |
| `ink-faint` | `#9A908C` | Labels, axis ticks |
| `line` | `rgba(122,31,43,0.10)` | Borders — red-tinted, never grey |

### One conflict, resolved deliberately

Deep red is the brand colour. Red is also the natural signal for *critical
stock*. If both are the same red, the interface loses its single most important
distinction — a store manager scanning a table can't tell brand chrome from a
product about to stock out.

So the two are separated by register. The brand owns the deep wine end
(`#7A1F2B` / `#5A1420`) and appears on chrome: buttons, the sidebar mark, the
auth panel. Status colours sit in a muted, earthy range that reads as
information rather than decoration:

| Status | Hex | Why this value |
|---|---|---|
| Healthy | `#2E6B4F` | Muted forest, not a bright success green |
| Low stock | `#B8792C` | Warm amber, sits with peach |
| Critical | `#A63A45` | Brighter rose — separates cleanly from wine chrome |
| Overstock | `#4A5578` | Slate indigo, the one cool tone, so surplus reads as distinct from risk |

Status is never carried by colour alone. Every chip pairs a dot with a text
label, so it survives greyscale printing and colour-blind vision.

---

## Typography

Two families, clearly distinct in role.

**Fraunces** (variable serif) — page titles, KPI figures, brand. Carries the
luxury-retail register that a neutral grotesque cannot. Restricted to headings
so it never competes with dense data.

**Inter** — all UI text, tables, forms, labels. Chosen for legibility at small
sizes and for tabular figures.

Numerals in tables and KPIs use `font-variant-numeric: tabular-nums` via the
`.tnum` class, so digits align column to column and a changing value doesn't
shift the layout.

Headings carry `-0.012em` tracking. Body text is left unadjusted.

---

## The 30% glass rule

Glass is expensive attention. It is applied to exactly four kinds of surface —
things that float above the page:

1. The authentication card
2. Modals and dialogs
3. AI insight panels, including the dashboard daily briefing
4. Sticky action bars, such as the replenishment submit tray

Everything else — tables, KPI cards, forms, list rows, the sidebar — uses the
flat `.panel` surface: white, a hairline red-tinted border, and a warm shadow.

```css
.glass {
  background: rgba(255, 255, 255, 0.66);
  backdrop-filter: blur(22px) saturate(150%);
  border: 1px solid rgba(255,255,255,0.6);
}
```

Glass over a plain white background is invisible, so glass surfaces always sit
on the peach wash (`.wash-peach`) or the wine gradient. Where there's nothing to
refract, the flat panel is used instead.

---

## Shadows

Warm-tinted, never neutral grey. Grey shadows over ivory read as dirt.

```
card:  0 1px 2px rgba(90,20,32,.04), 0 8px 24px -16px rgba(90,20,32,.14)
lift:  0 2px 6px rgba(90,20,32,.06), 0 24px 48px -24px rgba(90,20,32,.22)
```

Three elevation levels total: flat, card, lift. More than that stops reading as
hierarchy.

---

## Motion

Motion answers actions. There are no ambient animations, no per-card hover
lifts, no staggered scroll reveals.

| Moment | Treatment |
|---|---|
| Auth card entrance | One `fade-rise`, 500ms, on mount |
| Sign-in button, in flight | A sheen sweep across the button while the request is open |
| Sign-in success | Checkmark, then a 520ms transition to the dashboard |
| Error appearing | `fade-rise` on the error block only |
| Sidebar (mobile) | Transform slide, 200ms |
| Buttons | `active:scale-[.985]` — a press, not a bounce |

**The sign-in animation reflects the real request.** The button label moves
through `Verifying credentials` → `Loading your workspace` → `Signed in`, driven
by actual promise state. Nothing runs on a timer pretending work is happening;
if the request fails at 40ms, the animation stops at 40ms.

`prefers-reduced-motion: reduce` collapses every duration to 0.01ms globally.

---

## Login screen

Split layout, collapsing to a single column below `lg`.

**Left** — the only full-strength wine gradient in the product
(`#7A1F2B → #5A1420 → #3D0D16`), with a soft peach radial bloom. Carries the
headline and three verbs: Forecast, Detect, Act.

**Right** — the glass card on ivory: Google, a divider, email and password,
show/hide, keep-me-signed-in, forgot password, Turnstile when configured.

The brand mark is three bars of unequal height — stock levels — rather than a
generic box or cube icon.

Copy avoids marketing language. The subtext states what the product does with
your data: *"Every figure traces back to data you imported. Where a number is
estimated rather than measured, the interface says so."*

---

## Dashboard

Progressive disclosure over density.

1. **Greeting** — time-aware, names the active store and date
2. **AI daily briefing** — glass, on peach wash; three to five sentences, each
   naming a specific product and a specific number
3. **Six KPI cards** — flat panels, Fraunces figures, tabular numerals
4. **Two charts** — 30-day sales area chart, inventory health bars
5. **Two lists** — highest stockout risk, fastest moving

Charts were retuned from the previous dark theme: peach gradient fills, wine
strokes, red-tinted gridlines at 10% opacity, white tooltips with warm shadows.

---

## Honesty in the interface

A design decision, not a technical one. Numbers the engine *estimated* rather
than *measured* carry a visible `Estimated` tag, with a tooltip explaining that
the figure was derived from store-level patterns rather than observed SKU sales.
Products with no sales history show `No sales history` instead of a fabricated
zero.

Error states name what failed and what to do about it. Empty states are
invitations with a button attached, not apologies.

---

## Responsive behaviour

| Breakpoint | Behaviour |
|---|---|
| `< 640px` | Single column, sidebar becomes an overlay drawer, KPIs two-up, tables scroll horizontally with the product column sticky, search collapses into the top bar |
| `640–1024px` | KPIs three-up, charts stack, sidebar still a drawer |
| `≥ 1024px` | Sidebar pinned, auth splits to two columns, charts sit side by side |
| `≥ 1280px` | KPIs six-up in a single row |

The mobile layout reorders rather than shrinking. On the replenishment screen,
the desktop metric grid becomes a two-column stack and the submit tray docks to
the bottom of the viewport, because a manager approving stock on a phone needs
the action reachable by thumb.

---

## Accessibility

- Body text meets WCAG AA on ivory (`#1C1717` on `#FCFAF8` ≈ 15.8:1)
- `ink-muted` on white ≈ 5.9:1, above the 4.5:1 threshold
- Visible focus rings on every interactive element: 2px wine at 40%, offset 2px
- Status conveyed by icon and text, never colour alone
- OTP inputs are individually labelled and support paste into any box
- Reduced motion honoured globally
- Every icon-only button carries an `aria-label`
