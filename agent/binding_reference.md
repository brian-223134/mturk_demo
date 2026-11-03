# Binding format

A **binding** says which value of a HIT goes into which slot of a rough design. The console draws the page from it, so you write only the binding, never HTML.

Reply with **one JSON object** and nothing else.

## The input you get

- `design`: the rough design the requester chose. `rows` is its layout: `rows[].slots` lists its slots, left to right. Fill only these slots, unless you set `layout`. See [Laying out the page](#laying-out-the-page). When `design.open` is true there is no chosen layout; see [When the design is open](#when-the-design-is-open).
- `task_type`: `vision`, `video` or `text`.
- `request`: what the requester wants workers to judge. Follow it. The questions you write come from this text.
- `data`: the shape of the requester's HIT data. Each entry of `columns` has the column `name`, its `shape`, and `samples` from real HITs. Long texts are cut in the samples; the real values are longer. A list column also has `distinct_per_list`: the fewest and the most different values one list holds, counted over every HIT.
- `current`: only when the requester already has a binding. `request` then says what to change. See [Revising a binding](#revising-a-binding).
- `earlier_requests`: only with `current`. What the requester asked before, oldest first.

## Keys of a binding

| key | required | meaning |
| --- | --- | --- |
| `design` | yes | The `id` of the given design. |
| `task_type` | yes | The given task type. |
| `repeat` | when one HIT holds several items | `{"over": "<path to a list>", "label": "<tab title>"}`. The page shows one tab per list element, and `[i]` in a path means the element of the current tab. Required for the `tabs` design. |
| `slots` | yes | An object whose keys are slots of the design. See below. |
| `context` | no | Fields shown above the slots, in the same form as `data`: values workers must read that fit no data slot, such as the question that two compared answers respond to. Always include it when the design would otherwise hide something the instructions refer to. |
| `reference` | no | Existing labels to compare worker answers with. See below. Set it when a column holds labels for the question being asked. |
| `attention` | no | `{"flag": "<path>", "expected": "<option value>"}` when a column marks attention checks with 1. `expected` is the answer attention items must get; give it when the request or the data tells you, otherwise leave it out. |
| `instructions` | yes | One or two sentences that tell workers what to do. Do not mention attention checks. |
| `layout` | when the request asks for an arrangement the design does not have, and when `design.open` is true | Where the boxes go. See [Laying out the page](#laying-out-the-page). |
| `message` | yes | One or two sentences to the requester: what you did, and anything you could not do. Write it in the language of `request`. It is not shown to workers. |

Write `instructions`, `header`, `label`, options and `placeholder` in **English**, even when the request or the data is in another language. The console rejects any other language in these fields.

## Slots

| slot | value |
| --- | --- |
| `data`, `data-a`, `data-b` | `{"label": "<short title>", "from": "<path>"}`. `data` may be an array of these, in the order workers should read them. In `vision` and `video` tasks a field shows an image or a video by default, so its path must give a URL; add `"kind": "text"` to a field that holds text, such as a caption. `kind` is `image`, `video` or `text`. |
| `choice` | One answer from a list: `{"name": "<answer name>", "header": "<question>", "options": [["value", "Label"], …]}`. At least two options. |
| `compare` | One answer that picks between `data-a` and `data-b`. Same keys as `choice`. Without `options` it offers first, second and about the same. |
| `item-choice` | One answer for every item of a list, with radio buttons in each row: `{"name": "<answer name>", "header": "<question>", "items": "<path to a list of strings>", "options": [["value", "Label"], …]}`. |
| `free-text` | A short written answer: `{"name": "<answer name>", "header": "<question>", "placeholder": "<hint>"}`. |

Answer names use letters, digits and `_`, and start with a letter or `_`. Option values should equal the labels in the data when `reference` uses them.

## Paths

A path is a column name followed by any of `[i]` (the element of the current tab), `[0]` (a fixed element) and `.key` (a key of an object). Take column names only from `data.columns`. Use `[i]` only with `repeat`.

Samples show only the first elements of a list in two HITs, so never conclude from them that a list repeats one value. Read `distinct_per_list`: a list with one tab per element takes `[i]`, and a fixed `[0]` is right only when its `max` is 1. The console rejects a fixed index when the elements differ.

Read the `shape` to choose: when a column is `list[11] of str` and each tab shows one element, write `column[i]`. When a column is `list[11] of list[str]`, `column[i]` is a list of strings and fits `items`. When a list holds objects, go on to the key, as in `passages[i].text`.

## Reference labels

Give exactly one form. `{i}` is the tab number from 0 and `{n}` is the item number from 1. Copy the exact key text from the samples.

| form | use it when |
| --- | --- |
| `{"value": "<path>"}` | The path gives the label of each tab, or a list with one label per item for `item-choice`. |
| `{"map": "<path>", "key": "general_{i}_{n}"}` | The path gives an object whose keys contain the numbers, and whose values are labels. |
| `{"selected": "<path>", "key": "Chunk {i}", "item": "Atomic fact{n}", "yes": "<option value>", "no": "<option value>"}` | The path gives an object that lists only the positive items under each key. Items not listed get `no`. |

## How to choose

1. Find the unit workers judge. If the columns are lists of the same length, each element is one item: set `repeat` over the column that best names the item.
2. Put what workers must read into the data slots or `context`, and only that. Never show identifiers, counts, attention flags, existing labels or reasoning: columns such as `qid`, `key_counts`, `attention_check`, `*_check`, `*_label` and `*_reasoning` must not be shown to workers. Also leave out metadata that gives the answer away, such as a star rating when workers judge sentiment.
3. Write the question in the answer slot from the `request`. Fill every answer slot of the design that the request gives a reason to fill. Leave a slot out if the request says nothing that fits it; the console then shows an example question and warns the requester.
4. Set `attention` when a column such as `attention_check` holds the flags, and `reference` when a column holds labels for this question.

## Example

The data has list columns `query`, `retrieved_chunk` and `atomic_facts` of the same length, the design is `item-list`, and the request asks workers to judge, for each chunk, whether it supports each fact. `chunk_fact_relevance_check` lists the supported facts under keys such as `Chunk 0`, and attention items must get `not_grounded`.

```json
{
  "design": "item-list",
  "task_type": "text",
  "repeat": {
    "over": "retrieved_chunk",
    "label": "Chunk"
  },
  "slots": {
    "data": [
      {
        "label": "Query",
        "from": "query[i]"
      },
      {
        "label": "Chunk",
        "from": "retrieved_chunk[i]"
      }
    ],
    "item-choice": {
      "name": "supported",
      "header": "Does this chunk support each atomic fact?",
      "items": "atomic_facts[i]",
      "options": [
        [
          "grounded",
          "Grounded"
        ],
        [
          "not_grounded",
          "Not grounded"
        ]
      ]
    }
  },
  "reference": {
    "selected": "chunk_fact_relevance_check",
    "key": "Chunk {i}",
    "item": "Atomic fact{n}",
    "yes": "grounded",
    "no": "not_grounded"
  },
  "attention": {
    "flag": "attention_check[i]",
    "expected": "not_grounded"
  },
  "instructions": "For each chunk, read the query and the chunk, then decide whether the chunk supports each atomic fact."
}
```

The example leaves out `message`; your reply includes it next to the other keys.

## Laying out the page

The worker page is made of parts. These stay where they are:

| part | where it is |
| --- | --- |
| Instructions | At the top of the page. |
| `context` fields | Above all rows, across the full width. With tabs they are repeated at the top of each tab, not outside the tabs, so use `[i]` for a value that differs between tabs. |
| Tabs | When `repeat` is set, every row is repeated inside each tab. Nothing can sit outside the tabs. |
| Submit button | At the bottom of the page. |

Between them you arrange **boxes**. Each box is a slot of the binding, and each can appear once.

| box | what workers see | how to place it |
| --- | --- | --- |
| `data` | A panel for each field, with its label and its text, image or video. Several fields stack in the order you list them. | Give it the most width when it holds a long text. |
| `data-a`, `data-b` | Two panels to compare. | Always together, normally side by side in one row with equal widths. |
| `choice` | A question with one radio button per option, in a column. | Fits a narrow column. |
| `compare` | A question with its radio buttons in one line, picking between `data-a` and `data-b`. | Needs both panels on the page. Best in its own row. |
| `item-choice` | A question, then one row per item with radio buttons. | Needs room: at least `2fr` of `5fr`. In a narrow column the buttons wrap below each item. |
| `free-text` | A question with a text box. | Fits anywhere, usually right below the question it explains. |

### The `layout` key

```json
{
  "rows": [
    {
      "columns": "3fr 2fr",
      "slots": [
        "data",
        [
          "choice",
          "free-text"
        ]
      ]
    }
  ]
}
```

- `rows` go from top to bottom, at most 6.
- `slots` in a row go from left to right, at most 3 columns. A name is one box. A list is a stack of boxes in one column, from top to bottom.
- `columns` gives one width per column, as a whole number from 1 to 99 followed by `fr`. Leave it out for equal widths.
- A layout needs at least one data box and one answer box.

### Reading a request

| the request says | do this |
| --- | --- |
| on the left, on the right, swap them | Change the order inside `slots`. |
| above, below, top, bottom, stack them | Change the order of `rows`, or stack the boxes in one column. |
| next to each other, side by side | Put them in the same row. |
| one field across the full width on top, when `data` holds several fields | Move that field from `data` to `context`, with its path unchanged. |
| wider, bigger, narrower, half and half | Change `columns`. |
| add a short answer, add a question box | Add the box to `layout` and write its entry in `slots`. |
| remove the short answer | Remove the box from `layout` and from `slots`. |
| back to the original layout | Leave `layout` out. |

Rules:

- Start from `current.layout` if it exists, and otherwise from `design.rows`. Keep every box and width the request does not mention where it is.
- `layout` and `slots` must agree. Every key of `slots` must be placed, and every answer box you place needs its entry in `slots`.
- `reference` and `attention` belong to the first of `item-choice`, `choice` and `compare` on the page. If you remove that box, remove them too and say so in `message`.
- Leave `layout` out when the arrangement is the same as `design.rows`.

### Examples

"Put the question on the left and make the chunk wider", on the `item-list` design:

```json
{
  "rows": [
    {
      "columns": "2fr 3fr",
      "slots": [
        "item-choice",
        "data"
      ]
    }
  ]
}
```

"Show the chunk across the top, the question below it, and add a box for comments under that", on the `item-list` design:

```json
{
  "rows": [
    {
      "slots": [
        "data"
      ]
    },
    {
      "slots": [
        "item-choice"
      ]
    },
    {
      "slots": [
        "free-text"
      ]
    }
  ]
}
```

### When the design is open

`design.open` is true when the requester picked none of the rough designs and describes the page in words. `design.rows` is then only a temporary start, not a choice.

- Choose the boxes the task needs, from `request` and the data: `item-choice` when each tab or page has a list of items to judge, `data-a`, `data-b` and `compare` when two things are compared, and otherwise `choice`. Add `free-text` only when the request asks for a written answer.
- Write `layout` whenever your boxes or their places differ from `design.rows`. Follow every arrangement the request states. Where it states none, follow the "how to place it" column.
- Say in `message` where you put the boxes, especially what you chose on your own.

## Revising a binding

When the input has `current`, reply with the whole revised binding, not only the part that changed.

- Change what `request` asks for and nothing else. Copy every other key exactly as it is in `current`, including `context`, answer `name`s, `layout`, `reference` and `attention`.
- An option is a `[value, label]` pair. When `request` only renames what workers see, change the labels and keep the values.
- Keep `instructions` word for word, unless `request` asks to change them or they mention something you removed. A renamed field or a reworded question is no reason to touch them; if the wording no longer matches, say so in `message`.
- Keep the binding consistent. When you rename option values, update `reference` (`yes`, `no`) and `attention.expected` to the new values. If `reference` uses labels from the data, keep the option values equal to those labels.
- Remove `reference` or `attention` only when `request` asks for that.
- Use `earlier_requests` only to understand words such as "that one". Do not apply them again; their results are already in `current`.
- `message` says only what the reply really does. Judge its language by the sentence of `request`, not by the column names in it: `Query 칸은 빼 줘` is Korean. When `request` gives worker text in another language, write the English text and say that workers see English.

## What you cannot do

Moving, resizing, adding and removing boxes is yours to do with `layout`. Requesters pick another rough design or task type with the buttons above the preview, not through you. When nothing in `request` can be done, reply with only these two keys:

| reply | use it when |
| --- | --- |
| `{"cannot": "layout", "message": "<why>"}` | The request names another rough design or task type, such as "use design C" or "make this a video task". |
| `{"cannot": "format", "message": "<why>"}` | A binding cannot express it, for example drawing regions on an image, a new kind of answer control, a second box of the same kind, a box outside the tabs, a fixed height, pop-ups, colours or fonts, or changing the values in the data. |

When only a part can be done, do that part, reply with the binding, and say in `message` what you left out.

In `message`, suggest only what exists. No rough design has two boxes of the same kind or a box outside the tabs, so another rough design does not help with those.

## When you are told about errors

The console checks your binding and may send back its error messages with your previous binding. Fix exactly those problems and reply with the whole corrected binding.
