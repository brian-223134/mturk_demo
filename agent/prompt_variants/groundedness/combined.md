# Annotation goal

Judge whether each short statement is supported by a retrieved passage (groundedness). A model answered a question with a few short statements, and a search system retrieved passages for the same question. For every passage we want a human judgement, statement by statement, of whether a careful reader of that passage alone would agree that the statement is true.

# Data

One record = one question.

- `question`: the question text.
- `passages.retriever_a`: the list of retrieved passages for the question, in rank order (8 per record).
- `facts.model_a`: the statements, a map keyed "Fact 1", "Fact 2", ...
- `labels.retriever_a.model_a.passage_fact_support["Passage N"]["Fact M"]`: the existing label for passage N and statement M, a pair `[Yes|No, reason]`.

Other retrievers, models and fields exist in the records but are not part of this task.

# Unit of annotation (one tab)

One tab shows the question, one passage and all statements of that record. The worker gives one answer per statement.

# Question and options

- Question: "Is this statement supported by the passage?"
- Options: **Supported** (value `grounded`) / **Not supported** (value `not_grounded`).

# HIT composition

- One HIT = the first 4 passages of one record (4 tabs), grouped by record, + 1 attention tab.
- Attention tab: keep the statements, swap in the question and the passage of another record, so that Not supported is the expected answer for every statement.

# Reference labels

Use the existing labels as the reference: Yes → `grounded`, No → `not_grounded`. Keep the reason as a second column.

# Worker instructions (must cover)

- The criteria for each option: Supported means everything in the statement can be confirmed from the passage; Not supported means the passage does not mention it, contradicts it, or confirms only part of it.
- Judge from the passage only; do not use outside knowledge.
- Paraphrase counts: the passage does not need to use the same words as the statement.
- A statement that is partly unsupported counts as Not supported.
- Answer every statement in every tab.

# Example of one tab

```
Question:    How do honeybees tell other bees where to find flowers?
Passage:     "Inside the dark hive, a returning forager runs in a short straight line while shaking her body, then loops back and repeats. ... The angle of that straight run, measured from vertical on the comb, matches the angle between the sun and the food, and the length of the run tells the distance to the flowers."
Statement 1: "Honeybees perform a waggle dance to share the location of food sources." -> Supported: the passage describes the dance and says it tells where the food is.
Statement 2: "The angle of the waggle run relative to vertical shows the direction of the food relative to the sun." -> Supported: the passage says the angle from vertical matches the angle between the sun and the food.
```

The same two statements shown with the first passage of that record (about the size of a colony and the jobs of workers) are both Not supported: that passage never mentions the dance.

# Deliverable

The answer is a task spec JSON as defined in the reference. Every string workers see must be English. `planner_notes` must explain the path choices in at most five sentences.

## Fixed comparison conditions (all candidates)

- Use all 6 input records in input order: `source.filter=null`, `source.sample=null`, `source.limit=null`; record ID is `$.id`.
- Use exactly the first 4 `passages.retriever_a` entries of every record. Keep all `facts.model_a` statements, in their original order, in every general tab. Do not invent, rewrite or deduplicate their text.
- `hit.group_by="record"`, `hit.items_per_hit=4`; one general item is one passage, not one statement. Expect 24 general items, 6 HITs and 48 general answers.
- Set attention to `per_hit=1`, `position="random"`, `seed=42`, `strategy="mismatch"`, `expected={"<id of the statement question>": "not_grounded"}`, `max_targets=2`. Swap both question and passage, using `mismatch.distance=3` and the corresponding context field names in `swap_fields`. Keep the source statements. Do not reveal attention positions or expected answers to workers. Expect 6 attention items and 10 attention answers, for 58 answers overall.
- Keep reference labels and reasons in the output columns `llm_label` and `llm_reason`; do not show these reference answers to workers. Do not relabel the data using your own judgement.
- Use the exact question and option labels/values requested above. All worker-facing text must be English. Keep these comparison conditions unchanged across prompt variants.

## Additional data mapping requirements

- The context fields are `question` from `$.question` and `passage` from the current `$.passages.retriever_a` element. The sole target field is `facts` from `$.facts.model_a[*]`. Other retrievers/models, answers and subqueries are excluded.
- Iterate the passage list once with variable `passage` and limit 4. For each general target, match the SAME record, passage and statement, not the first label or a label from another retriever/model.
- Use `$.labels.retriever_a.model_a.passage_fact_support['Passage {passage_no}']['Fact {target_no}'][0]` for the reference and the same path ending in `[1]` for its reason. These placeholders are one-based, matching the original keys.
- Map only `Yes` to `grounded` and `No` to `not_grounded`. Missing references must remain missing (`hint.missing=null`), never silently become Not supported. This fixture should have zero missing references and zero skipped empty items.
- Before returning the spec, check that all 6 records, all 24 general passages and all 48 general answers can be retained without sampling, filtering or extra limits. Keep reasoning about this check in `planner_notes`, not in worker instructions.

## Additional worker instruction requirements

Write concise, plain English into the supported `instructions` fields. Include the following four worked examples in the worker-visible criteria or notes; the planner-only example elsewhere is not a substitute. Use short strings, not a new unsupported spec field.

- Paraphrase: passage "The train departs at noon." / statement "The train leaves at 12 pm." → Supported; different words express the same fact.
- Partial support: passage "Mira won the race." / statement "Mira won the race and set a record." → Not supported; the record is not confirmed.
- Contradiction: passage "The museum closes on Mondays." / statement "The museum opens every Monday." → Not supported; the passage says the opposite.
- Missing information: passage "The lake is deep." / statement "The lake freezes in winter." → Not supported; depth does not establish winter freezing.

State that every part of a statement must be confirmed by this passage alone. Do not use outside knowledge or agreement with the question as evidence. Even if a passage looks unrelated, read it and apply the same rule; do not teach a shortcut based on topic mismatch. In the steps, ask workers to read the passage, answer each statement, move through every tab, and submit after all answers are complete. Do not identify which tabs are attention checks, give their expected answers, or expose internal paths, field/model names, or reference labels. Preserve the exact option labels throughout.
