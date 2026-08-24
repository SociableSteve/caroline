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
stock token set in oklch at the values `shadcn init` emits, with one addition named in the table
below. `web/styles.css` is left with the theme import, the two palettes, a compatibility layer the
public site build reads out of it, and the handful of element-level rules that apply everywhere
rather than to one surface. A colour decision on a surface is checked against the token table below
and against the rules that follow it, not against a stylesheet rule, because there is no stylesheet
rule left to check it against.

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
and `web/styles.css` declares those names in an unlayered `:root` block, which beats the same names
in Tailwind's own theme block because that block is inside `@layer theme` and a layered declaration
loses to an unlayered one of equal specificity. So the values here are the values the utilities
emit, and it is the layer rather than the source order that decides: moving the block into a layer
would hand the override back to Tailwind's own defaults. Criterion 9 turns on the same rule, for
`:focus-visible` against the `outline-none` utility.

| Token | Utility | Value | For |
| --- | --- | --- | --- |
| `--text-xs` | `text-xs` | `0.75rem` | Badges, a column's count, the chat rail's own text |
| `--text-sm` | `text-sm` | `0.875rem` | Captions, controls, ages, secondary detail |
| `--text-base` | `text-base` | `1rem` | Body text, card titles, list items, an input's own text |
| `--text-lg` | `text-lg` | `1.125rem` | Panel headings |
| `--text-xl` | `text-xl` | `1.75rem` | The one figure a surface leads with |

`--text-xl` is the only one of the five this application overrides: Tailwind's own `--text-xl` is
`1.25rem`, one step above the panel heading below it, which is a difference rather than a hierarchy.

The client also writes arbitrary pixel sizes, and they are a real part of what the surfaces spend
rather than an accident. One of them is not small print at all: `text-[13px]` sits between
`--text-xs` (`0.75rem`, 12px) and `--text-sm` (`0.875rem`, 14px), so it is a sixth rung inside the
scale rather than a size below it. Its ten uses are a control's own text and a compact title: quick
capture's five controls, the two Jobs panel headings, a navigation link, a plan item's title on the
dashboard, and a project's title in the Projects table. No card is among them, and it is not the
most used of the four either: `text-[11px]` is, with thirty-two uses against these ten. The other
three are below `text-xs`: `text-[11px]` for facts, change notes, quick capture's own labels and the
day bar's legend, `text-[10px]` for a table's column labels, the day bar's two end times and the
dashboard rail's strip heading, and `text-[9px]` for a transcript's role. A sixth rung nobody
named, plus three ranks of small print, is more than a scale of five sizes wants, and naming them
here is the honest version of the claim that the scale is short.

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
the select, a failure block. `rounded-md` (`0.5rem`) is for cards, menus, dialogs,
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
value below is the one `web/styles.css` declares, and the table is the whole of both palettes rather
than a selection from them.

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
| `--muted` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A sunk ground: a quiet badge, a status line, a quoted scope |
| `--muted-foreground` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | Secondary text, still AA on its own ground |
| `--accent` | `oklch(0.269 0 0)` | `oklch(0.97 0 0)` | A hover or highlighted ground in the client, and nothing else there |
| `--accent-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Text while that ground is showing |
| `--destructive` | `oklch(0.704 0.191 22.216)` | `oklch(0.577 0.245 27.325)` | Something wrong, failed or overdue |
| `--destructive-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | Text on a filled destructive action |
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

`--destructive-foreground` is the one name in the table that stock shadcn no longer generates. It
dropped the token and writes `text-white` on `Button`'s destructive variant instead, which this
palette cannot follow: `#fff` on the dark palette's `--destructive` (`oklch(0.704 ...)`, a light
red) is about 2.9:1, well under the 4.5:1 the contrast rule below asks of a control's label. So the
pairing is declared rather than assumed, dark text on the light red and white on the dark one. Those
two compute to about 6.2:1 on the dark palette and just over 4.5:1 on the light one, so the light
pairing clears the rule narrowly rather than comfortably and is the one to recheck if either value
is ever retuned. Criterion 23 holds every `*-foreground` utility the client writes to a token a
palette actually declares. `@theme inline` already mapped `--color-destructive-foreground`, so before this the
utility resolved to nothing and the label fell back to whatever colour it inherited.

**`--accent` is not the accent.** This is the trap in the table and the one that has already caused
a wrong colour choice on a surface. In the palette this spec used to describe, `--accent` was links,
focus and the filled primary action. In shadcn's set it is none of those: it is a near-neutral hover
ground, `oklch(0.97 0 0)` against a white page, which is invisible as a fill and unreadable as text.
The filled action is `--primary`, which is neutral rather than coloured. Focus is `--ring`. The blue
a reader would call the accent is `--chart-2` as a fill and `--chart-1` as text. Reaching for
`bg-accent` because the design wants an accent is the failure mode, and it will pass review by name
while looking like nothing.

That is a rule about the client. `site/styles.css` does write `var(--accent)` as a resting
background, four times, and is right to: it is a hand-maintained sheet over the same palette, where
the near-neutral is exactly what a quoted block and a table stripe want. Criterion 20 is scoped to
`web/` for that reason, and so is every sentence above about what `--accent` is for.

**What is a fill, what is a state, and what is not a surface's decision.**

- **Grounds a surface chooses.** `bg-background` for the page, `bg-card` for a panel or a card,
  `bg-sidebar` for chrome, `bg-muted` or `bg-secondary` for something sunk inside a component, and
  `bg-chart-2` for the one fill that means "this is the work" (planned time on the day bar).
  `bg-destructive` for a filled destructive action.
- **State only, never at rest.** `--accent` and `--accent-foreground`, and their `--sidebar-accent`
  pair in chrome. Every use of them in the client sits behind a state variant: `hover:` on a button
  and a navigation link, `data-[highlighted]:` on a select's item, and `aria-[current=page]:` on the
  navigation link for the surface being shown. Those three and no others, which is what criterion 20
  holds them to. A surface never picks `bg-accent` as a resting ground.
- **Not a colour decision a surface makes at all.** `--ring` belongs to the one global
  `:focus-visible` rule and to nothing else. `--border` and `--input` are hairlines, chosen by the
  component that owns the edge rather than by the surface drawing it. `--primary` and
  `--primary-foreground` belong to `Button`'s `default` variant, so "which control is the primary"
  is a composition decision and never a colour one. The `*-foreground` pairings are fixed: text on
  `bg-card` is `text-card-foreground`, and pairing a foreground with a ground it is not named for is
  how a contrast failure gets written. A pairing whose foreground token is not declared at all is the
  same failure with nothing to see: criterion 23 is that check.

**Opacity-derived fills are sanctioned, for a ground and not for text.** Sixteen tints of a token
are in use in `web/`, and the list is exhaustive of those: `bg-chart-2/15`, `bg-chart-2/35`,
`bg-chart-2/[0.04]`, `bg-chart-2/[0.06]`, `bg-chart-2/[0.08]`, `bg-destructive/5`,
`bg-destructive/10`, `bg-destructive/15`, `bg-destructive/[0.04]`, `bg-foreground/15`,
`bg-muted/30`, `border-border/60`, `border-chart-2/30`, `border-chart-2/50`, `border-destructive/25`
and `border-destructive/40`. It is not exhaustive of opacity-derived fills: the dialog scrim,
`bg-black/65`, is a seventeenth, and it is off the list because it tints a literal rather than a
token, which is the exception the paragraph below states. They are the right tool: a
tint of a token stays a tint of that token in both palettes, where a separately chosen light tone
would be a second palette with one entry in it. The rule is that the opacity modifier goes on a
ground, a border or a hairline, never on text: no `text-<token>/<n>` appears anywhere in the client,
and none should, because a text colour whose contrast ratio depends on an alpha nobody computed is a
contrast claim nobody can check. Criterion 21 is that rule.

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

**The site build's compatibility layer.** Ten aliases onto the tokens above are restated in both
palettes, because their values differ between the two: `--page`, `--ink`, `--ink-quiet`, `--surface`,
`--surface-sunk`, `--surface-raised`, `--line`, `--line-faint`, `--primary-ink` and `--shadow-1`.
Another set sits in `:root` only, because one value serves both palettes: `--leading-tight`,
`--measure`, `--radius-sm` and `--radius-md`, the `--space-1` to `--space-7` scale, `--text-display`,
and copies of `--font-sans` and `--font-mono`. These are the names the old hand-written palette used,
and they survive for one reason: `site/build.ts` extracts the two `:root` blocks by regex to build
the published site's stylesheet, favicon and hero pin, and `site/styles.css` is a hand-maintained
sheet that writes `var(--ink)` and `var(--space-3)` directly (spec 11, criterion 6). Nothing in the
application reads any of the names in either list. They are aliases and not a second palette:
`--surface` is `var(--card)`, `--line` and `--line-faint` are both `var(--border)`, and
`--surface-raised` is `var(--card)` too, so the names that once distinguished four grounds and two
lines now point at two values.

The `--text-*` scale is declared in the same `:root` block and is not part of this layer: the
application does read it, through Tailwind, as the Type section above says. `--text-display` is the
one rung of it that is site-only, which is why it is in the second list and the rest of the scale is
in neither. `--alarm`, `--alarm-surface`, `--scrim`, `--shadow-2`, `--accent-ink` and
`--radius-pill` do not exist at all, in this layer or anywhere else. Adding a name here is adding to
the site's vocabulary, not the application's, and the application should not start reading one.

## Primitives

Five components own the patterns that were being rewritten per surface. A surface composes these; it
does not restyle them, with one exception the client currently carries and this section names rather
than hides. The dashboard's rail renders `Panel` with two overrides at the one call site
(`web/surfaces/Dashboard.tsx`). The region is
`className="mt-auto rounded-lg border border-sidebar-border bg-transparent p-3 shadow-none"`, which
replaces the panel's ground, overrides its radius and draws the neutral line round a region that the
rule below says the grounds are for. The heading is
`headingClassName="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground"`,
which drops the panel's own `text-lg font-normal` for a monospaced small label. That second one is a
sanctioned shape rather than a stray, the strip label the uppercase rule below allows, but it is
still the primitive being restyled by its caller. That is the client failing this section rather than
this section describing the client, the same way the `h1` above is:
criterion 16 constrains the primitive and `Panel` still satisfies it, so nothing fails, and the
honest record is here until the call site changes.

All five are still in `web/components/primitives.tsx`, and each is now built on shadcn's generated
component where there is one to build on, so the primitive is this application's decision about a
pattern and shadcn's implementation of the widget.

**Panel.** A titled region: shadcn's `Card` (`components/ui/card.tsx`) rendered as a `<section>` so
the `region` role survives, on `bg-card`, `rounded-md`, `p-3`, heading at `text-lg font-normal`, and
no border of its own. The caller supplies the heading level, because the heading outline belongs to
the surface rather than to the component, and may supply a `label` where the heading carries a count
that reads as noise in an accessible name. The board's columns are the case: the heading pairs the
status with a count pill and the label says the status and the count in words. The digit that used to
sit beside the name went with the board's keyboard grid (#96, and spec 08's criterion 56).

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
`badge`, `button`, `card`, `dialog`, `input`, `label`, `select` and `textarea`, eight of them since
the board's keyboard grid took `kbd` with it (#96). `Button` is where the filled primary lives, as
its `default` variant. Beside them, `primitives.tsx` also exports a handful of shared class strings
for patterns too small to be components and too repeated to be retyped: `failureClassName`, `emptyClassName`, `changeNoteClassName`, `policyNoteClassName`,
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
inside a dense table. The intent is that a surface does not draw a neutral line round a region it
owns, because that is what the grounds are for.

Six call sites currently do, and they are named here rather than left for a reader to discover, the
same way the `h1` and the `Panel` override are. Four draw `border-border` round a region they own: the
two agenda cards in `web/surfaces/Dashboard.tsx`, the payload region in
`web/components/DetailsPanel.tsx`, and the card in `web/components/TaskCard.tsx`. Two draw
`border-sidebar-border` round one: the dashboard rail's own region in `web/surfaces/Dashboard.tsx`,
and the `Panel` override in the same file that the Primitives section above already names. Nothing
fails: criterion 16 constrains shadcn's `Card` and `Panel`'s composition of it, which is where the
outline habit actually did the damage, and it says nothing about a `<div>` a surface writes for
itself. That is the client failing this paragraph rather than this paragraph describing the client,
and the honest record is here until the call sites change. What the paragraph does not do is state
an absolute the client breaks in six places, which is what it used to.

**Weight is scarce.** Three weights and no others. `font-semibold` is for four things and no more:
the dialog title, the product name in the header, the dashboard's "Needs you" heading and the chat
rail's own heading. `font-medium` marks a card title, a table's column labels, the current item in
the navigation, and the one value in a row that is the point of the row. A panel heading is not on
that list: `Panel` sets its heading at `text-lg font-normal` and earns its rank from the size rather
than the weight. Everything else is `font-normal`. The previous sheet reached for `600` seven times,
which is the same as reaching for it none.

**Uppercase is a small quiet label and nothing else.** Six places uppercase text, each of them at
`text-xs` or below with a letter-spacing beside it: uppercase without tracking is unreadable, and
uppercase at a size a reader reads by costs the word its shape and a screen reader its pronunciation.
What the six are is worth stating exactly, because three of them are headings: a table's column
labels, a transcript's role twice over, the dashboard's "Needs you" `h2`, the same rail's
"Where everything is" `h2`, and a Jobs strip's `h3`. Uppercase on a heading is allowed here and only
here, at `text-[10px]` to `text-xs`, where the heading is a strip label rather than a rank the reader
navigates the document by. Running text and any word carrying a state are never uppercased. The
earlier rule was that nothing is uppercased and nothing is tracked at all, which the client does not
honour and, at this size, should not: criterion 13 is superseded by criterion 18.

**One filled primary per context.** `Button`'s `default` variant is filled in `bg-primary` with
`text-primary-foreground`, and carries the literal `primary` class, so there is one obvious thing to
press. The fill is neutral rather than coloured, which is shadcn's choice and a good one here: the
one coloured thing on a surface should be the work, not the button. The context is a row of controls
or a box that demands a decision, not the surface: a board of review cards has a primary on each
card, because a card is what is being acted on. Two filled primaries in one row is two obvious things
to press, which is none.

**Measure.** Running text is capped at `max-w-[76ch]`, which is roughly 80 characters of this type.
The board's cards and the dashboard's panels are already narrower than that; the chat transcript, the
project list, the dashboard's plan summary and the login screen need the cap stated, and write it.
Settings does not: nothing on it is a paragraph wide enough to need one.

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
No rule in a stylesheet sets `outline: none` to undo it.

Two components do write the `outline-none` utility, on shadcn's select trigger and on its items, and
focus survives both. Tailwind emits every utility inside `@layer utilities`, and a declaration in a
cascade layer loses to an unlayered one of the same specificity whatever the source order, so the
global `:focus-visible` rule wins because it sits outside every layer. That is a fact about where the
rule is written rather than about what it says, which is why criterion 9 asserts the position as well
as the declaration: move the rule into a layer and the utility starts winning, silently.

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

Several of these are stated over "the client", and are checked by sweeping its sources rather than by
rendering, because the appearance model lives in Tailwind utility classes in JSX and there is no
stylesheet left to parse for it. Three things about that method bear on what the criteria below can
and cannot claim, and they are stated here rather than only beside the sweeps, because a reader of a
criterion is owed the limit the criterion depends on.

- **The client is every source under `web/` that ships**, found by walking the directory rather than
  by naming directories in it, and it includes `web/index.html`. The shell is not a TypeScript source
  but it is a place utility classes are written: its mount point carries
  `class="flex h-screen flex-col overflow-y-auto"`. Test support is excluded, because a fixture is
  not something the client draws.
- **Comments come out first, by a scanner and not a parser.** So prose about `oklch()` cannot fail a
  check about an `oklch()` literal. The scanner tracks whether it is inside a quoted string, and it
  has one input it cannot survive: a `/`-delimited regex literal containing a quote inverts its
  parity for the rest of the file, after which it strips more than it should and the sweeps go blind.
  That case is therefore forbidden rather than reasoned about, and a test fails on one. Nothing in
  the client needs such a literal, and the nine it writes carry none. The opposite confusion, an
  apostrophe in JSX text, strips less than it should and shows up as a sweep reporting a
  commented-out utility, which is loud rather than silent.
- **A class string is bounded by the line it is on, or by the quote that opened it.** Criterion 4
  reads from the opening quote to the end of the line, which is what it claims and no more.
  Criterion 18 is the one that needs a window on both sides, because the tracking and the size have
  to be in the same string as the `uppercase`: it reads to the closing quote, and falls back to the
  end of the line where nothing closes it, so a missing quote narrows the window rather than widening
  it to the whole file. Criteria 17, 19, 20, 21 and 23 need no window at all, because each reads its
  verdict off the utility itself, the variant chain in front of it included. Prettier keeps each
  argument of a `cn()` call on its own line, so every class string in the client today is inside
  those bounds, but a class written into a template literal wrapped over several lines would sit past
  them. Widening the bound is worse rather than better: a class of anything-but-a-backtick crosses
  whatever code lies between two template literals, which reports `web/data.ts`, where `panel` is the
  name of a function, as a surface writing its own `Panel`.

1. Every spacing, font size or border radius a rule applies to an element resolves to a token from
   the scales above. A test parses each sheet in this repository and fails on a literal length in any
   of those three properties, so the scales are enforced rather than encouraged. Scoped to what a
   rule applies, the same way criterion 2 is scoped to what a selector applies: the custom properties
   that declare the scales are the rungs being defined rather than a rung being bypassed, so
   `--radius` (`0.625rem`), `--space-1` to `--space-7` and `--text-display` sit outside this
   criterion exactly as the palettes' own literals sit outside criterion 2.
   `web/styles.css` has almost no such declarations left, because the application spaces, sizes and
   rounds in Tailwind utilities; `site/styles.css` has many, and that is where this bites (spec 11,
   criterion 6).
2. No rule in a stylesheet colours an element with a literal: every colour a selector applies is a
   `var(--token)`, so no rule can be right in one theme and wrong in the other. The palettes are
   where the literals necessarily live, and among the custom properties beside them exactly one
   carries a colour written out rather than pointed at: `--shadow-1`, restated per palette, because a
   shadow is a colour and two lengths together and there is no shadow token to point at. A test
   checks both halves, the second as a whitelist, so a second such property fails rather than passing
   unmentioned.
3. Both palettes declare shadcn's whole token set, every value in oklch, with dark unconditioned in
   `:root` and light in `@media (prefers-color-scheme: light)`. There is no manual toggle: no `.dark`
   class and no `data-theme` selector anywhere in the sheet. The set includes
   `--destructive-foreground`, which stock shadcn no longer generates and which criterion 23 is why
   this palette declares.
4. Each of the five primitives has one implementation, and nothing in `web/` writes its own version
   of one: no surface, and no other source in the client either, renders a bare `<dl>`, a bare
   `<label>`, or an element carrying the literal `badge` or `panel` class. The app shell is in scope
   as much as a surface is, because a pattern rebuilt by hand in the chrome is the same duplicate as
   one rebuilt in a panel, and that includes `web/index.html`: the attribute there is `class` rather
   than `className`, and the sweep reads the quoted string rather than the attribute name, so the
   shell needs nothing beyond a comment syntax of its own. The class is caught in whichever quoted string it is written in,
   `className={cn('panel p-3')}` included, which is the form `Panel` itself is written in and therefore
   the form a caller has in front of it to copy; comments come out before the sweep, so prose about a
   details panel is not a hit. The bound is the line the string is written on, which is where every
   class string in the client is written, and it is what a sweep of the text can claim rather than
   more: a class buried in a template literal wrapped over several lines would sit past it.
5. Every surface renders exactly one `h1`, and that `h1` names the surface.
6. Every surface sets `document.title` to a value naming the surface, so the five routes are
   distinguishable in browser history.
7. For each component that carries a state in colour, its rendered text differs between the states,
   asserted per component rather than as a global claim.
8. Where a date or an age is shown, an overdue value and a value due today each render text naming
   that state, and a later value renders neither.
9. Focus is visible on every interactive element, the task card and any disclosure on it included:
   declared once globally on `:focus-visible` as `3px solid var(--ring)` with a `2px` offset, and
   never undone by a rule setting `outline: none`. The rule sits outside every cascade layer, which
   is what makes it beat the `outline-none` utility two components write: Tailwind emits utilities
   inside `@layer utilities`, and a layered declaration loses to an unlayered one of equal
   specificity. A test asserts the position as well as the declaration.
10. **Superseded by criterion 16.** The four grounds are four distinct values in both palettes, so a
    card is never the same colour as the page it sits on, and both lines are defined and differ from
    each other. Withdrawn with the palette it described: shadcn's light palette makes `--card` and
    `--background` the same white, and `--line` and `--line-faint` are both `var(--border)`.
11. `--text-xl` is at least `0.5rem` above `--text-lg`, so a surface heading and a panel heading are
    a rank apart rather than a rounding error apart. Both are declared in `rem`, which the test
    asserts before it compares them: a check that strips the unit and subtracts the numbers cannot
    fail on `--text-xl: 28px`, and the gap this states is a gap in `rem`.
12. **Superseded by criterion 17.** `font-weight: 600` is declared for the surface heading and for
    nothing else, and no rule declares a weight above `600` or below `400`. A test parses the
    stylesheet and lists the offenders. Withdrawn with the stylesheet it parsed: the sheet declares
    no weight at all, and the client sets weight in utilities.
13. **Superseded by criterion 18.** The stylesheet declares no `text-transform: uppercase` and no
    `letter-spacing` at all. Withdrawn because the rule it was written to enforce is not the rule
    this design holds: `web/styles.css` does still declare neither, so the criterion is not failing,
    but `site/styles.css` declares both (its own small labels, on the same terms) and the client
    uppercases six small labels with tracking, deliberately. A criterion that passes only because the
    sheet it parses has nothing left in it is not the check this wants, which is criterion 18's sweep
    of what the client spends.
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
    `font-black`. A variant prefix is not an exemption: the navigation's
    `aria-[current=page]:font-medium` is a weight the client sets and counts as one of the three, so
    the sweep matches the prefix rather than anchoring on the bare utility, which would have read
    `md:font-bold` as no weight at all. Nor does the client set a weight without spelling a `font-`
    utility at all: no `[font-weight:600]` arbitrary property and no `fontWeight` in an inline style,
    neither of which the whitelist can see, because there is no prefix in either of them to read.
18. Every uppercased string in the client is a small quiet label: each occurrence of `uppercase`
    carries a letter-spacing utility and a size at or below `text-xs` in the same class string, so
    nothing at a size a reader reads the document by is uppercased. Three of the six occurrences are
    on headings, which the size bound is what makes acceptable: a strip label written as an `h2` or
    an `h3` for the outline's sake is still small print. "The same class string" is the window stated
    above the criteria, and this is the criterion that depends on it: whichever quote opened last to
    whichever closes it, and the end of the line where nothing does. So the tracking and the size have
    to be beside the `uppercase` rather than somewhere else in the file, and a class written into a
    template literal wrapped over several lines sits outside what this can check.
19. Every colour the client draws comes from a token: no component source writes a hex, `rgb()`,
    `hsl()` or `oklch()` colour literal, and no utility from Tailwind's own palette. An arbitrary
    value on a colour utility is a length or a `var(--token)` and nothing else, which is what closes
    CSS's own colour names: `bg-[rebeccapurple]` and `border-[green]` write no hex, no colour
    function and no family name, and are a colour chosen once for both palettes just the same. The
    dialog scrim, `bg-black/65`, is the one sanctioned exception, and it sits behind everything rather
    than under any text. The prefixes the sweep reads are every Tailwind utility that takes a colour
    and not a list of three, `ring-offset-` among them: `ring-offset-red-500` and
    `ring-offset-[rebeccapurple]` are a colour chosen once for both palettes exactly as
    `ring-red-500` is. A CSS type hint in front of the token is the same thing as the token, so
    `bg-[color:var(--card)]` is legal and `bg-[color:red]` is not.
20. `--accent` is a state ground and never a fill a surface chooses at rest: every `accent` and
    `sidebar-accent` utility in `web/` carries one of three variants, `hover:`,
    `data-[highlighted]:` or `aria-[current=page]:`, and no other. A test whitelists those three and
    fails on a bare occurrence or on a fourth variant, rather than passing anything with a prefix.
    Every utility, and not the three prefixes a sweep is easiest to write for: `ring-accent`,
    `fill-sidebar-accent`, `divide-accent` and `outline-accent` put the near-neutral on a resting
    surface exactly as `bg-accent` does, and a sweep naming only `bg-`, `text-` and `border-` could
    not fail on any of them. The prefix list is the same one criteria 19 and 21 read, and the whole
    variant chain is read off the utility rather than out of a surrounding window.
    The whole variant chain is read and not only its last link, so `md:hover:bg-accent` and
    `dark:hover:bg-accent` fail as prefixes the whitelist does not name rather than passing as the
    `hover:` on the end of them.
    Scoped to the client: `site/styles.css` writes `var(--accent)` as a resting background and is
    outside this. The design's blue is the chart ramp, not `--accent`.
21. Opacity-derived fills are sanctioned for a ground, a border or a hairline and never for text:
    every opacity modifier in the client tints a token the sheet declares, the dialog scrim
    `bg-black/65` excepted, and no `text-<token>/<n>` appears anywhere, so no text colour has a
    contrast ratio that depends on an uncomputed alpha. The exception is carried here rather than
    left to the prose, the way criterion 2 carries `--shadow-1`: the scrim tints a literal, and a
    criterion reading "every modifier names a token" was false as written on the one utility the
    design deliberately allows. Both halves are checked, the second by reading what each modifier
    tints rather than only by looking for tinted text, so `bg-[#abc]/50` and `border-white/30` fail
    on the token rather than passing for want of a pattern that names them. Tailwind's
    font-size-with-line-height shorthand (`text-sm/6`) is not an opacity modifier and is outside
    this; the client writes none.
22. Decoration that carries no meaning of its own is `aria-hidden`, and every quantity it draws is
    stated in words beside it. The day bar's track is the case: it is `aria-hidden="true"` and its
    legend states each figure (spec 08, criteria 45 and 47), which is what exempts its tints from the
    text contrast ratio.
23. Every `*-foreground` utility the client writes resolves to a token a palette declares. Both
    halves are whitelists: every `--color-*` mapping in `@theme inline` points at a name both
    palettes declare, and every `*-foreground` utility in `web/` names one of those mappings,
    whatever prefix it carries: `ring-`, `fill-`, `stroke-`, `divide-`, `outline-`, `placeholder-`, `caret-` and the
    gradient stops take a colour as much as `bg-`, `text-` and `border-` do, so the sweep reads the
    prefix as any utility name rather than as a list of three. Both palettes, and not
    either: `:root` is the selector of the dark block and of the light one inside the media query, so
    a name declared in one of them resolves to nothing in the other, which is this same failure one
    palette narrower. `Button`'s destructive variant is the case that failed it, pairing
    `bg-destructive` with a `text-destructive-foreground` that resolved to nothing, so the label was
    drawn in whatever colour it inherited and its contrast was a claim nobody could check.
    The `*-foreground` half is the bound, and it is narrower than "every colour utility": a utility
    naming a token directly (`bg-card`) is a Tailwind theme key that fails the build when it does not
    exist, where a `*-foreground` resolved through `@theme inline` to an undeclared token failed
    silently, which is why that is the half worth a criterion. What neither this nor criterion 19
    catches is an arbitrary value naming a token that does not exist: `bg-[var(--nope)]` is a
    sanctioned `var(--token)` to criterion 19 and is not a `*-foreground` to this one. None is written
    today, and a sweep for them would assert over an empty set with nothing to keep it honest, so the
    gap is stated here rather than guarded by a vacuous check.
