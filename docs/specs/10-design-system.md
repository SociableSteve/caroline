# 10. Design system

Spec 08 says what appears on each surface. It does not say what any of it should look like, so each
surface chose for itself, and the result was nine values of border radius, eight font sizes used
interchangeably and ten spacing values for four ranks of gap. This spec is the missing half: the
small set of decisions every surface draws from, and the rules that keep the surfaces reading as one
system rather than five.

What that set is made of changed with the shadcn/ui migration. The scales and the appearance model
below were first built as a hand-written stylesheet over a palette this application invented, in
hex. The migration replaced both: every surface is now Tailwind CSS v4 utility classes written in
JSX plus shadcn/ui's own generated components (`web/components/ui/*`), and the palette is shadcn's
stock token set in oklch, unmodified from what `shadcn init` emits. `web/styles.css` is left with
the theme import, the two palettes, a compatibility layer the public site build reads out of it, and
the handful of element-level rules that apply everywhere rather than to one surface. A colour
decision on a surface is checked against the token table below and against the rules that follow it,
not against a stylesheet rule, because there is no stylesheet rule left to check it against.

Dark is the unconditioned default. `:root` carries shadcn's dark values with no query, no `.dark`
class and no `data-theme` attribute, and `@media (prefers-color-scheme: light)` overrides the same
names with shadcn's light values for a system that prefers light. There is no manual toggle and
there is no third palette, so a colour written as anything but a token is wrong in one of the two
and nothing at runtime will say which.

## Scales

Four scales, deliberately short. A value not on a scale is a defect, not a judgement call: the whole
point is that there is nothing left to decide at the point of use. Three of the four are now
Tailwind's own scales rather than tokens this application invented, so the tables name the utility a
surface writes as well as the token behind it.

**Space.** Tailwind's numeric spacing scale, one multiplier (`--spacing`, `0.25rem`) rather than
seven named steps, so `p-3` is `0.75rem` and `gap-2` is `0.5rem`. The rungs in use, and what each is
for:

| Utility | Value | For |
| --- | --- | --- |
| `*-1` | `0.25rem` | Between a label and its value |
| `*-2` | `0.5rem` | Within a row, between adjacent controls |
| `*-3` | `0.75rem` | Panel padding, between rows of a list |
| `*-4` | `1rem` | Between panels, panel padding at the wider end |
| `*-6` | `1.5rem` | Between the bands of a surface |
| `*-8` | `2rem` | Above a surface's first heading |
| `*-12` | `3rem` | Between major sections of a long surface |

`--space-1` to `--space-7` are still declared in `:root`, at the same seven values, and nothing in
the application reads them. They are there for the public site, which does still write
`var(--space-3)` in a hand-maintained stylesheet: see "The site build's compatibility layer" below.
Half-steps (`gap-1.5`, `p-2.5`, `py-1.5`) are on Tailwind's scale and are used where a control's own
height wants them.

**Type.** Five sizes, three weights, two line heights. This is the one scale of the four that the
application does consume as tokens: Tailwind v4 resolves `text-lg` to `font-size: var(--text-lg)`,
and `web/styles.css` declares those names in `:root` after Tailwind's own theme block, so the values
here are the values the utilities emit.

| Token | Utility | Value | For |
| --- | --- | --- | --- |
| `--text-xs` | `text-xs` | `0.75rem` | Badges, column numbers, keyboard hints |
| `--text-sm` | `text-sm` | `0.875rem` | Captions, controls, ages, secondary detail |
| `--text-base` | `text-base` | `1rem` | Body text, card titles, list items, an input's own text |
| `--text-lg` | `text-lg` | `1.125rem` | Panel headings |
| `--text-xl` | `text-xl` | `1.75rem` | The one figure a surface leads with |

`--text-xl` is the only one of the five this application overrides: Tailwind's own `--text-xl` is
`1.25rem`, one step above the panel heading below it, which is a difference rather than a hierarchy.

Below `text-xs` the client reaches for arbitrary pixel values, and they are a real part of what the
surfaces spend rather than an accident: `text-[13px]` for a card's body, `text-[11px]` for facts,
change notes and the day bar's legend, `text-[10px]` for a table's column labels, and `text-[9px]`
for a transcript's role. Four ranks of small print is more than a scale of five sizes wants, and
naming them here is the honest version of the claim that the scale is short.

Weights are `font-normal` (`400`), `font-medium` (`500`) and `font-semibold` (`600`); nothing is
bolder than `600` and nothing is lighter than `400`. Line height is Tailwind's own `leading-*` where
a rule needs one, and the browser's default otherwise. `--leading-tight` is declared in `:root` for
the site build and the application does not read it.

There is no sixth size for a single large number. The counts were the only thing that wanted one,
and spec 08's dashboard hierarchy condenses them into the state strip, where a number set at three
times the size of the text around it would be the weighting this milestone exists to correct.

Tailwind's preflight resets `h1` to `h6` to `font-size: inherit; font-weight: inherit`, and no
surface sets a size on its own `h1`, so a surface heading currently renders at body size and body
weight, below the `text-lg` panel headings beneath it. That is the client failing this section rather
than this section describing the client: the intent stated here is that a surface heading is a rank
above a panel heading, and criterion 11 holds the tokens to that gap whether or not the `h1` spends
it.

**Radius.** One scale, derived in `web/styles.css` from `--radius` (`0.625rem`), which the shadcn
migration brought with it, and exposed to Tailwind through `@theme inline` so `rounded-md` and
`var(--radius-md)` are the same value. `rounded-sm` (`0.375rem`) is for controls: buttons, inputs,
the select, keyboard hints, a failure block. `rounded-md` (`0.5rem`) is for cards, menus, dialogs,
quoted blocks and the day bar's clock track, and it is what the `Panel` primitive draws.
`rounded-lg` (`0.625rem`) is for the dashboard's rail and its agenda cards, and `rounded-xl`
(`0.875rem`) for a chat turn, a Jobs panel and the Jobs and Projects tables. A pill is Tailwind's
`rounded-full` rather than a token of its own, which is what a badge and the board's count pills
use: there is no `--radius-pill`. The pre-shadcn `4px` and `0.25rem` were one radius written twice,
and `0.35rem` and `0.75rem` were nothing at all.

The day bar takes `rounded-md` like any other bounded region rather than the pill radius the
proportional capacity bar it replaced carried (spec 08, criterion 40): a rounded end on a to-scale
track shaves the first and last minutes of the window it is drawing.

**Colour.** shadcn/ui's stock token set, declared in oklch, in two palettes: `:root` unconditioned
for dark, and `@media (prefers-color-scheme: light)` overriding the same names for light. Every
value below is the one `web/styles.css` declares.

| Token | Dark (`:root`) | Light | For |
| --- | --- | --- | --- |
| `--background` | `oklch(0.145 0 0)` | `oklch(1 0 0)` | The page ground |
| `--foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | Body text |
| `--card` | `oklch(0.205 0 0)` | `oklch(1 0 0)` | A panel or a card: the ground `Panel` draws |
| `--card-foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | Text on a card |
| `--popover` | `oklch(0.205 0 0)` | `oklch(1 0 0)` | A dialog, a menu, the select's list |
| `--popover-foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | Text in one |
| `--primary` | `oklch(0.922 0 0)` | `oklch(0.205 0 0)` | The one filled action: neutral, not coloured |
| `--primary-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | Text on the filled action |
| `--secondary` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A quiet filled ground behind a control |
| `--secondary-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Text on it |
| `--muted` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A sunk ground: a keyboard hint, a quiet badge |
| `--muted-foreground` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | Secondary text, still AA on its own ground |
| `--accent` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A hover or highlighted ground, and nothing else |
| `--accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Text while that ground is showing |
| `--destructive` | `oklch(0.704 0.191 22.216)` | `oklch(0.577 0.245 27.325)` | Something wrong, failed or overdue |
| `--border` | `oklch(1 0 0 / 10%)` | `oklch(0.922 0 0)` | A hairline: a divider, a card's edge |
| `--input` | `oklch(1 0 0 / 15%)` | `oklch(0.922 0 0)` | A control's own edge |
| `--ring` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | The focus outline, and only that |
| `--chart-1` | `oklch(0.809 0.105 251.813)` | `oklch(0.546 0.245 262.881)` | The accent tone as text |
| `--chart-2` | `oklch(0.623 0.214 259.815)` | `oklch(0.546 0.245 262.881)` | The accent tone as a fill: planned time, an open card's edge |
| `--chart-3` | `oklch(0.546 0.245 262.881)` | `oklch(0.623 0.214 259.815)` | A second series, and the site's own links |
| `--chart-4` | `oklch(0.488 0.243 264.376)` | `oklch(0.488 0.243 264.376)` | A third series |
| `--chart-5` | `oklch(0.424 0.199 265.638)` | `oklch(0.424 0.199 265.638)` | A fourth series |
| `--sidebar` | `oklch(0.185 0 0)` | `oklch(0.985 0 0)` | Chrome: the header, the chat rail, the needs-you rail |
| `--sidebar-foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | Text on chrome |
| `--sidebar-accent` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A hovered or current item in chrome |
| `--sidebar-accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Text on it |
| `--sidebar-border` | `oklch(1 0 0 / 10%)` | `oklch(0.922 0 0)` | Chrome's own hairline |

The chart ramp is the only chromatic family in the set apart from `--destructive`, and it is where
this design's blue lives. `--chart-1` and `--chart-2` are the same value in the light palette, and
`--chart-2` and `--chart-3` swap between the two: that is shadcn's own ramp, kept rather than
retuned, and it is why the ramp is used for two ranks (text and fill) rather than five series.

**`--accent` is not the accent.** This is the trap in the table and the one that has already caused
a wrong colour choice on a surface. In the palette this spec used to describe, `--accent` was links,
focus and the filled primary action. In shadcn's set it is none of those: it is a near-neutral hover
ground, `oklch(0.97 0 0)` against a white page, which is invisible as a fill and unreadable as text.
The filled action is `--primary`, which is neutral rather than coloured. Focus is `--ring`. The blue
a reader would call the accent is `--chart-2` as a fill and `--chart-1` as text. Reaching for
`bg-accent` because the design wants an accent is the failure mode, and it will pass review by name
while looking like nothing.

**What is a fill, what is a state, and what is not a surface's decision.**

- **Grounds a surface chooses.** `bg-background` for the page, `bg-card` for a panel or a card,
  `bg-sidebar` for chrome, `bg-muted` or `bg-secondary` for something sunk inside a component, and
  `bg-chart-2` for the one fill that means "this is the work" (planned time on the day bar).
  `bg-destructive` for a filled destructive action.
- **Hover and highlight only.** `--accent` and `--accent-foreground`, and their `--sidebar-accent`
  pair in chrome. Every use of them in the client sits behind a `hover:` or a `data-[highlighted]:`
  variant, which is what criterion 20 holds them to. A surface never picks `bg-accent` as a resting
  ground.
- **Not a colour decision a surface makes at all.** `--ring` belongs to the one global
  `:focus-visible` rule and to nothing else. `--border` and `--input` are hairlines, chosen by the
  component that owns the edge rather than by the surface drawing it. `--primary` and
  `--primary-foreground` belong to `Button`'s `default` variant, so "which control is the primary"
  is a composition decision and never a colour one. The `*-foreground` pairings are fixed: text on
  `bg-card` is `text-card-foreground`, and pairing a foreground with a ground it is not named for is
  how a contrast failure gets written.

**Opacity-derived fills are sanctioned, for a ground and not for text.** `bg-chart-2/35`,
`bg-foreground/15`, `bg-destructive/5`, `bg-muted/30`, `border-chart-2/50`, `border-border/60` and
`bg-chart-2/[0.06]` are all in use, and they are the right tool: a tint of a token stays a tint of
that token in both palettes, where a separately chosen light tone would be a second palette with one
entry in it. The rule is that the opacity modifier goes on a ground, a border or a hairline, never on
text: no `text-<token>/<n>` appears anywhere in the client, and none should, because a text colour
whose contrast ratio depends on an alpha nobody computed is a contrast claim nobody can check.
Criterion 21 is that rule.

**The scrim is the one non-token colour.** The dialog overlay is `bg-black/65`, a literal rather than
a token, because the veil over the page is the same veil in both palettes and it is behind everything
rather than under any text. It is the only exception, and criterion 19 names it as such so that a
second one has to argue for itself.

**Contrast.** Text meets WCAG AA against the ground it is actually sitting on: 4.5:1 for body text
and small print, 3:1 for text at `text-lg` and above. The paired tokens are what make that checkable
without a colour picker, so the obligation in practice is to use the pairing (`bg-card` with
`text-card-foreground`, `bg-primary` with `text-primary-foreground`, `bg-muted` with
`text-muted-foreground`) rather than to measure. A control's own edge and a focus ring are not text
and are held to 3:1 against what is next to them.

Decoration that carries no meaning of its own is exempt from the text ratio, and the price of the
exemption is that it must carry no meaning: it is `aria-hidden`, and every quantity it draws is
stated in words next to it. The day bar is the case the suite already settles this way. Its track is
`aria-hidden="true"`, its blocks are tints of `--chart-2` and `--foreground` chosen to be
distinguishable from each other rather than legible against anything, and the legend beneath it
states meetings, planned, done and the unplanned remainder as figures (spec 08, criteria 45 and 47).
A decorative fill still has to be told apart from its neighbours, which is why the free-time block
carries a dashed border as well as a `6%` tint. Criterion 22 is this clause.

Colour is a second carrier, never the first. Every state that a colour marks also says what it is in
words: a stale wait says "Stale", a completed plan entry says "done" beside the strikethrough, a
calendar block that costs nothing says "declined" or "marked free", and a failed job prints its
error. This rule predates this spec and is kept.

**The site build's compatibility layer.** `:root` and the light override each end with a block of
aliases onto the tokens above: `--page`, `--ink`, `--ink-quiet`, `--surface`, `--surface-sunk`,
`--surface-raised`, `--line`, `--line-faint`, `--primary-ink`, `--shadow-1`, `--leading-tight`,
`--measure`, the `--space-*` and `--text-*` scales, `--text-display`, and copies of `--font-sans` and
`--font-mono`. These are the names the old hand-written palette used, and they survive for one
reason: `site/build.ts` extracts the two `:root` blocks by regex to build the published site's
stylesheet, favicon and hero pin, and `site/styles.css` is a hand-maintained sheet that writes
`var(--ink)` and `var(--space-3)` directly (spec 11, criterion 6). Nothing in the application reads
any of them. They are aliases and not a second palette: `--surface` is `var(--card)`, `--line` and
`--line-faint` are both `var(--border)`, and `--surface-raised` is `var(--card)` too, so the names
that once distinguished four grounds and two lines now point at two values. `--alarm`,
`--alarm-surface`, `--scrim`, `--shadow-2`, `--accent-ink` and `--radius-pill` do not exist at all,
in this layer or anywhere else. Adding a name here is adding to the site's vocabulary, not the
application's, and the application should not start reading one.

## Primitives

Five components own the patterns that were being rewritten per surface. A surface composes these; it
does not restyle them. All five are still in `web/components/primitives.tsx`, and each is now built
on shadcn's generated component where there is one to build on, so the primitive is this
application's decision about a pattern and shadcn's implementation of the widget.

**Panel.** A titled region: shadcn's `Card` (`components/ui/card.tsx`) rendered as a `<section>` so
the `region` role survives, on `bg-card`, `rounded-md`, `p-3`, heading at `text-lg font-normal`, and
no border of its own. The caller supplies the heading level, because the heading outline belongs to
the surface rather than to the component, and may supply a `label` where the heading carries a digit
and a count that read as noise in an accessible name.

**Facts.** The label-and-value grid that the task card, the job panel and the settings policy each
built separately. A plain `<dl>` with `auto` and `1fr` columns, labels and values at `text-[11px]`
and labels in `text-muted-foreground`. No shadcn equivalent, so this one is Tailwind utilities on the
element. One implementation, three callers, and `Fact` is a fragment so the grid's own columns stay
the columns.

**Badge.** A short state, in words, in a `rounded-full` fill of the tone its state calls for: `quiet`
is `bg-muted text-muted-foreground`, `accent` is `bg-chart-2/15 text-chart-1`, and `alarm` is
`bg-destructive/15 text-destructive`. Built on `components/ui/badge.tsx`, whose `cva` table also
carries the `outline`, `secondary`, `ghost` and `link` variants shadcn generates. Badges never
abbreviate to a colour alone and never carry a tooltip as their only text.

**Field.** A label above a control, wired together by wrapping, built on shadcn's `Label`
(`components/ui/label.tsx`, Radix underneath), which still renders a real `<label>`. Every form on
every surface uses it, so there is one answer to where a label sits, and `hiddenLabel` is for a
control whose purpose the surrounding text already gives.

**ActionRow.** A row of controls with the primary action first, at `gap-2`, which wraps without
changing the order. Plain utilities on a `<div>`: shadcn has no component for a layout row and none
is needed. Where the row would exceed the width available, the secondary controls move behind a
disclosure rather than onto a second line: see spec 08 for the card.

Two layers sit either side of these. Below them, `web/components/ui/*` is shadcn's generated set,
hand-vendored rather than pulled by the CLI because this environment has no access to the registry:
`badge`, `button`, `card`, `dialog`, `input`, `kbd`, `label`, `select` and `textarea`. `Button` is
where the filled primary lives, as its `default` variant. Beside them, `primitives.tsx` also exports
a handful of shared class strings for patterns too small to be components and too repeated to be
retyped: `failureClassName`, `emptyClassName`, `changeNoteClassName`, `policyNoteClassName`,
`payloadPreviewClassName`, `itemOpenClassName` and `tableHeaderClassName`. A surface reaches for one
of those rather than writing the same six utilities again.

## Rules

The appearance model first, because it is what the four scales did not settle, and then the rules
that hold whatever the appearance is.

**A region is placed by its ground, not by an outline round it.** A panel is `bg-card` and draws no
border; the page behind it is `bg-background`; chrome is `bg-sidebar`; something sunk inside a
component is `bg-muted` or `bg-secondary`. The rule this replaces is the habit of giving everything a
`1px` box, which is what "everything is a box inside a box" meant on six surfaces at once.

The honest limit of this rule is that shadcn's light palette makes `--card` and `--background` the
same white, so in light mode a panel has no ground of its own to be placed by and separation falls to
spacing, to the hairline where a component draws one, and to the shadow. In dark mode the ramp is
real: `oklch(0.145)` for the page, `0.185` for chrome, `0.205` for a card, `0.269` for a well. The
four-ground ramp this spec once claimed in both palettes is gone, and criterion 10 is superseded
rather than quietly reworded, because it was a claim about the palette and the palette changed.

**Hairlines are the component's, not the region's.** `border-border` is a divider between the rows of
a list, a table or a strip and the edge of a card that has one; `border-input` is a control's own
edge; `border-sidebar-border` is chrome's. `border-border/60` is the same hairline made quieter
inside a dense table. No surface draws a neutral line round a region it owns: that is what the
grounds are for.

**Weight is scarce.** Three weights and no others. `font-semibold` is for a dialog title, the product
name and the two strip headings that are the point of the strip. `font-medium` marks a panel heading,
a card title, the current item in the navigation, and the one value in a row that is the point of the
row. Everything else is `font-normal`. The previous sheet reached for `600` seven times, which is the
same as reaching for it none.

**Uppercase is a small quiet label and nothing else.** Six places uppercase text, each of them a
column label, a strip heading or a transcript's role, and each of them at `text-xs` or below with a
letter-spacing beside it: uppercase without tracking is unreadable, and uppercase at a size a reader
navigates by costs the word its shape and a screen reader its pronunciation. Running text, headings
and any word carrying a state are never uppercased. The earlier rule was that nothing is uppercased
and nothing is tracked at all, which the client does not honour and, at this size, should not:
criterion 13 is superseded by criterion 18.

**One filled primary per context.** `Button`'s `default` variant is filled in `bg-primary` with
`text-primary-foreground`, and carries the literal `primary` class, so there is one obvious thing to
press. The fill is neutral rather than coloured, which is shadcn's choice and a good one here: the
one coloured thing on a surface should be the work, not the button. The context is a row of controls
or a box that demands a decision, not the surface: a board of review cards has a primary on each
card, because a card is what is being acted on. Two filled primaries in one row is two obvious things
to press, which is none.

**Measure.** Running text is capped at `max-w-[76ch]`, which is roughly 80 characters of this type.
The board's cards and the dashboard's panels are already narrower than that; the chat transcript, the
project list and the settings prose need the cap stated.

**Numbers that line up get tabular figures.** Ages in a chase list, times in the calendar column and
on the day bar, counts in the history and ranks in the plan are read down the column, and
proportional digits make that harder than it needs to be. The client writes
`[font-variant-numeric:tabular-nums]`, since Tailwind's own `tabular-nums` utility and this are the
same declaration.

**Time states say which they are.** A date on its own asks the reader to know today's date and do the
comparison. Anywhere a due date, a deferral or an age is shown, the state is named: overdue, today,
or the date. This is spec 08's card rule generalised, because the plan and the project drill-in show
the same dates.

**One heading outline per surface.** Each surface opens with a single `h1` naming itself, and its
panels are `h2` beneath it. Before this rule the client had exactly one `h1`, the word "Caroline" in
the header, which left every surface's outline headless and every browser tab identically labelled.

**Focus is always visible**, declared once globally as `3px` of `var(--ring)` with a `2px` offset on
`:focus-visible`, on every interactive element including the cards and any disclosure added to them.
Nothing anywhere sets `outline: none` on a focusable element to undo it.

**Both themes are designed, not inverted.** A colour is only ever a token, written as a Tailwind
`*-<token>` utility or as `var(--token)` in the stylesheet, so no rule can be correct in one theme
and wrong in the other. Dark is the base and light is the override, which is the opposite of the
usual arrangement and is worth knowing before reading the sheet.

## Non-goals

- **User-facing theming.** Spec 08's non-goal stands. These tokens exist so that Caroline is
  internally consistent, not so that anybody can restyle it. There is no theme picker, no accent
  choice, no density setting and no light/dark toggle: the system preference is the only input.
- **A component library.** shadcn's generated components are vendored into this repository and
  edited in place, which is what shadcn is for. Five primitives on top of them, in this
  application's own directory, taking the props this application needs. No package, no documentation
  site, no props for cases that do not occur.
- **A third palette.** Light and dark are the two. High contrast and print are out of scope.
- **Motion.** No animation, no entrance or exit transitions, and nothing that changes state slowly
  enough to need one. The single exception is the `transition-colors` shadcn's `Button` ships with,
  on hover, which is kept because removing it from the vendored variant table would be a diff
  against upstream for no gain.
- **An icon set.** States are words. An icon that carries meaning no text carries would break the
  colour rule in a different alphabet.
- **Retuning shadcn's tokens.** The stock values are kept, the chart ramp's duplicated rungs
  included. A bespoke palette is what the migration removed, and reintroducing it one token at a
  time is how it comes back.

## Acceptance criteria

1. Every declaration of a spacing, font size or border radius in a stylesheet in this repository
   resolves to a token from the scales above. A test parses each sheet and fails on a literal length
   in any of those three properties, so the scales are enforced rather than encouraged.
   `web/styles.css` has almost no such declarations left, because the application spaces, sizes and
   rounds in Tailwind utilities; `site/styles.css` has many, and that is where this bites (spec 11,
   criterion 6).
2. No rule in a stylesheet declares a colour literal. Every colour is a `var(--token)`, so no rule
   can be right in one theme and wrong in the other.
3. Both palettes declare shadcn's whole token set, every value in oklch, with dark unconditioned in
   `:root` and light in `@media (prefers-color-scheme: light)`. There is no manual toggle: no `.dark`
   class and no `data-theme` selector anywhere in the sheet.
4. Each of the five primitives has one implementation, and no surface writes its own version of one:
   no surface renders a bare `<dl>`, a bare `<label>`, or an element carrying the literal `badge` or
   `panel` class.
5. Every surface renders exactly one `h1`, and that `h1` names the surface.
6. Every surface sets `document.title` to a value naming the surface, so the five routes are
   distinguishable in browser history.
7. For each component that carries a state in colour, its rendered text differs between the states,
   asserted per component rather than as a global claim.
8. Where a date or an age is shown, an overdue value and a value due today each render text naming
   that state, and a later value renders neither.
9. Focus is visible on every interactive element, the task card and any disclosure on it included:
   declared once globally on `:focus-visible` as `3px solid var(--ring)` with a `2px` offset, and
   never undone by a rule setting `outline: none`.
10. **Superseded by criterion 16.** The four grounds are four distinct values in both palettes, so a
    card is never the same colour as the page it sits on, and both lines are defined and differ from
    each other. Withdrawn with the palette it described: shadcn's light palette makes `--card` and
    `--background` the same white, and `--line` and `--line-faint` are both `var(--border)`.
11. `--text-xl` is at least `0.5rem` above `--text-lg`, so a surface heading and a panel heading are
    a rank apart rather than a rounding error apart.
12. **Superseded by criterion 17.** `font-weight: 600` is declared for the surface heading and for
    nothing else, and no rule declares a weight above `600` or below `400`. A test parses the
    stylesheet and lists the offenders. Withdrawn with the stylesheet it parsed: the sheet declares
    no weight at all, and the client sets weight in utilities.
13. **Superseded by criterion 18.** The stylesheet declares no `text-transform: uppercase` and no
    `letter-spacing` at all. Withdrawn: the client does uppercase six small labels, deliberately,
    and each carries the tracking that makes uppercase readable.
14. The one filled primary is `Button`'s `default` variant, filled `bg-primary` with
    `text-primary-foreground` and carrying the literal `primary` class, and no row of controls on any
    surface renders more than one of them.
15. **Superseded by criterion 16.** A card is raised by `--shadow-1` and declares no border, and
    every shadow in the sheet is a token, so no shadow can be right in one theme and wrong in the
    other. Withdrawn: `--shadow-1` survives only in the site build's compatibility layer, and the
    client's shadows are Tailwind's own `shadow-*` steps.

The shadcn/ui migration adds the following, appended rather than renumbered because the code and the
suite cite the numbers above.

16. A region is placed by its ground and its radius rather than by an outline: shadcn's `Card`
    declares `bg-card`, `text-card-foreground` and `rounded-md`, and no border of its own, and
    `Panel` composes it without adding one.
17. The client sets weight in three utilities and no others: `font-normal`, `font-medium` and
    `font-semibold`. No component uses `font-light`, `font-thin`, `font-bold`, `font-extrabold` or
    `font-black`.
18. Every uppercased string in the client is a small quiet label: each occurrence of `uppercase`
    carries a letter-spacing utility and a size at or below `text-xs` in the same class string, so no
    heading a reader navigates by and no running text is uppercased.
19. Every colour the client draws comes from a token: no component source writes a hex, `rgb()`,
    `hsl()` or `oklch()` colour literal. The dialog scrim, `bg-black/65`, is the one sanctioned
    exception, and it sits behind everything rather than under any text.
20. `--accent` is a hover or highlighted ground and never a fill a surface chooses: every `accent`
    and `sidebar-accent` utility in the client sits behind a `hover:` or `data-[highlighted]:`
    variant. The design's blue is the chart ramp, not `--accent`.
21. Opacity-derived fills are sanctioned for a ground, a border or a hairline and never for text:
    every opacity modifier in the client names a token, and no `text-<token>/<n>` appears anywhere,
    so no text colour has a contrast ratio that depends on an uncomputed alpha.
22. Decoration that carries no meaning of its own is `aria-hidden`, and every quantity it draws is
    stated in words beside it. The day bar's track is the case: it is `aria-hidden="true"` and its
    legend states each figure (spec 08, criteria 45 and 47), which is what exempts its tints from the
    text contrast ratio.
