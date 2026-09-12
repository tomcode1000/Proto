# Proto, icon brief

For a designer working in Figma. Twenty six icons, one family.

---

## The product, in one line

Proto watches whether the subcontractors on a construction site still hold valid
state licences, and tells the contractor when one stops being valid. The tone is
calm and factual, closer to an instrument than an app.

## Canvas and construction

| | |
|---|---|
| Artboard | 24 × 24 px |
| Live area | 20 × 20, so keep a 2px margin on all sides |
| Stroke | 1.6px, expanded to outline on export |
| Terminals | round cap, round join |
| Corner radius | 2px minimum on any corner, nothing sharp |
| Fill | none, strokes only, except tiny dots under 2px |
| Colour | none, they inherit from the interface |
| Alignment | snap to whole or half pixels, no 0.3px offsets |

## Two rules that decide the detail

**Nothing smaller than 2px.** These are used at 14px most of the time, in
sidebar navigation and inside buttons. Detail below 2px turns to mush.

**Nothing may depend on a fill to read.** The same icon sits on white cards, on a
saturated violet panel, and on a pale watercolour wash. If it only works as a
solid shape it will disappear on one of them.

## Optical weight

All twenty six must read as one family at 14px. A circle at 20px and a square at
20px do not look the same size, so correct optically rather than mathematically.
Check the set together at 14px, greyscale, before calling it done.

## Delivery

SVG, one file per icon, named `i-<name>.svg`, viewBox `0 0 24 24`, no `fill`,
no `stroke` colour attributes, no groups or transforms baked in. A single Figma
page with all twenty six on a 24px grid is ideal alongside them.

---

## The set

### Standing and verification, the core of the product

| Name | What it must say | Notes |
|---|---|---|
| `shield` | this has been verified | shield outline with a tick inside, the product mark |
| `licence` | a licence held by a business | a card with a seal or portrait, not a plain document |
| `register` | the state register, the source of truth | a book or ledger of record, something authoritative |
| `doc` | a document, a report, an export | page with a folded corner and a couple of text lines |

### People and places

| Name | What it must say | Notes |
|---|---|---|
| `crew` | the subcontractors on a project | two or three people, a crew not a contacts list |
| `site` | a construction project | building massing, ideally reading as under construction |
| `building` | a company or premises | plainer than `site`, a finished building |

### Time and the watch

| Name | What it must say | Notes |
|---|---|---|
| `clock` | a moment in time | plain clock face |
| `schedule` | a recurring check that has been kept | calendar with a tick in it, this is the watch |
| `history` | readings kept over time | clock with an arrow turning back |

### State

| Name | What it must say | Notes |
|---|---|---|
| `check` | in good standing | circle with a tick, must feel settled not celebratory |
| `alert` | something needs attention | triangle with a bar and dot, urgent without being alarming |
| `pause` | stop the check that is running | circle with two bars |

### Navigation

| Name | What it must say | Notes |
|---|---|---|
| `grid` | dashboard, the overview | four rounded squares |
| `list` | a list of records | three lines with leading dots or dashes |
| `mail` | notices sent to subcontractors | envelope |
| `sliders` | settings | two tracks with handles, not a gear |
| `search` | filter or look something up | magnifier |

### Actions

| Name | What it must say | Notes |
|---|---|---|
| `send` | send this message | paper plane |
| `plus` | add something new | plain cross |
| `arrow` | go, continue | arrow pointing right |
| `chev` | expand, or a dropdown | chevron pointing down |
| `x` | close, or remove a row | cross |
| `rotate` | run again, resume | circular arrow |
| `skip` | this one was already done | arrow stepping over |
| `users` | people, generic | falls back to the same shape as `crew`, may be dropped if `crew` covers it |

---

## What I would tell them to prioritise

If the budget is limited, these five carry the product and the rest are ordinary
interface furniture: **shield**, **licence**, **register**, **site**, **schedule**.

Those five are the ones a stock icon set cannot supply well, because they are
about a specific trade. Everything under Navigation and Actions is conventional
and could stay as is without anyone noticing.

## Reference

The current set lives in `public/icons.html` as one SVG sprite. It is a working
implementation, not a target: use it to see how each icon is used in context, and
replace rather than refine.
