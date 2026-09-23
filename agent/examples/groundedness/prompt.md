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
