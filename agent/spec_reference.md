# Task spec reference

`task_spec.json` is the single input that drives the deterministic pipeline: **preprocess** (records → items → HITs → `hits.csv`), **render** (`template.html`) and **validate**. A planner (a person, or an LLM given a data profile and an annotation prompt) writes the spec; nothing else is needed. This document defines every key, the path language, the variables, the answer-name rule, the attention strategies, the CSV output, and how to design a spec from a prompt.

## 1. Concepts

- **Record**: one element of the source file (a JSON array element, a value of a JSON object, a JSONL line, or a CSV row).
- **Item**: one tab in the HIT. It shows a set of **context fields** (question, passage, …) and one **target field**: the list of things the worker judges (statements, facts, answers). Items are produced by iterating over lists or maps inside a record (`item.iterate`); with no `iterate`, each record is one item.
- **Question and options**: the worker answers the same question for every target of an item by choosing one option.
- **HIT**: `hit.items_per_hit` items plus optional **attention items** whose expected answer is known.
- **Hint**: an existing label (from an LLM or a gold standard) for each (item, target) pair. Hints are written to the CSV as the **reference column** the console uses to compare worker answers.

The output must be a single JSON object. Comments and trailing commas are not allowed, unknown keys are errors, and keys with a default may be omitted.

## 2. Skeleton

```jsonc
{
  "spec_version": 1,
  "task":         { "id", "title", "description", "keywords" },
  "source":       { "format", "record_id", "filter", "sample", "limit" },
  "item": {
    "iterate":    [ { "var", "path", "limit" } ],
    "fields":     { "<name>": { "path", "label", "role", "style" } },
    "question":   { "text", "options": [ { "value", "label" } ], "answer_suffix" },
    "hint":       { "label_path", "reason_path", "map", "missing" },
    "skip_if_no_targets": true
  },
  "hit": {
    "items_per_hit": 10,
    "group_by": "record",
    "attention":  { "per_hit", "position", "seed", "strategy", "expected_value", "max_targets", "mismatch", "instruction" }
  },
  "instructions": { "summary", "background", "criteria", "steps", "notes", "tip", "notices" },
  "output":       { "reference_column", "reason_column" },
  "planner_notes": null
}
```

## 3. Keys

### `spec_version`

Always `1`.

### `task`

| key | required | meaning |
| --- | --- | --- |
| `id` | yes | `^[a-z0-9][a-z0-9-]*$`. Used in file names and batch names. |
| `title` | yes | HIT title shown to workers. Short, generic, no internal names. |
| `description` | no (default `""`) | HIT description shown to workers. |
| `keywords` | no (default `[]`) | List of strings. |

### `source`

| key | default | meaning |
| --- | --- | --- |
| `format` | `null` | `null` = detect from the file; otherwise `"json_array"`, `"json_object_values"`, `"jsonl"` or `"csv"`. |
| `record_id` | `null` | Path to a string or integer that identifies the record (`"$.id"`). `null` = `r{record_no}` (`r1`, `r2`, …). |
| `filter` | `null` | `{"path": "$.split", "equals": "test"}` keeps records whose value equals the given value; `{"path": "$.labels", "exists": true}` keeps records where the path resolves (`false`: where it does not). |
| `sample` | `null` | `{"n": 160, "seed": 7}`: random sample of the filtered records. |
| `limit` | `null` | Keep the first N records (after the sample). |

For `json_object_values` sources (a JSON object whose values are the records) each record gets its key as `"_key"`, so `"record_id": "$._key"` works.

### `item.iterate`

A list of zero or more `{"var": "passage", "path": "$.passages.retriever_a", "limit": 10}` entries.

- Each `path` must resolve to a **list** or an **object** in every record. One item is produced per element (per value, for an object). `limit` keeps only the first N elements.
- Several entries form a Cartesian product; a later `path` may use the variables of earlier entries.
- Each entry defines the variables `{var}` (the element), `{var}_index` (0-based), `{var}_no` (1-based) and `{var}_key` (the object key, or the index for a list).
- With no entries, each record is exactly one item.

### `item.fields`

An object whose keys are the field names and whose values describe the fields. The order is the display order and the CSV column order.

| key | default | meaning |
| --- | --- | --- |
| `path` | required | Path evaluated with the item variables. |
| `label` | the field name | Heading shown above the value. |
| `role` | `"context"` | `"context"`: shown to the worker as evidence. `"target"`: the list the worker judges. **Exactly one field must be the target.** |
| `style` | `"text"` | `"text"`: plain paragraph. `"passage"`: scrollable box for long texts. `"list"`: numbered list (for a context value that is a list of strings). |

Rules: field names match `^[A-Za-z_][A-Za-z0-9_]*$` and must not be `hit_id`, `record_ids`, `item_ids`, `attention` or either output column name. A context path must resolve to a string (numbers are converted) or to a list of strings. The target path must resolve to a **list of strings**; if it resolves to an object, its values are the targets and its keys become `target_key`. Use a trailing wildcard to take all values of a map: `"$.facts.model_a[*]"`.

### `item.question`

| key | default | meaning |
| --- | --- | --- |
| `text` | required | The question shown above the options for each target. |
| `options` | required | At least two `{"value", "label"}` objects. `value` is the stored answer (`^[A-Za-z0-9_ .-]+$`, unique); `label` is what the worker reads (default: the value). |
| `answer_suffix` | `""` | Appended to every answer name (see §5). `^[A-Za-z0-9_]*$`. |

### `item.hint`

`null`, or an object evaluated once per (item, target) pair with the item variables plus the target variables (§4):

| key | default | meaning |
| --- | --- | --- |
| `label_path` | required | Path to the existing label of this target for this item. |
| `reason_path` | `null` | Path to a free-text reason for that label. |
| `map` | `null` | Raw label (`str(value).strip()`) → option value, e.g. `{"Yes": "grounded", "No": "not_grounded"}`. `null` means the raw value is used as is, so it must already be an option value. |
| `missing` | `null` | Option value used when the path does not resolve or the raw label is not in `map`. `null` = no reference for that target. |

### `item.skip_if_no_targets`

Default `true`: items whose target list is empty are dropped silently (the count is reported). `false`: an empty target list is an error.

### `hit`

| key | default | meaning |
| --- | --- | --- |
| `items_per_hit` | `10` | Items per HIT, not counting attention items. At least 1. |
| `group_by` | `"record"` | `"record"`: the items of one record are cut into HITs of `items_per_hit`; the last HIT of a record may be shorter, and a HIT never mixes records. `"sequential"`: all items in order, cut every `items_per_hit`. |
| `attention` | `null` | Attention-check settings (below). |

### `hit.attention`

| key | default | meaning |
| --- | --- | --- |
| `per_hit` | `1` | Attention items per HIT (0 or more). |
| `position` | `"random"` | `"random"` (decided by `seed + hit_index`), `"first"` or `"last"`. |
| `seed` | `42` | Seed for random positions. |
| `strategy` | required | `"mismatch"` or `"instruction"` (§6). |
| `expected_value` | required | The option value a careful worker must choose. |
| `max_targets` | `null` | Keep only the first N targets in the attention item. |
| `mismatch` | required for `mismatch` | `{"swap_fields": ["question", "passage"], "distance": 50}`: context fields to replace, and the record offset. |
| `instruction` | required for `instruction` | `{"text": "This is an attention check. Please choose \"Not supported\"."}` |

### `instructions`

The Instructions panel of the template. In every text, `**bold**` becomes bold; everything else is shown literally.

| key | default | meaning |
| --- | --- | --- |
| `summary` | `task.description` | One or two sentences: what the worker decides. Shown highlighted. |
| `background` | `null` | Where the data comes from and why it matters, in worker terms. |
| `criteria` | `[]` | `[{"label": "Supported", "text": "…"}, …]`: one entry per option, defining it with the borderline cases. |
| `steps` | `[]` | Numbered procedure ("Read the passage.", …). |
| `notes` | `[]` | Short rules and pitfalls. |
| `tip` | `null` | One practical hint. |
| `notices` | `{"attention": true, "research": true}` | Show the notice boxes "this HIT contains attention checks" and "answers are used for research". |

### `output`

| key | default | meaning |
| --- | --- | --- |
| `reference_column` | `"llm_label"` | CSV column holding `{answer name: option value}` built from the hints. Chosen as the review reference in the console. |
| `reason_column` | `null` | CSV column holding `{answer name: reason}` when `hint.reason_path` is set. |

### `planner_notes`

`null` (the default) or a string: a short note of at most five sentences, in English, in which the planner explains its choices: which paths became the context fields, the target and the hint and why, which anomalies it took into account, and any assumption it made about the data or the prompt. The pipeline stores the note in `task_spec.json` and ignores it otherwise, so a person reviewing the spec can see the reasoning behind it.

## 4. Path language

```
path     = root segment*
root     = "$"                the record
         | "{" var "}"        the value of a variable is the root: {passage}, {passage}.text
segment  = "." name           object key; name = [A-Za-z_][A-Za-z0-9_-]*
         | "[" 'key' "]"      object key in single or double quotes: ['Passage 1'], ["it's"]; escapes \' \" \\
         | "[" integer "]"    list index; negative counts from the end ([-1] is the last element)
         | "[*]"  |  ".*"     wildcard: every element of a list, or every value of an object
```

Substitution: `{name}` anywhere in the path, including inside quotes, is replaced by the text of the variable before the path is evaluated. `['Fact {target_no}']` becomes `['Fact 2']`. Substitution happens once; an unknown variable is an error.

Evaluation:

- Without a wildcard the path yields one value. With wildcards it yields a list; each wildcard flattens one level, so `$.a[*].b[*]` is the flat list of all `b` elements.
- A missing key or index, or a type mismatch (`.name` on a list, `[0]` on an object, `[*]` on a string), makes the value **missing**. This is not an error by itself: inside a wildcard the element is skipped; a missing context field or iterate path is reported at preprocess time; a missing hint uses `hint.missing`.

Examples for the record `{"id": "r1", "question": "Q?", "passages": {"retriever_a": ["p1", "p2"]}, "facts": {"model_a": {"Fact 1": "f1", "Fact 2": "f2"}}, "labels": {"Passage 1": {"Fact 1": ["Yes", "because"]}}}`:

| path | result |
| --- | --- |
| `$.question` | `"Q?"` |
| `$.passages.retriever_a` | `["p1", "p2"]` (a list: usable as an iterate path) |
| `$.passages.retriever_a[0]` | `"p1"` |
| `$.passages.retriever_a[-1]` | `"p2"` |
| `$.facts.model_a[*]` | `["f1", "f2"]` (values of the map; keys become `target_key`) |
| `$.labels['Passage {passage_no}']['Fact {target_no}'][0]` with passage_no = 1, target_no = 1 | `"Yes"` |
| `$.labels['Passage 2']` | missing |
| `{passage}` with the iterate variable `passage` = `"p1"` | `"p1"` |

## 5. Variables

| variable | available in | value |
| --- | --- | --- |
| `record_index` | everywhere | 0-based position of the record after filter, sample and limit |
| `record_no` | everywhere | `record_index + 1` |
| `record_id` | everywhere | the record id (`source.record_id` or `r{record_no}`) |
| `X`, `X_index`, `X_no`, `X_key` | later iterate paths, fields, hint | for each iterate entry with `"var": "X"`: the element, its 0-based index, its 1-based number, and its key (object key, or index for a list) |
| `target` | hint paths only | the target text |
| `target_index`, `target_no` | hint paths only | 0-based / 1-based position of the target in the target list |
| `target_key` | hint paths only | the key of the target if the target list came from an object, else its index |

Use `{X_no}` and `{target_no}` for keys such as `'Passage 3'` and `'Fact 2'`, `{X_key}` and `{target_key}` when the label structure is keyed by the same keys as the data.

## 6. Answer names

Every (item, target) pair has one radio group named

- `general_{i}_{j}{answer_suffix}` for a normal item,
- `attention_{i}_{j}{answer_suffix}` for an attention item,

where `i` is the index of the item within the HIT (0-based, counting attention items at their position) and `j` is the target number (1-based). Example: a HIT with an attention item in position 3 and two targets each has `general_0_1`, `general_0_2`, `general_1_1`, …, `attention_3_1`, `attention_3_2`, `general_4_1`, …. The `attention_` prefix is what the console's attention rule (`namePrefix: "attention_"`) recognises.

## 7. Attention strategies

Both strategies copy the first item of the HIT, cut its targets to `max_targets`, mark the item as attention, and give every target the reference value `expected_value`. The item's record id in the CSV is `"attention"`.

- **`mismatch`**: the values of `swap_fields` (context fields) are replaced by the values of the same-position item of another record, `(record_index + distance) mod N` (the next record if that is the same one; the other record's first item if it has no item at that position). The targets stay. This works when the targets can only be judged from the swapped context (a passage from another record cannot support these statements), and the expected answer is the negative option (`not_grounded`, `not_relevant`, …). Swap every context field that carries the topic, otherwise the item may still look consistent.
- **`instruction`**: the targets are replaced by the single sentence `instruction.text`, which tells the worker which option to choose, e.g. `This is an attention check. Please choose "Not supported".` The expected answer is the option named in the sentence. This works for any task and is easier to spot, so prefer `mismatch` when the task is a support or relevance judgement.

## 8. CSV output (`hits.csv`)

One row per HIT, every cell a JSON value (so the template can use it as a JavaScript literal):

| column | content |
| --- | --- |
| `hit_id` | `"hit-0001"`, `"hit-0002"`, … |
| `record_ids` | list, one entry per item: the record id, or `"attention"` |
| `item_ids` | list, one entry per item: `"{record_id}#{var}={key}"` joined for each iterate level (`"r001#passage=2"`), or `"attention"` |
| `attention` | list of 0/1, one per item |
| one column per field, in spec order | list, one entry per item: the context value (string or list of strings); for the target field a list of strings, so the column is a list of lists |
| the reference column | object `{answer name: option value}`; attention answers are `expected_value`; targets without a hint are omitted |
| the reason column (if set) | object `{answer name: reason text}` |

The console warns about rows larger than 64 KB (MTurk's HIT size limit, kept as a guideline), so keep `items_per_hit × text length` in mind (4–6 items for passages of several hundred words).

## 9. How to design a spec from a prompt

1. **Find the unit of judgement** in the prompt: what the worker looks at (context) and what they decide about (targets). Context fields are the evidence the worker needs (question, passage, answer, …). The single target field is the list of things being judged, with one answer each (statements, facts, candidate answers). Use `style: "passage"` for long texts and `style: "list"` for a context that is a list.
2. **Choose `iterate`** so that each item shows one piece of evidence with all of its targets: iterate over the passage list when the judgement is "passage supports statement", over nothing when the record itself is the item. Use `limit` when the prompt asks for the first N.
3. **Use the profile.** Paths marked "candidate context field" are context, "candidate target list" is the target, "candidate LLM label" is `hint.label_path`. Map keys such as `'Passage {n}'` and `'Fact {n}'` are addressed with variables: `['Passage {passage_no}']`, `['Fact {target_no}']`. Make sure the label path refers to the same (item, target) pair as the field paths (same retriever, same model, same list).
4. **Options**: two to four short, mutually exclusive labels. Values are stable identifiers (`grounded`, `not_grounded`); labels are what workers read (`Supported`, `Not supported`).
5. **Hint map**: map the observed label values listed under `values` in the profile to option values. Leave `missing` null unless the prompt says what an absent label means.
6. **HIT size**: `items_per_hit` at most 10, fewer (4–6) for long passages. `group_by: "record"` unless the prompt asks for mixed HITs.
7. **Attention**: prefer a strategy whose expected answer is unambiguous. For support or relevance judgements use `mismatch` swapping every topical context field, with the negative option as `expected_value`; otherwise use `instruction`. Set `max_targets` (1–2) to keep the attention item short.
8. **Instructions**: concrete and worker-facing, in English. Say what to read, define every option with its borderline case, give a short numbered procedure, and add notes such as "judge only from the passage". Never mention model names, retriever names or internal dataset names.
9. **Anomalies**: if the profile reports a type mismatch or missing values on a path you need, avoid the path, filter the records, or accept that those items are skipped or get no hint. An iterate path that does not resolve in a record is an error, so iterate only over paths present in every record.
10. **Notes**: fill `planner_notes` with at most five sentences: which paths you chose as context, target and label and why, which anomalies you took into account, and any assumption about the data or the prompt.
11. **Output** only the JSON object: no comments, no trailing commas, no unknown keys.

## 10. Complete example

The synthetic example in `agent/examples/groundedness/` (`raw.json`, `prompt.md`) is a set of records with a question, several retrieved passages per retriever, a map of short statements ("facts") per model, and per-passage, per-fact labels `["Yes" | "No", reason]`. The prompt asks for HITs that show one passage with all facts of the record and ask, for each fact, whether the passage supports it, with the existing labels as the reference. This is the spec:

```json
{
  "spec_version": 1,
  "task": {
    "id": "passage-fact-support",
    "title": "Judge whether each statement is supported by a passage",
    "description": "Read one passage and decide, for each short statement, whether the passage supports it.",
    "keywords": [
      "reading",
      "fact checking",
      "english"
    ]
  },
  "source": {
    "format": null,
    "record_id": "$.id",
    "filter": null,
    "sample": null,
    "limit": null
  },
  "item": {
    "iterate": [
      {
        "var": "passage",
        "path": "$.passages.retriever_a",
        "limit": 4
      }
    ],
    "fields": {
      "question": {
        "path": "$.question",
        "label": "Question",
        "role": "context",
        "style": "text"
      },
      "passage": {
        "path": "{passage}",
        "label": "Passage",
        "role": "context",
        "style": "passage"
      },
      "facts": {
        "path": "$.facts.model_a[*]",
        "label": "Statement",
        "role": "target",
        "style": "text"
      }
    },
    "question": {
      "text": "Is this statement supported by the passage?",
      "options": [
        {
          "value": "grounded",
          "label": "Supported"
        },
        {
          "value": "not_grounded",
          "label": "Not supported"
        }
      ],
      "answer_suffix": ""
    },
    "hint": {
      "label_path": "$.labels.retriever_a.model_a.passage_fact_support['Passage {passage_no}']['Fact {target_no}'][0]",
      "reason_path": "$.labels.retriever_a.model_a.passage_fact_support['Passage {passage_no}']['Fact {target_no}'][1]",
      "map": {
        "Yes": "grounded",
        "No": "not_grounded"
      },
      "missing": null
    },
    "skip_if_no_targets": true
  },
  "hit": {
    "items_per_hit": 4,
    "group_by": "record",
    "attention": {
      "per_hit": 1,
      "position": "random",
      "seed": 42,
      "strategy": "mismatch",
      "expected_value": "not_grounded",
      "max_targets": 2,
      "mismatch": {
        "swap_fields": [
          "question",
          "passage"
        ],
        "distance": 3
      },
      "instruction": null
    }
  },
  "instructions": {
    "summary": "Your task is to decide whether each short statement is **supported by the passage** shown in the same tab.",
    "background": "The statements were written to answer the question at the top of each tab. The passage was retrieved automatically and may or may not talk about the same thing. We want to know whether a careful reader of the passage alone would agree that the statement is true.",
    "criteria": [
      {
        "label": "Supported",
        "text": "The passage says what the statement says, directly or in slightly different words. Everything in the statement can be confirmed from the passage."
      },
      {
        "label": "Not supported",
        "text": "The passage does not mention the statement, contradicts it, or confirms only part of it. Use this option when you would need outside knowledge to accept the statement."
      }
    ],
    "steps": [
      "Read the question, then read the whole passage.",
      "For each statement below the passage, ask: does this passage, by itself, confirm the statement?",
      "Choose **Supported** or **Not supported** for every statement. Do not leave any statement unanswered.",
      "Move to the next tab. The Submit button becomes active when every statement in every tab has an answer."
    ],
    "notes": [
      "Judge only from the passage. Do not use what you already know about the topic.",
      "A statement that is partly confirmed and partly missing counts as **Not supported**.",
      "The same statements appear with several different passages; judge each passage on its own."
    ],
    "tip": "If the passage is about a different topic from the question, every statement is almost certainly Not supported.",
    "notices": {
      "attention": true,
      "research": true
    }
  },
  "output": {
    "reference_column": "llm_label",
    "reason_column": "llm_reason"
  },
  "planner_notes": "Each record has one question, a passage list per retriever and a map of short statements per model; following the prompt, one item is one passage of passages.retriever_a shown with all statements of facts.model_a, so support is judged passage by passage. The labels under labels.retriever_a.model_a.passage_fact_support are keyed 'Passage {n}' and 'Fact {n}', which line up with passage_no and target_no, and their Yes/No values map to the two options. The subqueries field is a string in one record, but no path uses it."
}
```
