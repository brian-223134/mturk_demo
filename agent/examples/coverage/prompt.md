# Annotation goal

Check how completely an automatic answer covers a question (sub-question coverage). A question was split into sub-questions, and a system answered the whole question with a few short statements. For every sub-question we want a human to mark which statements help answer it, to say whether the statements answer it fully, and, when they do not, to write what is missing.

# Data

One record = one question.

- `question`: the original question.
- `subquestions`: the sub-questions, a map keyed "Sub-question 1", "Sub-question 2", ...
- `answer.system_a`: the statements of the answer we evaluate, a map keyed "Statement 1", "Statement 2", ...
- `labels.system_a.relevance["Sub-question N"].selected`: the existing label, a list of the statement keys that answer sub-question N (for example `["Statement 1", "Statement 3"]`; an empty list means no statement does).
- `labels.system_a.coverage["Sub-question N"]`: the existing label `Covered` or `Not covered`.

Other systems exist in the records but are not part of this task.

# Unit of annotation (one tab)

One tab shows the original question, one sub-question and all statements of `answer.system_a`. The worker answers three questions in the tab.

# Questions and options

1. "Which statements help answer the sub-question?" The worker ticks every statement that gives part or all of the answer, or a box "None of the statements helps answer it". Store `relevant` for a ticked statement and `not_relevant` otherwise.
2. "Taken together, do the statements fully answer the sub-question?" Options: **Fully answered** (value `covered`) / **Not fully answered** (value `not_covered`). Asked once per tab.
3. "What information is missing?" A short free-text answer of at least 10 characters, required only when the worker chose Not fully answered.

# HIT composition

- One HIT = the sub-questions of one record (grouped by record, at most 3 tabs) + 1 attention tab.
- Attention tab: keep the statements (at most 2), swap in the question and the sub-question of another record, so that no statement is relevant and the sub-question is not fully answered.

# Reference labels

Use the existing labels as the reference: a statement is `relevant` when its key is in the `selected` list of that sub-question, `not_relevant` otherwise; Covered → `covered`, Not covered → `not_covered`. There are no reasons to keep.

# Worker instructions (must cover)

- What "helps answer" means: the statement gives part or all of the answer; background that does not answer the sub-question does not count.
- Fully answered means every part of the sub-question is answered by the ticked statements.
- Judge whether the statements answer the sub-question, not whether they are true.
- When the answer is Not fully answered, describe the missing information in one sentence.

# Example of one tab

```
Original question: Why do leaves change colour in autumn, and why do some trees turn red?
Sub-question:      Why do some trees turn red instead of yellow?
Statement 1: "Shorter days and cooler nights make trees stop producing chlorophyll."            -> not ticked
Statement 2: "As the green chlorophyll breaks down, yellow and orange pigments ... become visible." -> not ticked
Statement 3: "Many trees drop their leaves to save water during winter."                        -> not ticked
Fully answered? Not fully answered. Missing: "Why some trees make red pigments in autumn."
```

# Deliverable

The answer is a task spec JSON as defined in the reference. Every string workers see must be English. `planner_notes` must explain the path choices in at most five sentences.
