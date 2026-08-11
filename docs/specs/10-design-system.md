# 10. Design system

Spec 08 says what appears on each surface. It does not say what any of it should look like, so
each surface chose for itself, and the result was nine values of border radius, eight font sizes
used interchangeably and ten spacing values for four ranks of gap. This spec is the missing half:
the small set of decisions every surface draws from, and the rules that keep the surfaces reading
as one system rather than six.

The colour palettes are the exception. They were specified in spec 08 from the start, they meet
AA in both themes, and they are moved here unchanged so that all of the visual decisions live in
one place.

## Scales

Four scales, deliberately short. A value not on a scale is a defect, not a judgement call: the
whole point is that there is nothing left to decide at the point of use.

**Space.** Seven steps, for every gap, padding and margin.

| Token | Value | For |
| --- | --- | --- |
| `--space-1` | `0.25rem` | Between a label and its value |
| `--space-2` | `0.5rem` | Within a row, between adjacent controls |
| `--space-3` | `0.75rem` | Panel padding, between rows of a list |
| `--space-4` | `1rem` | Between panels, panel padding at the wider end |
| `--space-5` | `1.5rem` | Between the bands of a surface |
| `--space-6` | `2rem` | Above a surface's first heading |
| `--space-7` | `3rem` | Between major sections of a long surface |

**Type.** Five sizes, three weights, two line heights. Every previous size maps onto one of
these: the old `0.8`, `0.85` and `0.9rem` were the same rank of text written three ways, and
become `--text-sm`.

| Token | Value | For |
| --- | --- | --- |
| `--text-xs` | `0.75rem` | Badges, column numbers, keyboard hints |
| `--text-sm` | `0.875rem` | Captions, facts, ages, secondary detail |
| `--text-base` | `1rem` | Body text, card titles, list items |
| `--text-lg` | `1.125rem` | Panel headings |
| `--text-xl` | `1.375rem` | Surface headings |

There is no sixth size for a single large number. The counts were the only thing that wanted one,
and spec 08's dashboard hierarchy condenses them into the state strip, where a number set at three
times the size of the text around it would be the weighting this milestone exists to correct.

Weights are `400`, `500` and `600`; nothing is bolder than `600` and nothing is lighter than
`400`. Line height is `--leading-tight` (`1.25`) for headings and `--leading-normal` (`1.5`) for
everything else.

**Radius.** Three values. `--radius-sm` (`0.25rem`) for controls and badges, `--radius-md`
(`0.5rem`) for panels and cards, `--radius-pill` (`999px`) for the capacity bar. The previous
`4px` and `0.25rem` were one radius written twice, and `0.35rem` and `0.75rem` were nothing at
all.

**Colour.** Two palettes, light and dark, both meeting WCAG AA against their own backgrounds,
moved here from spec 08 unchanged.

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--page` | `#ffffff` | `#16181c` | The page ground |
| `--surface` | `#f4f5f7` | `#1f2228` | A panel, sunk below the page |
| `--surface-raised` | `#ffffff` | `#262a31` | A card, raised above a panel |
| `--ink` | `#1a1a1a` | `#f2f3f5` | Body text |
| `--ink-quiet` | `#55595f` | `#b3b8c0` | Secondary text, still AA |
| `--line` | `#c8ccd2` | `#3b4048` | Borders |
| `--accent` | `#1c4f8b` | `#8fb8ea` | Links, focus, the primary action |
| `--alarm` | `#8b1c1c` | `#f4a3a3` | Something wrong or overdue |
| `--alarm-surface` | `#fdeded` | `#3a2222` | The ground behind an alarm |
| `--scrim` | `rgb(0 0 0 / 45%)` | `rgb(0 0 0 / 65%)` | Behind the quick capture dialog |

`--scrim` is the one colour the original palettes missed, because it was written into the quick
capture rule rather than named: the same veil over a light page and a dark one is not the same
veil, and a palette that stops short of the modal is a palette with a hole in it.

Colour is a second carrier, never the first. Every state that a colour marks also says what it
is in words: a stale wait says "Stale", a completed plan entry says "done" beside the
strikethrough, a calendar block that costs nothing says "declined" or "marked free", and a failed
job prints its error. This rule predates this spec and is kept.

## Primitives

Five components own the patterns that were being rewritten per surface. A surface composes
these; it does not restyle them.

**Panel.** A titled region: `--surface` ground, `--line` border, `--radius-md`, `--space-3`
padding, heading at `--text-lg`. The caller supplies the heading level, because the heading
outline belongs to the surface rather than to the component.

**Facts.** The label-and-value grid that the task card, the job panel and the settings policy
each built separately. A description list, `auto` and `1fr` columns, labels in `--ink-quiet` at
`--text-sm`. One implementation, three callers.

**Badge.** A short state, in words, in a `--radius-sm` outline of the colour its state calls
for. Badges never abbreviate to a colour alone and never carry a tooltip as their only text.

**Field.** A label above a control, both wired together, label in `--ink-quiet` at `--text-sm`.
Every form on every surface uses it, so there is one answer to where a label sits.

**ActionRow.** A row of controls with the primary action first, at `--space-2` gaps, which wraps
without changing the order. Where the row would exceed the width available, the secondary
controls move behind a disclosure rather than onto a second line: see spec 08 for the card.

## Rules

**Measure.** Running text is capped so that a line does not exceed roughly 80 characters. The
board's cards and the dashboard's panels are already narrower than that; the chat transcript, the
project list and the settings prose need the cap stated.

**Numbers that line up get `tabular-nums`.** Ages in a chase list, times in the calendar column,
counts in the history and ranks in the plan are read down the column, and proportional digits
make that harder than it needs to be.

**Time states say which they are.** A date on its own asks the reader to know today's date and do
the comparison. Anywhere a due date, a deferral or an age is shown, the state is named: overdue,
today, or the date. This is spec 08's card rule generalised, because the plan and the project
drill-in show the same dates.

**One heading outline per surface.** Each surface opens with a single `h1` naming itself, and its
panels are `h2` beneath it. The client currently has exactly one `h1`, the word "Caroline" in the
header, which leaves every surface's outline headless and every browser tab identically labelled.

**Focus is always visible**, at `3px` of `--accent` with a `2px` offset, on every interactive
element including the cards and any disclosure added to them.

**Both themes are designed, not inverted.** A colour is only ever declared as a token, so no
component rule can be correct in one theme and wrong in the other.

## Non-goals

- **User-facing theming.** Spec 08's non-goal stands. These tokens exist so that Caroline is
  internally consistent, not so that anybody can restyle it. There is no theme picker, no
  accent choice and no density setting.
- **A component library.** Five primitives that this application needs, in this application's
  own directory. No package, no documentation site, no props for cases that do not occur.
- **A third palette.** Light and dark are the two. High contrast and print are out of scope.
- **Motion.** No transitions, no animation. Nothing in Caroline changes state slowly enough to
  need one, and the surfaces are read rather than watched.
- **An icon set.** States are words. An icon that carries meaning no text carries would break the
  colour rule in a different alphabet.

## Acceptance criteria

1. Every declaration of a spacing, font size or border radius in the stylesheet resolves to a
   token from the scales above. A test parses the stylesheet and fails on a literal length in
   any of those three properties, so the scales are enforced rather than encouraged.
2. No component rule declares a colour literal. Every colour is a `var(--token)`, so no rule can
   be right in one theme and wrong in the other.
3. Both palettes define every token listed above, and the dark palette overrides exactly the
   colour tokens and nothing else.
4. Each of the five primitives has one implementation, and no surface's own rules restate that
   primitive's ground, border, radius or padding.
5. Every surface renders exactly one `h1`, and that `h1` names the surface.
6. Every surface sets `document.title` to a value naming the surface, so the six routes are
   distinguishable in browser history.
7. For each component that carries a state in colour, its rendered text differs between the
   states, asserted per component rather than as a global claim.
8. Where a date or an age is shown, an overdue value and a value due today each render text
   naming that state, and a later value renders neither.
9. Focus is visible on every interactive element, the task card and any disclosure on it
   included.
