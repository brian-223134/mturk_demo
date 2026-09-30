# Task spec reference

`task_spec.json` is the single input that drives the deterministic pipeline: **preprocess** (records → items → HITs → `hits.csv`), **render** (`template.html`) and **validate**. A planner (a person, or an LLM given a data profile and an annotation prompt) writes the spec; nothing else is needed. This document defines every key, the path language, the variables, the question types, the answer-name rule, the attention strategies, the CSV output, and how to design a spec from a prompt.

## 1. Concepts

- **Record**: one element of the source file (a JSON array element, a value of a JSON object, a JSONL line, or a CSV row).
- **Item**: one tab in the HIT. It shows **context fields** (question, passage, …) and at most one **target field**: the list of things the worker judges one by one (statements, facts, sub-questions). Items are produced by iterating over lists or maps inside a record (`item.iterate`); with no `iterate`, each record is one item.
- **Questions**: every tab asks the same list of questions (`item.questions`). A question has a **type** (`choice`, `multi_select`, `likert`, `text`) and a **scope**: `"target"` asks it once for every target of the tab, `"item"` asks it once per tab.
- **HIT**: `hit.items_per_hit` items plus optional **attention items** whose expected answers are known. Workers cannot tell attention items from normal ones.
- **Hint**: where an existing label (from an LLM or a gold standard) sits in the record, per question. Hints become the **reference column** of the CSV that the console compares worker answers with. Expected answers of attention items go to a separate **attention column**.

The output must be a single JSON object. Comments and trailing commas are not allowed, unknown keys are errors, and keys with a default may be omitted.

## 2. Skeleton

```jsonc
{
  "spec_version": 2,
  "task":         { "id", "title", "description", "keywords" },
  "source":       { "format", "record_id", "filter", "sample", "limit" },
  "item": {
    "iterate":    [ { "var", "path", "limit", "group_size" } ],
    "fields":     { "<name>": { "path", "label", "role", "style" } },
    "questions":  [ { "id", "text", "type", "scope", "options": [ { "value", "label" } ], "none_label", "scale",
                      "min_chars", "required", "required_when", "hint": { "label_path", "reason_path", "contains", "map", "missing" } } ],
    "skip_if_no_targets": true
  },
  "hit": {
    "items_per_hit": 10,
    "group_by": "record",
    "attention":  { "per_hit", "position", "seed", "strategy", "expected": { "<question id>": "<value>" }, "max_targets", "mismatch", "instruction" }
  },
  "instructions": { "summary", "background", "criteria", "steps", "notes", "tip", "notices" },
  "output":       { "reference_column", "reason_column", "attention_column" },
  "planner_notes": null
}
```

## 3. Keys

### `spec_version`

Always `2`. (Version `1` is the legacy single-question format with `item.question`, `item.hint` and `hit.attention.expected_value`. The pipeline still reads it for old files, but never write it.)

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

A list of zero or more `{"var": "passage", "path": "$.passages.retriever_a", "limit": 10, "group_size": null}` entries.

- Each `path` must resolve to a **list** or an **object** in every record. One item is produced per element (per value, for an object). `limit` keeps only the first N elements.
- `group_size` (default `null`, otherwise at least 2) cuts the elements, after `limit`, into consecutive groups of that size and produces one item per group; an incomplete last group is dropped. The variable is then the group (a list), so `{pair}[0]` and `{pair}[1]` are its first and second element. Use `group_size: 2` to show two passages side by side (A/B comparison).
- Several entries form a Cartesian product; a later `path` may use the variables of earlier entries.
- Each entry defines the variables `{var}` (the element or group), `{var}_index` (0-based), `{var}_no` (1-based) and `{var}_key` (the object key, or the index for a list; for a group, the key of its first element).
- With no entries, each record is exactly one item.

### `item.fields`

An object whose keys are the field names and whose values describe the fields. The order is the display order and the CSV column order.

| key | default | meaning |
| --- | --- | --- |
| `path` | required | Path evaluated with the item variables. |
| `label` | the field name | Heading shown above the value (for the target field: the name of one target, such as "Statement"). |
| `role` | `"context"` | `"context"`: shown to the worker as evidence. `"target"`: the list the worker judges one by one. **At most one field may be the target**, and a target field is needed as soon as one question has scope `"target"`. |
| `style` | `"text"` | `"text"`: plain paragraph. `"passage"`: scrollable box for long texts. `"list"`: numbered list (for a context value that is a list of strings). |

Rules: field names match `^[A-Za-z_][A-Za-z0-9_]*$` and must not be `hit_id`, `record_ids`, `item_ids`, `attention` or an output column name. A context path must resolve to a string (numbers are converted) or to a list of strings. The target path must resolve to a **list of strings**; if it resolves to an object, its values are the targets and its keys become `target_key`. Use a trailing wildcard to take all values of a map: `"$.facts.model_a[*]"`.

### `item.questions`

A list of one or more questions, asked in this order in every tab.

| key | default | meaning |
| --- | --- | --- |
| `id` | required | `^[a-z][a-z0-9_]*$`, unique. It ends every answer name (§6). If one of two questions is a `text` question, neither id may end with `_` + the other id (not `info` together with `missing_info`). |
| `text` | required | The question shown to the worker. `**bold**` becomes bold. |
| `type` | `"choice"` | `"choice"`, `"multi_select"`, `"likert"` or `"text"` (table below). |
| `scope` | `"target"` | `"target"`: asked once for every target of the tab (needs the target field). `"item"`: asked once per tab. |
| `options` | `[]` | `{"value", "label"}` objects. `value` is the stored answer (`^[A-Za-z0-9_ .-]+$`, unique); `label` is what the worker reads (default: the value). |
| `none_label` | `null` | `multi_select` only: label of the extra "none of them" box. `null` = `"None of the above"`. |
| `scale` | `null` | `likert` only: `{"min": 1, "max": 5, "min_label": "Not at all", "max_label": "Completely"}`, integers with `max > min` and at most 11 points; the labels may be `null`. |
| `min_chars` | `0` | `text` only: minimum length of a required answer. |
| `required` | `true` | Whether the worker must answer. `false`: the question may be left empty. |
| `required_when` | `null` | `{"question": "<id of an earlier question>", "value": "<one of its values>"}`: the question (which must have `required: true`) is required only when that answer equals the value. A target-scoped question looks at the answer for the same target (or at the tab's answer if the earlier question is item-scoped); an item-scoped question may only refer to an item-scoped question. The earlier question must not be a `text` question. |
| `hint` | `null` | Where the existing label for this question is (below). Not allowed for `text`. |

The four types:

| type | the worker sees | answers stored | `options` | use it when the prompt says |
| --- | --- | --- | --- | --- |
| `choice` | one row of buttons, pick one | the chosen option value | at least 2 | "Supported / Contradicted / Not mentioned for each statement" (scope `target`); "which of the two passages answers better" or "is the sub-question fully answered" (scope `item`) |
| `multi_select` | the question once, then one checkbox per target plus a "none of them" box | one answer per target: `options[0].value` if ticked, `options[1].value` if not | exactly 2: `[value when ticked, value when not ticked]` | "tick every statement the passage supports", "select all sub-questions this passage answers". Scope must be `target`. |
| `likert` | a scale of numbered buttons with optional end labels | the number as a string (`"1"` … `"5"`) | none (`[]`) | "rate from 1 to 5 how …" |
| `text` | a text box | the trimmed text; an empty optional answer is left out | none (`[]`) | "write what is missing", "explain briefly". Usually `required_when` another answer, or `required: false`. No hint and no attention value. |

A `multi_select` counts as answered once any box (a target or the "none" box) is ticked. Ticking "none" clears the other boxes and ticking a target clears "none".

### `item.questions[].hint`

`null`, or an object that says where the existing label of this question is. It is evaluated once per (item, target) pair for a target-scoped question (the item variables plus the target variables of §5 are available) and once per item for an item-scoped question (item variables only).

| key | default | meaning |
| --- | --- | --- |
| `label_path` | required | Path to the existing label. |
| `reason_path` | `null` | Path to a free-text reason for that label (written to the reason column). |
| `contains` | `null` | A text with variables, such as `"{target_key}"`. When set, `label_path` must resolve to a list (or an object, meaning its keys) and the raw label is `"true"` if it contains the text and `"false"` if not; when `label_path` does not resolve, the result is `missing`. Use it for labels stored as lists of selected keys, e.g. `selected_facts: ["Atomic fact1", "Atomic fact3"]`. It compares with the list elements as they appear in the data — usually keys, so `"{target_key}"` or `"Chunk {x_no}"`, not the displayed text `"{target}"`. |
| `map` | `null` | Raw label (`str(value).strip()`) → value of this question, e.g. `{"Yes": "grounded", "No": "not_grounded"}` or, with `contains`, `{"true": "supported", "false": "not_supported"}`. `null` means the raw value is used as is, so it must already be a value of the question. |
| `missing` | `null` | Value used when the path does not resolve or the raw label is not in `map`. `null` = no reference for that answer. Set it when an absent label has a known meaning. With `contains` on a map that lists only the positive entries (an absent key, or an empty map, means "none"), set it to the negative value such as `not_supported`; otherwise those answers get no reference. |

### `item.skip_if_no_targets`

Default `true`: items whose target list is empty are dropped silently (the count is reported). `false`: an empty target list is an error. Ignored when there is no target field.

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
| `strategy` | required | `"mismatch"` or `"instruction"` (§7). |
| `expected` | required | `{"<question id>": "<value>"}`: the answer a careful worker must give, for at least one non-text question. It applies to every answer of that question in the attention item (for a target-scoped question: to every target). For a `multi_select` the expected value is usually `options[1].value` ("nothing ticked"). |
| `max_targets` | `null` | Keep only the first N targets in the attention item. |
| `mismatch` | required for `mismatch` | `{"swap_fields": ["question", "passage"], "distance": 50}`: context fields to replace, and the record offset. |
| `instruction` | required for `instruction` | `{"text": "This is an attention check. Please choose \"Not supported\"."}`. Needs a target field. |

### `instructions`

The Instructions panel of the template. In every text, `**bold**` becomes bold; everything else is shown literally.

| key | default | meaning |
| --- | --- | --- |
| `summary` | `task.description` | One or two sentences: what the worker decides. Shown highlighted. |
| `background` | `null` | Where the data comes from and why it matters, in worker terms. |
| `criteria` | `[]` | `[{"label": "Supported", "text": "…"}, …]`: one entry per option (and per term the worker must understand), defining it with the borderline cases. |
| `steps` | `[]` | Numbered procedure ("Read the passage.", …). |
| `notes` | `[]` | Short rules and pitfalls. |
| `tip` | `null` | One practical hint. |
| `notices` | `{"attention": true, "research": true}` | Show the notice boxes "this HIT contains attention checks" and "answers are used for research". |

### `output`

| key | default | meaning |
| --- | --- | --- |
| `reference_column` | `"llm_label"` | CSV column holding `{answer name: value}` built from the hints of normal items. Chosen as the review reference in the console. |
| `reason_column` | `null` | CSV column holding `{answer name: reason}` when a hint has `reason_path`. |
| `attention_column` | `"attention_expected"` | CSV column holding `{answer name: expected value}` for the attention items. The console's attention rule reads it. |

The three column names match `^[A-Za-z_][A-Za-z0-9_]*$`, differ from each other and from the field names, and are not `hit_id`, `record_ids`, `item_ids` or `attention`.

### `planner_notes`

`null` (the default) or a string: a short note of at most five sentences, in English, in which the planner explains its choices: which paths became the context fields, the target, the questions and their hints and why, which anomalies it took into account, and any assumption it made about the data or the prompt. The pipeline stores the note in `task_spec.json` and ignores it otherwise, so a person reviewing the spec can see the reasoning behind it.

## 4. Path language

```
path     = root segment*
root     = "$"                the record
         | "{" var "}"        the value of a variable is the root: {passage}, {passage}.text, {pair}[0]
segment  = "." name           object key; name = [A-Za-z_][A-Za-z0-9_-]*
         | "[" 'key' "]"      object key in single or double quotes: ['Passage 1'], ["it's"]; escapes \' \" \\
         | "[" integer "]"    list index; negative counts from the end ([-1] is the last element)
         | "[*]"  |  ".*"     wildcard: every element of a list, or every value of an object
```

Substitution: `{name}` anywhere in the path, including inside quotes, is replaced by the text of the variable before the path is evaluated. `['Fact {target_no}']` becomes `['Fact 2']`. Substitution happens once; an unknown variable is an error.

Evaluation:

- Without a wildcard the path yields one value. With wildcards it yields a list; each wildcard flattens one level, so `$.a[*].b[*]` is the flat list of all `b` elements.
- A missing key or index, or a type mismatch (`.name` on a list, `[0]` on an object, `[*]` on a string), makes the value **missing**. This is not an error by itself: inside a wildcard the element is skipped; a record whose context field, target or iterate path is missing or has the wrong type is skipped at preprocess time and reported; a missing hint uses `hint.missing`.
- After `.` only a plain name may follow. A key that is a variable or starts with a digit is written in quotes (`['{sub_key}']`, `['Core subquery {sub_no}']`), a list index in brackets (`[0]`).

Examples for the record `{"id": "r1", "question": "Q?", "passages": {"retriever_a": ["p1", "p2"]}, "facts": {"model_a": {"Fact 1": "f1", "Fact 2": "f2"}}, "labels": {"Passage 1": {"Fact 1": ["Yes", "because"]}}, "support": {"Passage 2": {"selected": ["Fact 2"]}}}`:

| path | result |
| --- | --- |
| `$.question` | `"Q?"` |
| `$.passages.retriever_a` | `["p1", "p2"]` (a list: usable as an iterate path) |
| `$.passages.retriever_a[0]` | `"p1"` |
| `$.passages.retriever_a[-1]` | `"p2"` |
| `$.facts.model_a[*]` | `["f1", "f2"]` (values of the map; keys become `target_key`) |
| `$.labels['Passage {passage_no}']['Fact {target_no}'][0]` with passage_no = 1, target_no = 1 | `"Yes"` |
| `$.labels['Passage 2']` | missing |
| `$.support['Passage {passage_no}'].selected` with passage_no = 2, and `contains: "{target_key}"` with target_key = `"Fact 2"` | `["Fact 2"]` → raw label `"true"` |
| `{passage}` with the iterate variable `passage` = `"p1"` | `"p1"` |
| `{pair}[1]` with `group_size: 2` over `$.passages.retriever_a` | `"p2"` |

## 5. Variables

| variable | available in | value |
| --- | --- | --- |
| `record_index` | everywhere | 0-based position of the record after filter, sample and limit |
| `record_no` | everywhere | `record_index + 1` |
| `record_id` | everywhere | the record id (`source.record_id` or `r{record_no}`) |
| `X`, `X_index`, `X_no`, `X_key` | later iterate paths, fields, hints | for each iterate entry with `"var": "X"`: the element (or group), its 0-based index, its 1-based number, and its key (object key, or index for a list) |
| `target` | hints of target-scoped questions | the target text |
| `target_index`, `target_no` | hints of target-scoped questions | 0-based / 1-based position of the target in the target list |
| `target_key` | hints of target-scoped questions | the key of the target if the target list came from an object, else its index |

Use `{X_no}` and `{target_no}` for keys such as `'Passage 3'` and `'Fact 2'`, `{X_key}` and `{target_key}` when the label structure is keyed by the same keys as the data (including `contains: "{target_key}"` for lists of selected keys).

## 6. Answer names

Every answer has a name that starts with `general_`:

- `general_{i}_{j}_{id}` for a target-scoped question,
- `general_{i}_{id}` for an item-scoped question,

where `i` is the index of the item within the HIT (0-based, counting attention items at their position), `j` is the target number (1-based) and `id` is the question id. Attention items use the same names, so nothing in the page reveals them. Example: a HIT whose tabs have two targets each and the questions `support` (target) and `overall` (item) has `general_0_1_support`, `general_0_2_support`, `general_0_overall`, `general_1_1_support`, …. The reference, reason and attention columns use these names as keys.

## 7. Attention strategies

Both strategies copy the first item of the HIT, cut its targets to `max_targets`, and mark the item as attention. Its answers get the values of `hit.attention.expected` (written to the attention column, not the reference column); questions without an expected value are asked but not checked. The item's record id in the CSV is `"attention"`.

- **`mismatch`**: the values of `swap_fields` (context fields) are replaced by the values of the same-position item of another record, `(record_index + distance) mod N` (the next record if that is the same one; the other record's first item if it has no item at that position). The targets stay. This works when the answers can only be judged from the swapped context (a passage from another record cannot support these statements, a statement cannot answer another record's sub-question), and the expected answers are the negative ones (`not_supported`, `not_covered`, `neither`, …). Swap every context field that carries the topic, otherwise the item may still look consistent.
- **`instruction`**: the targets are replaced by the single sentence `instruction.text`, which tells the worker what to answer, e.g. `This is an attention check. Please choose "Not supported".` The expected answer is the one named in the sentence. It needs a target field and is easier to spot, so prefer `mismatch` when the task is a support, relevance or coverage judgement.

## 8. CSV output (`hits.csv`)

One row per HIT, every cell a JSON value (so the template can use it as a JavaScript literal):

| column | content |
| --- | --- |
| `hit_id` | `"hit-0001"`, `"hit-0002"`, … |
| `record_ids` | list, one entry per item: the record id, or `"attention"` |
| `item_ids` | list, one entry per item: `"{record_id}#{var}={key}"` joined for each iterate level (`"r001#passage=2"`), or `"attention"` |
| `attention` | list of 0/1, one per item (not used by the template) |
| one column per field, in spec order | list, one entry per item: the context value (string or list of strings); for the target field a list of strings, so the column is a list of lists |
| the reference column | object `{answer name: value}` for the answers of normal items that have a hint; answers without a label are omitted; text answers never appear |
| the reason column (if set) | object `{answer name: reason text}` |
| the attention column (if attention is on) | object `{answer name: expected value}` for every answer of the attention items whose question has an expected value |

The template uses only `hit_id` and the field columns. The console warns about rows larger than 64 KB (MTurk's HIT size limit, kept as a guideline), so keep `items_per_hit × text length` in mind (4–6 items for passages of several hundred words).

## 9. How to design a spec from a prompt

1. **Read the prompt, then the profile.** The requester's prompt may be a single sentence, in Korean or English; infer everything else from the profile and this guidance. Take every path and field name from this profile, never from the examples (they use other keys, such as `question` where the data may have `query`).
2. **Find the unit of judgement**: what one tab shows (context) and what the worker decides about. The thing judged once per tab (one passage, a pair of passages, one sub-question) is a context field, and its questions have scope `"item"`. A target is a list judged element by element inside the tab (statements, facts, sub-questions); never iterate over the target list itself. Context fields are the evidence the worker needs (question, passage, answer, …). Use `style: "passage"` for long texts and `style: "list"` for a context that is a list.
3. **Choose `iterate`** so that each item shows one piece of evidence with all of its targets: iterate over the passage list when the judgement is "passage supports statement", over the sub-question map when the judgement is per sub-question, over nothing when the record itself is the item. Use `limit` when the prompt asks for the first N ("top-10" → `limit: 10`), and `group_size: 2` with fields `{pair}[0]` and `{pair}[1]` for A/B comparisons.
4. **Write the questions** in the order the worker should answer them. Pick the type from the wording of the prompt:
   - "for each statement: supported, contradicted or not mentioned" → `choice`, scope `target`, one option per label.
   - "tick / select every statement (sub-question, fact) that …" → `multi_select`, scope `target`, options `[ticked value, not-ticked value]`, a `none_label` that reads naturally ("None of the statements is supported").
   - "which of the two passages is better", "is the sub-question fully answered", "does the passage contain the key information" → `choice`, scope `item`.
   - "rate from 1 to 5" → `likert` with a `scale` and end labels.
   - "write what is missing", "explain briefly" → `text`, scope `item` (or `target`), with `required_when` pointing at the answer that makes it necessary (for example `{"question": "has_info", "value": "no"}`), or `required: false` when it is always optional.
   Keep option values stable identifiers (`supported`, `not_supported`) and labels short worker-facing words (`Supported`, `Not supported`). Question ids are short and distinct (`support`, `coverage`, `missing`).
5. **Use the profile.** Paths marked "candidate context field" are context, "candidate target list" is the target, "candidate LLM label" is a `hint.label_path`. Map keys such as `'Passage {n}'` and `'Fact {n}'` are addressed with variables: `['Passage {passage_no}']`, `['Fact {target_no}']`, or `['{sub_key}']` when the labels are keyed by the same keys as the iterated map. Use the retriever and model the requester names. Label, target and context paths must use the same retriever and model keys; when reference labels exist for only one retriever or model, take the targets and the context from that same one.
6. **Hints**: map the observed label values listed under `values` in the profile to question values. When a label is a list of selected keys (`selected_facts: ["Atomic fact1"]`, `["Core subquery1"]`), use `contains` with the key variable (`"{target_key}"`) and a map from `"true"`/`"false"`; when such a map lists only the positive entries, set `missing` to the negative value. Leave `missing` null otherwise, unless the prompt or the data says what an absent label means. Questions without an existing label get `hint: null`.
7. **HIT size and numbers**: copy the requester's numbers. `items_per_hit` at most 10, fewer (4–6) for long passages or several questions per tab; `group_by: "record"` unless the prompt asks for mixed HITs. "N HITs" (for example "HIT 20개") is the total number of HITs, not `items_per_hit`: with `group_by: "record"` a record whose items fit in `items_per_hit` makes one HIT, so set `source.sample` to `{"n": N, "seed": 7}` (fewer records if each record makes several HITs) and say so in `planner_notes`.
8. **Attention**: prefer a strategy whose expected answers are unambiguous. For support, relevance or coverage judgements use `mismatch` swapping every topical context field, and give the negative answer of each checkable question in `expected` (for a `multi_select`, its not-ticked value). Otherwise use `instruction` (needs a target field). Set `max_targets` (1–2) to keep the attention item short.
9. **Instructions**: concrete and worker-facing, in English. Say what to read, define every option and term with its borderline case, give a short numbered procedure that follows the order of the questions, and add notes such as "judge only from the passage". Never mention model names, retriever names, internal dataset names or other keys of the data (such as `rt25` or `mdl-5`); describe them in plain words ("the retrieved passage").
10. **Anomalies**: if the profile reports a type mismatch or missing values on a path you need, avoid the path, filter the records, or accept that those records are skipped (preprocess skips a record whose paths do not resolve or have the wrong type and reports it in `summary.json`; more than half skipped is an error) or get no hint. The first records are checked strictly, so iterate only over paths present in every record.
11. **Notes**: fill `planner_notes` with at most five sentences: which paths you chose as context, target, questions and labels and why, which anomalies you took into account, and any assumption about the data or the prompt.
12. **Output** only the JSON object: no comments, no trailing commas, no unknown keys.

## 10. Complete example

The synthetic example in `agent/examples/groundedness/` (`raw.json`, `prompt.md`) is a set of records with a question, several retrieved passages per retriever, a map of short statements ("facts") per model, and per-passage, per-fact labels `["Yes" | "No", reason]`. The prompt asks for HITs that show one passage with all facts of the record and ask, for each fact, whether the passage supports it, with the existing labels as the reference. It has one target-scoped `choice` question; a second example in `agent/examples/coverage/` combines a `multi_select` with a `contains` hint, an item-scoped `choice` and a `text` question with `required_when`. This is the groundedness spec:

```json
{
  "spec_version": 2,
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
        "limit": 4,
        "group_size": null
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
    "questions": [
      {
        "id": "support",
        "text": "Is this statement supported by the passage?",
        "type": "choice",
        "scope": "target",
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
        "none_label": null,
        "scale": null,
        "min_chars": 0,
        "required": true,
        "required_when": null,
        "hint": {
          "label_path": "$.labels.retriever_a.model_a.passage_fact_support['Passage {passage_no}']['Fact {target_no}'][0]",
          "reason_path": "$.labels.retriever_a.model_a.passage_fact_support['Passage {passage_no}']['Fact {target_no}'][1]",
          "contains": null,
          "map": {
            "Yes": "grounded",
            "No": "not_grounded"
          },
          "missing": null
        }
      }
    ],
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
      "expected": {
        "support": "not_grounded"
      },
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
    "reason_column": "llm_reason",
    "attention_column": "attention_expected"
  },
  "planner_notes": "Each record has one question, a passage list per retriever and a map of short statements per model; following the prompt, one item is one passage of passages.retriever_a shown with all statements of facts.model_a, so support is judged passage by passage. The labels under labels.retriever_a.model_a.passage_fact_support are keyed 'Passage {n}' and 'Fact {n}', which line up with passage_no and target_no, and their Yes/No values map to the two options. The subqueries field is a string in one record, but no path uses it."
}
```
