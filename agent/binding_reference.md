# Binding format

A **binding** says which value of a HIT goes into which slot of a rough design. The console draws the page from it, so you write only the binding, never HTML.

Reply with **one JSON object** and nothing else.

## The input you get

- `design`: the rough design the requester chose. `rows[].slots` lists its slots, left to right. You may fill only these slots.
- `task_type`: `vision`, `video` or `text`.
- `request`: what the requester wants workers to judge. Follow it. The questions you write come from this text.
- `data`: the shape of the requester's HIT data. Each entry of `columns` has the column `name`, its `shape`, and `samples` from real HITs. Long texts are cut in the samples; the real values are longer.

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

Write `instructions`, `header`, `label`, option labels and `placeholder` in the language of the data workers read, even when the request is in another language, unless the request asks for a language.

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

## When you are told about errors

The console checks your binding and may send back its error messages with your previous binding. Fix exactly those problems and reply with the whole corrected binding.
