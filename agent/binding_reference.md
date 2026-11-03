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
| `attention` | no | `{"flag": "<path>"}` when a column marks attention checks with 1. |
| `instructions` | yes | One or two sentences that tell workers what to do. Write them in the language of the data shown to workers, and do not mention attention checks. |

## Slots

| slot | value |
| --- | --- |
| `data`, `data-a`, `data-b` | `{"label": "<short title>", "from": "<path>"}`. `data` may be an array of these to show several values, in the order workers should read them. For `vision` and `video`, the path must give a URL. |
| `choice` | One answer from a list: `{"name": "<answer name>", "header": "<question>", "options": [["value", "Label"], …]}`. At least two options. |
| `compare` | One answer that picks between `data-a` and `data-b`. Same keys as `choice`. Without `options` it offers first, second and about the same. |
| `checklist` | Check every item that applies: `{"name": "<answer name>", "header": "<question>", "items": "<path to a list of strings>"}`. |
| `free-text` | A short written answer: `{"name": "<answer name>", "header": "<question>", "placeholder": "<hint>"}`. |

Answer names use letters, digits and `_`, and start with a letter or `_`.

## Paths

A path is a column name followed by any of `[i]` (the element of the current tab), `[0]` (a fixed element) and `.key` (a key of an object). Take column names only from `data.columns`. Use `[i]` only with `repeat`.

Read the `shape` to choose: when a column is `list[11] of str` and each tab shows one element, write `column[i]`. When a column is `list[11] of list[str]`, `column[i]` is a list of strings and fits `items`.

## How to choose

1. Find the unit workers judge. If the columns are lists of the same length, each element is one item: set `repeat` over the column that best names the item.
2. Put what workers must read into the data slots, and only that. Leave out identifiers, counts, attention flags, existing labels and reasoning: columns such as `qid`, `key_counts`, `attention_check`, `*_check` and `*_reasoning` must not be shown to workers.
3. Write the question in the answer slot from the `request`. Fill every answer slot of the design that the request gives a reason to fill. Leave a slot out if the request says nothing that fits it; the console then shows an example question and warns the requester.
4. Set `attention` when a column such as `attention_check` holds the flags.

## Example

The data has list columns `query`, `retrieved_chunk` and `atomic_facts` of the same length, the design is `item-list`, and the request asks workers to check which facts each chunk supports.

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
    "checklist": {
      "name": "supported",
      "header": "Which atomic facts does this chunk support?",
      "items": "atomic_facts[i]"
    }
  },
  "attention": {
    "flag": "attention_check[i]"
  },
  "instructions": "For each chunk, read the query and the chunk, then check every atomic fact that the chunk supports."
}
```

## When you are told about errors

The console checks your binding and may send back its error messages with your previous binding. Fix exactly those problems and reply with the whole corrected binding.
