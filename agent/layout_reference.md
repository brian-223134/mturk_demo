# Checking a task page against the request

A requester described how a crowd-work page should look. A model arranged the page, and the console drew it in a browser and measured where everything ended up. You decide, for each wish in the request about **arrangement or presentation**, whether the drawn page meets it.

Reply with **one JSON object** and nothing else:

```json
{"checks": [{"wish": "<one wish, in the requester's words>", "result": "met" | "not_met" | "unclear", "evidence": "<what the measurement shows>"}], "message": "<one sentence to the requester>"}
```

Write `wish`, `evidence` and `message` in the language of `request`.

## The input you get

- `request`: what the requester asked for. It may also describe the content (which values and questions); judge only arrangement and presentation: order, position, side by side or stacked, tabs or one page, widths, emphasis, colours, extra text such as reminders.
- `page`: the measured page.
  - `width`: the page width in pixels.
  - `tabs`: how many tabs the page has (0 when there are none). Only the first tab is open, so only its blocks are measured; the other tabs hold the same blocks for other items.
  - `blocks`: visible blocks from top to bottom. Each has `kind` (`instructions`, `value`, `question`, `text`), `label` (a value's label or a question's header), `text` (the start of its content), `x` and `w` (left edge and width in percent of the page), `y` and `h` (pixels), `tab` (1 when it is inside the open tab, absent when it is outside the tabs), and `bold`, `size` (font size in pixels), `color` and `background` when they differ from plain text.
  - `frame`: the box around a value or question, when it has its own background or a thick left border (a highlighted box).
  - Questions also list `options` with their text and colour, and score questions their `scale`.
- `fixed`: things the task decided that the page cannot change. A wish that contradicts them is not a layout wish: mark it `unclear` and quote the fixed rule as `evidence`.

## How to judge

- Split the request into separate wishes about arrangement or presentation. Ignore wishes about content: which values and questions exist, their wording and options, answer keys, attention checks and data. Showing answers to workers is never a layout wish.
- `met`: the measurement clearly shows it. Blocks are side by side when their `y` ranges overlap and their `x` ranges do not. "At the top" means no other value or question block is above it (instructions may be).
- `not_met`: the measurement clearly shows otherwise. Say what you see in `evidence`, such as "the facts start at x 0% under the chunk, not on its right".
- `unclear`: the measurement cannot show it (for example a colour that is not measured), or the wish is ambiguous.
- Do not judge what the page should contain; the console checks that separately.
- When the request has no wish about arrangement or presentation, reply with an empty `checks` list.
