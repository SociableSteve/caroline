# 10. Design system

Spec 08 says what appears on each surface. It does not say what any of it should look like, so
each surface chose for itself, and the result was nine values of border radius, eight font sizes
used interchangeably and ten spacing values for four ranks of gap. This spec is the missing half:
the small set of decisions every surface draws from, and the rules that keep the surfaces reading
as one system rather than five.

The scales made the surfaces consistent. They did not make them considered, and consistent about the
wrong thing is still wrong: everything was a box inside a box, `--page` and `--surface-raised` were
the same white so a card existed only because of its outline, there was one neutral where there should
have been four, the gap between a surface heading and a panel heading was 0.25rem of font size, four
rules set small text in uppercase with tracking, and `.primary` was accent-coloured text in an
outlined box rather than a filled action. The Rules section below is the appearance model that was
missing, written from driving the seeded day in a browser.

The accent hue does not move, and neither does the alarm. The palette was the one thing that was
already right; what changes is the neutrals around it.

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
| `--text-xl` | `1.75rem` | Surface headings |

`--text-xl` was `1.375rem`, one step of 0.25rem above the panel heading below it, which is a
difference rather than a hierarchy. A surface heading appears once per surface and can afford the
room.

There is no sixth size for a single large number. The counts were the only thing that wanted one,
and spec 08's dashboard hierarchy condenses them into the state strip, where a number set at three
times the size of the text around it would be the weighting this milestone exists to correct.

Weights are `400`, `500` and `600`; nothing is bolder than `600` and nothing is lighter than
`400`. Line height is `--leading-tight` (`1.25`) for headings and `--leading-normal` (`1.5`) for
everything else.

**Radius.** One scale, derived in `web/styles.css` from `--radius` (`0.625rem`), which the shadcn
migration brought with it. `--radius-sm` (`0.375rem`) is for controls: buttons, inputs, the select,
keyboard hints. `--radius-md` (`0.5rem`) is for cards, menus, dialogs, quoted blocks and the day
bar's clock track. `--radius-lg` (`0.625rem`) is for the dashboard's rail and its agenda cards, and
`--radius-xl` (`0.875rem`) for a chat turn, a Jobs panel and the Jobs and Projects tables. A pill is
Tailwind's `rounded-full` rather than a token of its own, which is what a badge and the board's
count pills use. The pre-shadcn `4px` and `0.25rem` were one radius written twice, and `0.35rem`
and `0.75rem` were nothing at all.

The day bar takes `--radius-md` like any other bounded region rather than the pill radius the
proportional capacity bar it replaced carried (spec 08, criterion 40): a rounded end on a to-scale
track shaves the first and last minutes of the window it is drawing.

**Colour.** Two palettes, light and dark, both meeting WCAG AA against their own backgrounds.

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--page` | `#f2f3f6` | `#14161a` | The page ground, tinted so a white card can be seen to be raised |
| `--surface` | `#e8eaef` | `#1d2025` | A panel, sunk into the page |
| `--surface-sunk` | `#dde1e8` | `#101215` | A well: quoted matter, a progress track |
| `--surface-raised` | `#ffffff` | `#272b32` | A card, raised out of the page |
| `--ink` | `#16181c` | `#f2f3f5` | Body text |
| `--ink-quiet` | `#4f545b` | `#b1b7bf` | Secondary text, still AA |
| `--line-faint` | `#d3d8df` | `#2e333a` | A divider between rows inside a component |
| `--line` | `#b4bbc4` | `#454b54` | A control's own edge |
| `--accent` | `#1c4f8b` | `#8fb8ea` | Links, focus, the filled primary action |
| `--accent-ink` | `#ffffff` | `#0f1216` | Text on the filled primary action |
| `--alarm` | `#8b1c1c` | `#f4a3a3` | Something wrong or overdue |
| `--alarm-surface` | `#fbe4e4` | `#3a2222` | The ground behind an alarm |
| `--scrim` | `rgb(0 0 0 / 45%)` | `rgb(0 0 0 / 65%)` | Behind the quick capture dialog |
| `--shadow-1` | soft, close | soft, close | A card, a chat turn: raised one step |
| `--shadow-2` | soft, far | soft, far | A dialog or the collapsed rail: raised above everything |

`--scrim` was the one colour the original palettes missed, because it was written into the quick
capture rule rather than named: the same veil over a light page and a dark one is not the same
veil, and a palette that stops short of the modal is a palette with a hole in it. The shadows are in
the palette for exactly that reason too, and not as a convenience: the same shadow over a light ground
and a dark one is wrong on one of them.

Colour is a second carrier, never the first. Every state that a colour marks also says what it
is in words: a stale wait says "Stale", a completed plan entry says "done" beside the
strikethrough, a calendar block that costs nothing says "declined" or "marked free", and a failed
job prints its error. This rule predates this spec and is kept.

## Primitives

Five components own the patterns that were being rewritten per surface. A surface composes
these; it does not restyle them.

**Panel.** A titled region: `--surface` ground, `--radius-md`, `--space-3` padding, heading at
`--text-lg`, and no border, because the ground is what says where it is. The caller supplies the
heading level, because the heading outline belongs to the surface rather than to the component.

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

The appearance model first, because it is what the four scales did not settle, and then the rules that
hold whatever the appearance is.

**Depth, not outlines.** A region is where it is because of its ground and its elevation, not because
a line has been drawn round it. There are four grounds and they are a ramp rather than four names for
white: the page is tinted, a panel is sunk into it, a well is sunk further, and a card is raised out of
it in `--surface-raised` with `--shadow-1`. A raised thing carries a shadow and no border; a sunk thing
carries a ground and no border. `--shadow-2` is for the one step above the page: a dialog, and the rail
when it collapses onto the surface.

The rule this replaces is the habit of giving everything a `1px solid --line` box. Six surfaces of
boxes inside boxes is what "everything is a box inside a box" meant, and it is why a card and the page
behind it were the same white with a line between them.

**A neutral ramp.** Four grounds where one colour did three of their jobs, and two lines where one
`--line` was both a component's edge and a divider inside it. `--line-faint` separates the rows of a
list, a table or a strip, and outlines a small count; `--line` is a control's own edge and a badge's
outline, where the line is the shape of the thing rather than a box drawn round it. No region draws a
neutral line round itself: that is what the four grounds are for.

**Weight is scarce.** `600` belongs to the one surface heading and to nothing else. `500` marks a
panel heading, a card title, the current item in the navigation, and the one value in a row that is the
point of the row. Everything else is `400`. Nothing is bolder than `600` or lighter than `400`. The
previous sheet reached for `600` seven times, which is the same as reaching for it none.

**Nothing is uppercased, and nothing is tracked.** Four rules set small text in uppercase with
letter-spacing as a way of saying "this is a label". Size, colour and position already say that, and
uppercasing costs the word its shape and a screen reader its pronunciation. A column heading, a strip
heading and a transcript's role are small and quiet, and that is the whole of it.

**One filled primary per context.** `.primary` is filled in `--accent` with `--accent-ink` on it, so
there is one obvious thing to press. The context is a row of controls or a box that demands a decision,
not the surface: a board of review cards has a primary on each card, because a card is what is being
acted on. Two filled primaries in one row is two obvious things to press, which is none.

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
6. Every surface sets `document.title` to a value naming the surface, so the five routes are
   distinguishable in browser history.
7. For each component that carries a state in colour, its rendered text differs between the
   states, asserted per component rather than as a global claim.
8. Where a date or an age is shown, an overdue value and a value due today each render text
   naming that state, and a later value renders neither.
9. Focus is visible on every interactive element, the task card and any disclosure on it
   included.

The appearance model adds the following, appended rather than renumbered because the code and the
suite cite the numbers above.

10. The four grounds are four distinct values in both palettes, so a card is never the same colour as
    the page it sits on, and both lines are defined and differ from each other.
11. `--text-xl` is at least `0.5rem` above `--text-lg`, so a surface heading and a panel heading are a
    rank apart rather than a rounding error apart.
12. `font-weight: 600` is declared for the surface heading and for nothing else, and no rule declares
    a weight above `600` or below `400`. A test parses the stylesheet and lists the offenders.
13. The stylesheet declares no `text-transform: uppercase` and no `letter-spacing` at all.
14. `.primary` declares a `--accent` background and `--accent-ink` text, and no row of controls on any
    surface renders more than one `.primary`.
15. A card is raised by `--shadow-1` and declares no border, and every shadow in the sheet is a token,
    so no shadow can be right in one theme and wrong in the other.
