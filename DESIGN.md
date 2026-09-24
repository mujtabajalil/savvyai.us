# DESIGN.md

Design system on the Savvital palette: deep teal ink, one lime highlighter, real work shown and marked up.

Coding agents: read this before writing any UI. The tokens in section 10 are the source of truth. Never hardcode a hex value in a component. Point your agent here with one line in CLAUDE.md or AGENTS.md: `Read DESIGN.md before any UI work.`

Colors come from savvital.us, read from the live site's computed styles in September 2026. Two things are additions: red for errors, and the dark theme, which is derived from the site colors. Type, layout and components belong to this system.

## 1. Principles

1. **Teal is the ink.** Text, rules and controls are deep teal or a tint of it. Anything else with color is a real artifact, a status, or the rare violet accent.
2. **Show the real thing.** Lead with a real artifact (a product screen, a report, a dashboard) at readable size, marked up with lime pins. No stock photos, device mockups or illustrations standing in for the work.
3. **Lime is the highlighter.** It marks what to look at: pins, text selection, the call to action on dark bands. Three lime things per viewport at most, or nothing stands out.
4. **Plain words.** Claims a reader can check. Numbers over adjectives. The price or the catch within one line of the claim.
5. **Quiet by default.** Space instead of boxes, tone instead of lines. Cut anything that doesn't carry information.

## 2. Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#FFFFFF` | `#033233` | Page background |
| `--sheet` | `#FFFFFF` | `#123E3F` | Raised: cards, menus, inputs |
| `--mat` | `#E6F0F0` | `#022425` | Sunken: exhibit mats, table headers |
| `--wash` | `#F8FEE9` | `#15423B` | Featured section, callout |
| `--mist` | `#F2F8F7` | `#0D3A3B` | Hover on rows and secondary buttons |
| `--rule` | `#E5E7EB` | `#295152` | Dividers, card and table borders |
| `--rule-strong` | `#748E8F` | `#748E8F` | Input and checkbox borders |
| `--ink` | `#033233` | `#FFFFFF` | Headings, strong text |
| `--ink-2` | `#355B5C` | `#B3C2C2` | Body text |
| `--ink-3` | `#4F7070` | `#9AADAD` | Captions, help text, placeholders |
| `--action` | `#006965` | `#E3FF91` | Primary buttons, links, focus ring, selected state |
| `--action-hover` | `#033233` | `#F8FEE9` | Primary button hover |
| `--on-action` | `#FFFFFF` | `#033233` | Text on `--action` |
| `--mark` | `#E3FF91` | `#E3FF91` | Highlighter: pins, selection, link focus |
| `--on-mark` | `#033233` | `#033233` | Text on `--mark` |
| `--violet` | `#7E5AFF` | `#7E5AFF` | Second accent: fills, chart series 2 |
| `--violet-text` | `#6B4CD9` | `#B29CFF` | Violet as text ("New" tags) |
| `--ok` | `#006965` | `#8CBCBA` | Success text |
| `--warn` | `#92400E` | `#F59E0B` | Warning text |
| `--warn-fill` | `#F59E0B` | `#F59E0B` | Warning dots and icons, star ratings |
| `--bad` | `#B91C1C` | `#FCA5A5` | Error text |

Tints for tag and notice backgrounds, light / dark: `--ok-tint` `#E0EDED` / `#1C4B4B`, `--warn-tint` `#FEF3E2` / `#2F452C`, `--bad-tint` `#F7E4E4` / `#304748`, `--violet-tint` `#F0EBFF` / `#193958`.

Where the site's values went: `#033233` is the ink and the dark page, `#006965` the action, `#E3FF91` the mark, `#7E5AFF` violet, `#F8FEE9` the wash, `#F59E0B` the warning fill, `#E5E7EB` the rule. The site sets secondary text as deep teal at 80% and 70% opacity; here those are flattened to solid `--ink-2` and `--ink-3`, and its 5% and 10% teal tints became `--mist` and `--mat`, so contrast holds on every surface.

**Contrast, verified.** Minimum across paper, sheet, mat and wash. AA needs 4.5 for text and 3 for control borders.

| Pair | Light | Dark |
|---|---|---|
| `--ink` | 12.0 | 11.2 |
| `--ink-2` | 6.5 | 6.1 |
| `--ink-3` | 4.7 | 4.8 |
| `--action` as text | 5.6 | 10.1 |
| `--on-action` on `--action` | 6.6 | 12.6 |
| `--on-mark` on `--mark` | 12.6 | 12.6 |
| `--violet-text` | 4.9 | 4.9 |
| `--ok`, `--warn`, `--bad` | 5.6, 6.1, 5.6 | 5.3, 5.2, 5.9 |
| Status text on its own tint | 4.9 or more | 4.6 or more |
| `--rule-strong` against paper and sheet | 3.5 | 3.4 |

**Never:**
- Lime as text on a light surface (1.1:1).
- White text on violet, or `#7E5AFF` as small text on white (4.4:1). Use `--violet-text`.
- Teal buttons on a dark band (2.1:1 against the page). On dark, the action is lime.
- Violet and lime in the same component.
- `#006965` as a large background. Dark bands use `--paper` under `data-theme="dark"`.

## 3. Type

Two families with clearly different jobs:

- **Literata** for headlines, lead paragraphs and prices. Optical size is fixed at 36 for display, h1 and h2, so big headlines keep sturdy text-cut serifs instead of thin display contrast.
- **Atkinson Hyperlegible Next** for everything else: body, UI, tables, captions. It comes from the Braille Institute and is built for legibility; distinct I/l/1 and O/0 matter in forms and figures.
- No third family. Monospace only for literal code.

```bash
npm i @fontsource-variable/literata @fontsource-variable/atkinson-hyperlegible-next
```

```js
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css";
```

Without a bundler: `https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,200..800;1,200..800&family=Literata:ital,opsz,wght@0,7..72,200..900;1,7..72,200..900&display=swap`

Scale, from the classic typographic series 12, 14, 16, 18, 21, 24, 36, 48, 72:

| Role | Family | Size, mobile to desktop | Line height | Weight | Tracking |
|---|---|---|---|---|---|
| display | Literata, opsz 36 | 44 to 72px `clamp(2.75rem, 1.9rem + 3.6vw, 4.5rem)` | 1.04 | 480 | -0.015em |
| h1 | Literata, opsz 36 | 36 to 48px `clamp(2.25rem, 1.9rem + 1.5vw, 3rem)` | 1.08 | 500 | -0.01em |
| h2 | Literata, opsz 36 | 28 to 36px `clamp(1.75rem, 1.5rem + 1vw, 2.25rem)` | 1.15 | 540 | -0.005em |
| h3 | Literata | 21 to 24px `clamp(1.3125rem, 1.2rem + 0.5vw, 1.5rem)` | 1.25 | 600 | 0 |
| lead | Literata | 21px | 1.45 | 400 | 0 |
| body | Atkinson | 18px | 1.6 | 400 | 0 |
| ui | Atkinson | 16px | 1.35 | 600 | 0 |
| small | Atkinson | 14px | 1.45 | 400 | 0 |
| tag | Atkinson | 12px | 1 | 700 | 0.02em |

Rules:
- Sentence case everywhere. Headlines end without a period; question marks are fine. `text-wrap: balance` on headings, `pretty` on paragraphs.
- Never color, italicize or bold one word of a headline for emphasis.
- No all caps, no letterspaced labels, no eyebrow label over a heading unless it carries information (a date, a step in a real sequence).
- Body measure 36rem at most, about 65 characters.
- Emphasis in body copy: weight 700, rarely. Italic for titles and defined terms.
- `font-variant-numeric: tabular-nums` in tables and prices. Both families support it.

## 4. Space, grid, shape

- **Spacing:** 4px base, which matches Tailwind's default unit: 4, 8, 12, 16, 24, 32, 48, 64, 96, 144 (`--s-1` to `--s-10`).
- **Section padding:** `clamp(4rem, 2rem + 6vw, 9rem)` top and bottom.
- **Rhythm inside a section:** headline, 16px, body, 32px, actions, 48 to 64px, exhibit.
- **Grid:** 12 columns, 72rem max content width, 24px gutters (16px under 640px), page padding `clamp(1.25rem, 4vw, 3rem)`.
- **Radius grows with the container:** tags 4px; buttons and inputs 6px; cards, menus and dialogs 10px; exhibit mats 16px; pins fully round.
- **Elevation:** flat. Surfaces separate by tone: paper, sheet, mat. A 1px `--rule` border only where tone can't do the job: tables, inputs, cards sitting on paper. Shadow (`--float`) only on things that float: menus, dialogs, toasts.

## 5. Layout

**The spine.** One left text edge runs the length of the page. Text never centers and never zig-zags from side to side; exhibits hang off the spine toward the right edge. Flush left, ragged right. Numbers right-aligned in tables.

Hero, 1024px and up:

```
┌──────────────────────────────────────────────────────────────────┐
│ Logo                  Services   Pricing   About   [Book a call] │
│                                                                  │
│ Display headline: a claim a reader can check         cols 1-8    │
│ Lead: what it is, who it's for, the price or catch   cols 1-6    │
│ [Primary action]   Secondary link                                │
│                                                                  │
│ ┌ mat ─────────────────────────────────────────────────────────┐ │
│ │ ┌ real artifact ───────────────────────────────────────────┐ │ │
│ │ │          (A)                               (B)           │ │ │
│ │ └──────────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ (A) One sentence.           (B) One sentence.                    │
└──────────────────────────────────────────────────────────────────┘
```

Feature section, 1024px and up:

```
│ h2: one claim         cols 1-4   ┌ mat ────────────── cols 6-12 ┐ │
│ Body, 60 words max               │ ┌ artifact, cropped ───────┐ │ │
│                                  │ │  (A)               (B)   │ │ │
│ (A) One sentence.                │ └──────────────────────────┘ │ │
│ (B) One sentence.                └──────────────────────────────┘ │
```

Under 1024px: one column, in this order: headline, body, actions, exhibit (full width inside the page padding), key.

**Dark band:** one full-bleed section per page with `data-theme="dark"`, for the closing call to action or a proof block. White headline, lime button.

**Marketing page order:** hero with exhibit; 2 to 4 feature sections, one claim and one exhibit each; proof with real numbers and named clients; pricing; FAQ with every answer visible, no accordion; dark closing band; footer.

## 6. Components

**Buttons.** 44px tall, `0 20px` padding, `ui` type. Nav size: 36px, `0 14px`.

| Variant | Fill | Text | Border | Hover |
|---|---|---|---|---|
| primary | `--action` | `--on-action` | none | `--action-hover` fill |
| secondary | none | `--ink` | 1px `--rule-strong` | `--mist` fill |
| text | none | `--action` | 1px underline, 0.2em offset | 2px underline |

One primary per view. Labels are a verb and an object: "Book a strategy call", never "Submit" or "Get started". No arrows. An icon only for download or external links, leading, 18px. Disabled: `--mat` fill, `--ink-3` text, and a line nearby that says why.

**Links.** `--action` color, 1px underline in `--rule-strong` at 0.2em offset. Hover turns the underline to `currentColor` at 2px. Keyboard focus adds a `--mark` background.

**Focus.** Everything interactive: `outline: 2px solid var(--action); outline-offset: 2px`. Never removed.

**Exhibit.** The signature component.
- `<figure>` on `--mat`, 16px radius, padding `clamp(12px, 2vw, 24px)`.
- Inside it, the real artifact: 6px radius, 1px `--rule` border, no shadow, shown at 70% of true size or more. If it's unreadable, crop tighter instead of shrinking.
- Pins: 28px circles, `--mark` fill, 2px `--on-mark` ring, a letter in 13px/700 `--on-mark`. Positioned in percentages so they track the image. Three per exhibit at most. Letters, not numbers, because the marks aren't a sequence.
- Key (`<figcaption>`): a 20px pin and one sentence per item, in `small` type, `--ink-2`. Hovering or focusing a key item gives its pin a 4px `--mark` halo, and the reverse.
- Dark theme: serve dark screenshots with `<picture><source media="(prefers-color-scheme: dark)">`.
- Alt text says what the artifact shows. Pins are `aria-hidden`; the key carries the meaning.
- Swap client names and data for realistic samples. No device frames, no browser chrome.

**Tags.** `tag` type, `4px 8px` padding, 4px radius, the status tint as background, the status color as text, a 6px leading dot in `currentColor`. Always a word, never color alone. "New" uses `--violet-tint` and `--violet-text`.

**Cards.** Only for things you choose between or act on: plans, options, records. `--sheet` fill, 1px `--rule`, 10px radius, 24 to 32px padding. No shadow, no hover lift. A clickable card is one link; on hover its border darkens to `--rule-strong`. Plan cards set the price in Literata at h1 size, with the catch on the next line in `small` `--ink-3`.

**Logo row.** Client logos converted to one color (`--ink-3` on light, `--ink-2` on dark), equal optical size, left-aligned, no carousel.

**Forms.** Label above in `ui` type, `--ink`. Input 44px, `--sheet` fill, 1px `--rule-strong`, 6px radius, 16px text so iOS doesn't zoom. The placeholder in `--ink-3` shows an example and never replaces the label. Help text below in `small` `--ink-3`. Error: `--bad` border and a `small` `--bad` message that says what's wrong and how to fix it, wired with `aria-describedby`. Checkboxes and radios: `accent-color: var(--action)`.

**Tables.** Header row in `small` 700 `--ink-2` on `--mat`. Rows 48px with a 1px `--rule` between. Numbers right-aligned and tabular. No zebra stripes. Clickable rows hover to `--mist`.

**Nav.** 64px, solid `--paper` with no blur, a 1px `--rule` bottom edge once the page scrolls. Logo left in one color: `--ink` on light, `--mark` on dark. Three to five links in 16px/500 `--ink-2`; the current page in `--ink` with a 2px underline. Small primary button on the right. Under 1024px, a "Menu" text button opens a full-height sheet with links at `h3` size.

**Notices.** Status tint background, 20px icon in the status color, `--ink` text. No colored left stripe.

**Toasts.** Bottom left, `--ink` background, `--paper` text, 6px radius, one line, 5 seconds, optional action. The message reuses the action's verb: "Report sent".

**Empty states.** One sentence on what's missing and one primary action. No illustration.

**Errors.** What happened and how to fix it. No apology, no "Oops": "Card declined by your bank. Try another card or call the number on its back."

## 7. Motion

- 120ms for press, 180ms for hover and state changes, 320ms for open and close. Easing `cubic-bezier(0.2, 0, 0, 1)`.
- One orchestrated moment: on load, the hero exhibit's pins stamp on in order (scale 0.6 to 1, opacity 0 to 1, 180ms each, 90ms apart). Nothing else moves on its own.
- No fade-up sections, parallax, hover lifts, animated gradients or counting-up numbers.
- `prefers-reduced-motion`: pins appear at once and transitions drop to 0.01ms.

## 8. Words

- Headlines are claims a reader can check: "Reports land at 6 pm your time", not "Timely reporting".
- Numbers beat adjectives: "Onboarding takes 7 days", not "Fast onboarding".
- Put the price, the limit or the catch within one line of the claim.
- Buttons name the action, and the confirmation reuses the verb: "Send report" leads to "Report sent".
- Sentence case. Numerals for all numbers. No exclamation marks.
- Cut on sight: seamless, unlock, supercharge, effortless, cutting-edge, game-changing, leverage, empower, robust, world-class. Don't lead with "AI-powered"; say what the AI does and where it stops.

| Instead of | Write |
|---|---|
| Seamless onboarding | Onboarding takes 7 days |
| Learn more → | See pricing |
| Oops! Something went wrong. | Upload failed: the file is over 25 MB. Compress it or split it. |

## 9. Tells to avoid

These make a page read as templated or machine-made:
- A centered hero on a gradient wash with two centered buttons.
- All-caps or letterspaced eyebrow labels over every heading.
- Meta strings joined by middle dots, "WORD, fragment" labels built with spaced dashes, arrows tacked onto links and buttons.
- One word of a headline in a different color, style or weight.
- 01 / 02 / 03 markers on content that isn't a sequence.
- Rows of identical rounded cards with the same soft grey shadow; icon grids of generic features.
- Monospace for small labels, stock photos, device mockups, glass blur, blobs.
- Every section fading up on scroll, every card lifting on hover.

## 10. Tokens

```css
/* tokens.css: the source of truth */
:root,
[data-theme="light"] {
  color-scheme: light;
  /* surfaces */
  --paper: #FFFFFF; --sheet: #FFFFFF; --mat: #E6F0F0; --wash: #F8FEE9; --mist: #F2F8F7;
  /* lines */
  --rule: #E5E7EB; --rule-strong: #748E8F;
  /* text */
  --ink: #033233; --ink-2: #355B5C; --ink-3: #4F7070;
  /* action and highlighter */
  --action: #006965; --action-hover: #033233; --on-action: #FFFFFF;
  --mark: #E3FF91; --on-mark: #033233;
  /* accent and status */
  --violet: #7E5AFF; --violet-text: #6B4CD9; --violet-tint: #F0EBFF;
  --ok: #006965; --ok-tint: #E0EDED;
  --warn: #92400E; --warn-fill: #F59E0B; --warn-tint: #FEF3E2;
  --bad: #B91C1C; --bad-tint: #F7E4E4;
  --float: 0 1px 2px rgb(3 50 51 / 0.08), 0 12px 32px -8px rgb(3 50 51 / 0.24);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #033233; --sheet: #123E3F; --mat: #022425; --wash: #15423B; --mist: #0D3A3B;
    --rule: #295152; --rule-strong: #748E8F;
    --ink: #FFFFFF; --ink-2: #B3C2C2; --ink-3: #9AADAD;
    --action: #E3FF91; --action-hover: #F8FEE9; --on-action: #033233;
    --mark: #E3FF91; --on-mark: #033233;
    --violet: #7E5AFF; --violet-text: #B29CFF; --violet-tint: #193958;
    --ok: #8CBCBA; --ok-tint: #1C4B4B;
    --warn: #F59E0B; --warn-fill: #F59E0B; --warn-tint: #2F452C;
    --bad: #FCA5A5; --bad-tint: #304748;
    --float: 0 12px 32px -8px rgb(0 0 0 / 0.5);
  }
}

/* Forced dark: the whole page (<html data-theme="dark">) or one band (<section data-theme="dark">) */
[data-theme="dark"] {
  color-scheme: dark;
  --paper: #033233; --sheet: #123E3F; --mat: #022425; --wash: #15423B; --mist: #0D3A3B;
  --rule: #295152; --rule-strong: #748E8F;
  --ink: #FFFFFF; --ink-2: #B3C2C2; --ink-3: #9AADAD;
  --action: #E3FF91; --action-hover: #F8FEE9; --on-action: #033233;
  --mark: #E3FF91; --on-mark: #033233;
  --violet: #7E5AFF; --violet-text: #B29CFF; --violet-tint: #193958;
  --ok: #8CBCBA; --ok-tint: #1C4B4B;
  --warn: #F59E0B; --warn-fill: #F59E0B; --warn-tint: #2F452C;
  --bad: #FCA5A5; --bad-tint: #304748;
  --float: 0 12px 32px -8px rgb(0 0 0 / 0.5);
}

:root {
  --ff-head: "Literata Variable", "Literata", Georgia, serif;
  --ff-text: "Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif;
  --s-1: 0.25rem; --s-2: 0.5rem; --s-3: 0.75rem; --s-4: 1rem; --s-5: 1.5rem;
  --s-6: 2rem; --s-7: 3rem; --s-8: 4rem; --s-9: 6rem; --s-10: 9rem;
  --section: clamp(4rem, 2rem + 6vw, 9rem);
  --measure: 36rem;
  --r-tag: 4px; --r-control: 6px; --r-card: 10px; --r-mat: 16px;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --t-press: 120ms; --t-state: 180ms; --t-open: 320ms;
}
```

```css
/* base.css */
body, [data-theme] { background: var(--paper); color: var(--ink-2); font: 400 1.125rem/1.6 var(--ff-text); }
h1, h2, h3, .display { color: var(--ink); font-family: var(--ff-head); text-wrap: balance; }
h1, h2, .display { font-variation-settings: "opsz" 36; }
p { max-inline-size: var(--measure); text-wrap: pretty; }
a {
  color: var(--action);
  text-decoration-line: underline; text-decoration-thickness: 1px;
  text-decoration-color: var(--rule-strong); text-underline-offset: 0.2em;
}
a:hover { text-decoration-color: currentColor; text-decoration-thickness: 2px; }
a:focus-visible { background: var(--mark); color: var(--on-mark); }
:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
::selection { background: var(--mark); color: var(--on-mark); }
table, .price { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Tailwind v4. The reset removes the default palette, so `text-gray-500` and friends stop existing and only tokens work:

```css
/* app.css */
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-*: initial;
}

@theme inline {
  --color-paper: var(--paper); --color-sheet: var(--sheet); --color-mat: var(--mat);
  --color-wash: var(--wash); --color-mist: var(--mist);
  --color-rule: var(--rule); --color-rule-strong: var(--rule-strong);
  --color-ink: var(--ink); --color-ink-2: var(--ink-2); --color-ink-3: var(--ink-3);
  --color-action: var(--action); --color-action-hover: var(--action-hover); --color-on-action: var(--on-action);
  --color-mark: var(--mark); --color-on-mark: var(--on-mark);
  --color-violet: var(--violet); --color-violet-text: var(--violet-text); --color-violet-tint: var(--violet-tint);
  --color-ok: var(--ok); --color-ok-tint: var(--ok-tint);
  --color-warn: var(--warn); --color-warn-fill: var(--warn-fill); --color-warn-tint: var(--warn-tint);
  --color-bad: var(--bad); --color-bad-tint: var(--bad-tint);
  --font-head: var(--ff-head); --font-text: var(--ff-text);
  --radius-tag: var(--r-tag); --radius-control: var(--r-control);
  --radius-card: var(--r-card); --radius-mat: var(--r-mat);
  --shadow-float: var(--float);
}

@layer base {
  *, ::before, ::after { border-color: var(--rule); }
}
```

Tailwind v3: put the same `var(--…)` references under `theme.extend` (`colors`, `fontFamily`, `borderRadius`, `boxShadow`) in `tailwind.config.js`.

## Before shipping a screen

- [ ] Only tokens. No raw hex outside this file.
- [ ] One primary action per view, labeled with a verb and an object.
- [ ] Three lime things per viewport at most.
- [ ] Every headline is a claim a reader could check, with no period at the end.
- [ ] A real artifact appears before the first scroll on marketing pages.
- [ ] Text is left-aligned; paragraphs stay within 36rem.
- [ ] Keyboard focus is visible on every interactive element.
- [ ] Checked in light, in dark, and inside a `data-theme="dark"` band.
- [ ] Reduced motion respected.
- [ ] Nothing from section 9.
