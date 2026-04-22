# TestGapFinder: A Coverage-Aware Test Gap Reviewer

## Abstract

Unit-test coverage reports tell engineers which lines are not executed by any test. They do not tell engineers which *uncovered* lines are the most important to cover next. A 40% coverage gap in a cold configuration module and a 40% coverage gap in the billing engine are presented identically by every mainstream coverage tool, even though the business cost of a bug in the second is orders of magnitude larger. TestGapFinder is a specification for a coverage-aware test gap reviewer that fuses static coverage signal, git history churn, cyclomatic complexity, and call-graph centrality into a per-function "test debt" score, then uses a small language-model reasoning pass to describe *what properties tests should cover* for each prioritised gap. The system is deterministic where determinism is cheap — coverage parsing, churn calculation, AST traversal — and reserves the language model for prose generation where a human would otherwise have to write the same prose themselves. The pipeline runs in a GitHub Action on every pull request, produces a ranked gap list, and optionally emits a stub test file per high-priority gap that the engineer is expected to complete. This report specifies the architecture, the signal catalogue, the evaluation methodology, and a four-week roadmap to a minimum viable system.

## 1. Introduction

### 1.1 Problem statement

Coverage tools report unexecuted lines, branches, and sometimes decisions. They are the lingua franca of test completeness — they ship in `coverage.py`, `pytest-cov`, `JaCoCo`, `Istanbul`, and every other mainstream framework. They are also famously noisy: a 95% coverage target is a false summit for many projects, producing high-ceremony tests for trivial getters while leaving load-bearing branches untested. The uncovered-lines signal is a necessary condition for identifying test debt, but it is not sufficient; the reviewer still has to decide *which* uncovered lines matter.

In practice, that decision is made by whoever writes the tests, during the same pull request that introduces the change. The engineer is already making hundreds of small choices about tests during a PR; adding "which parts of this module deserve coverage" to the list is an ambient tax. Teams that take coverage seriously bolt on process — coverage deltas, coverage gates, required-file lists — but none of these address the ranking problem. A coverage gate that requires 85% line coverage on touched files will be satisfied by a test that exercises the logging path of an error handler as reliably as by a test that exercises the retry policy of the payment processor. The gate fires either way.

TestGapFinder reframes the question. Instead of asking "is the coverage above a threshold?", it asks "of all the uncovered code, which uncovered code matters most right now?" The prioritisation is the product. A coverage report with a grade and a ranked list of twenty prose-described gaps is a more useful artefact than a coverage report with a bar chart and a red threshold.

### 1.2 Motivation

Three observations motivate the design.

First, **coverage alone is not priority**. Line coverage is a proxy for "has any test touched this code?" — it says nothing about the blast radius of a defect in that code, nor about the rate at which the code changes. A module that is uncovered and unchanged for two years is a different kind of debt than a module that is uncovered and modified last week.

Second, **every signal that would improve the priority ordering already exists, in isolation**. Git knows which files change. Static analysis knows which functions are hot — a leaf utility called from ten sites, or a root orchestrator called from one. Complexity metrics like cyclomatic complexity (McCabe, 1976) estimate the number of linearly independent paths a function has. These are three decades of published tooling. They are not fused.

Third, **the LLM cost/benefit is inverted for prose description, compared to code generation**. Generating a unit test from a function specification requires solving the same reasoning problem as generating production code; the model must reason about the function's contract, its preconditions, its error modes. That is hard and expensive. Describing the properties a test ought to cover — *"this function returns None when the input list is empty and raises on the typed error path at line 42"* — is a reading-comprehension task. The model is reading the function's source, not reasoning about its semantics from scratch. A small model does well at that. Describing is cheaper than generating.

TestGapFinder is the shape of a tool that takes those three observations seriously.

### 1.3 Research questions

The design is intended to answer four questions:

1. **Signal fusion.** Given coverage data, git churn, complexity, and call-graph centrality, can a learned-weight fusion produce a ranking that correlates better with reviewer judgement than any single signal?
2. **Property description quality.** Can a small language model, given a function's source and its coverage gaps, produce prose descriptions of missing test properties that an engineer rates as useful more than half the time?
3. **Calibration.** Does the grade produced for a module generalise across languages or is the ranking fundamentally Python-specific?
4. **Deterministic verification.** Can the pipeline be made reproducible end-to-end on a fixed input, with the language-model output the only non-deterministic step and that step seeded?

### 1.4 Scope

The specified system reviews a Python codebase with coverage data produced by `coverage.py` or `pytest-cov`, under a Git repository with accessible history. The initial implementation targets repositories where `pyproject.toml` is present and tests are invoked with `pytest`. JavaScript and Java are roadmap items, explicitly called out in section 7.

TestGapFinder does not execute tests. It consumes the artefacts tests produce (`coverage.xml`, `.coverage` binary data, or JSON export). It does not mutate the repository in interactive mode; the optional stub-generation feature writes files in a separate phase that the engineer opts into.

## 2. Background and Related Work

### 2.1 Coverage tooling

The canonical coverage library for Python is `coverage.py` by Ned Batchelder, which underpins `pytest-cov` and is the de facto standard for Python coverage. It emits data in three formats: a proprietary `.coverage` SQLite-backed binary file, an XML file in Cobertura's format, and a JSON export. TestGapFinder consumes the XML export because it is the most portable and the easiest to parse without a Python import dependency on `coverage.py` itself. The Cobertura schema is well-documented and stable; it records line-level hit counts per file, and branch hit counts when branch coverage is enabled.

The tooling is excellent at what it does. It is also famously unopinionated. It will happily report 100% line coverage on a module whose tests never exercise the error path, because the error path is guarded by an `if not x:` that the tests happen to always enter with a truthy `x`. Branch coverage mitigates this but does not eliminate it. Mutation testing — flipping operators and checking whether any test fails — is a stronger signal but is far too expensive for routine use; `mutmut` and `cosmic-ray` are the Python options and neither is cheap.

TestGapFinder is not a replacement for mutation testing. It is a prioritisation layer on top of line and branch coverage: deciding where to invest the next hour of testing work, rather than telling you whether your existing tests are good.

### 2.2 Git churn analysis

Churn — the frequency with which a file changes — is a widely-observed correlate of defect density (Nagappan and Ball, 2005, among many others). Extracting churn from a Git repository is a solved problem. The `git log --name-only` output is enough to compute it, but for a richer signal TestGapFinder uses PyDriller, a maintained Python library that wraps libgit2 bindings and provides per-commit, per-file deltas with author attribution, timestamp, and file-move tracking.

Churn by itself is noisy — mechanical refactors (rename, import reorder, formatter runs) inflate the signal. The ingester filters commits with messages that match known refactor patterns and, where possible, filters commits whose diff is entirely whitespace-or-import. The remaining signal is "how often has someone touched this file for a reason?" and correlates with where bugs are likely to appear.

### 2.3 Complexity metrics

Cyclomatic complexity (McCabe, 1976) is the oldest and most widely-implemented function-level complexity metric. Python has two mature implementations: `mccabe`, shipped alongside `flake8`, and `radon`, which computes cyclomatic complexity, Halstead metrics, and a "maintainability index" derived from both. TestGapFinder uses `radon` because it also parses a file's AST in a way that matches `ast.parse` and is cheap to integrate alongside the call-graph stage.

High complexity is a weak predictor of bugs in isolation but a strong predictor in combination with poor coverage. A 30-line function with cyclomatic complexity 12 that is covered at 100% is likely well-tested; the same function at 50% coverage is likely under-tested, and the specific uncovered branches are the ones that matter.

### 2.4 Call-graph centrality

"How important is this function?" is not answerable from the function itself. A short helper with no branches might be called from three hundred sites; a long function with many branches might be called from one. TestGapFinder uses Python's `ast` module to build a static call graph — each function node is a vertex, each `Call` node whose target resolves to a known function creates a directed edge. The graph is intentionally static; it does not resolve dynamic dispatch or attribute lookups through alias chains. A function's centrality is its in-degree (number of callers) times the log of the sum of call-sites' centralities, capped to avoid exploding transitive weights. This is a simplified PageRank: cheap, deterministic, and good enough to distinguish "called once, from tests only" from "called everywhere".

### 2.5 ML for test generation

Recent work on LLM-based test generation includes TestPilot (Meta, 2023) and CodeT (Microsoft, 2022), both of which generate test code from function signatures and documentation. TestGapFinder deliberately does *not* generate executable tests in the main pipeline. The rationale is evaluation: executable test generation has to be verified by running the tests, which closes a loop that is intrinsically flaky. Property descriptions — prose that says "a test is missing for the case where the list is empty" — are easier to evaluate against reviewer judgement, easier to make deterministic with a seeded small model, and more honest about the system's capabilities. The optional stub-generation feature is gated behind an explicit opt-in and is framed as a starting point for the engineer, not a finished test.

### 2.6 The gap this system targets

The three signals — coverage, churn, and complexity — are produced by mature tooling and are widely used in isolation. The fusion into a single prioritisation metric, combined with prose-descriptive gap annotations, is not a commercially available product as of this writing. The closest analogues are Codecov's "impact" label, which surfaces coverage delta per PR, and SonarQube's "new code" filter, which focuses attention on recently-changed files. Neither combines the four signals TestGapFinder combines, and neither produces prose descriptions of what a test should cover.

### 2.7 Commercial and academic landscape

Several adjacent tools are worth naming explicitly so the scope is clear.

- **Codecov** provides PR-level coverage diffs and "impact analysis" — a view that surfaces which lines are covered *by tests that the current PR adds*. It operates at file granularity and does not consider churn or complexity.
- **SonarQube** provides a "new code" filter that isolates findings to recently-touched lines and surfaces coverage against them. It does not produce prose descriptions of missing properties.
- **Coverage Gutters** and similar IDE plugins surface coverage inline in the editor. These are individual-developer tools and do not perform prioritisation.
- **Mutation testing** (mutmut, cosmic-ray for Python; Stryker for JavaScript; PIT for Java) is a stronger correctness signal, but its cost is quadratic in test count and it is not used in routine CI for most teams.
- **Published research** on test prioritisation includes work on history-based prioritisation (Rothermel et al.) and defect-based prioritisation (Nagappan and Ball). These inform TestGapFinder's churn signal but do not directly overlap.

TestGapFinder is the intersection of prioritisation research and LLM-assisted prose description, shipped as a pull-request-native tool.

## 3. System Architecture

### 3.1 Design principles

Six principles shape the design.

1. **Deterministic where cheap.** Coverage parsing, churn extraction, complexity measurement, and call-graph construction are deterministic. They are the backbone of the pipeline; the LLM is a small prose layer on top.
2. **Seeded otherwise.** The LLM reasoner runs with a fixed seed. Any output drift between two runs on the same input is treated as a defect.
3. **No code execution.** The pipeline does not run the tests. It consumes the artefacts produced by someone else running them. This keeps the system safe to run on a CI worker without elevated privileges.
4. **Artefact-first.** Every stage produces a typed Pydantic contract that is written to disk and consumed by the next stage. A developer can pause the pipeline after any stage and inspect the intermediate result.
5. **Small LM preferred.** The prose-generation stage is intended to run a 7B-class model. The prompt templates are written to avoid multi-step reasoning so a smaller model suffices.
6. **CI-first.** The pipeline runs as a GitHub Action. The primary output is a PR comment with a grade, a ranked gap list, and a link to the full artefact. Everything else — the dashboard, the stub generator — is secondary.

### 3.2 Pipeline overview

[FIGURE:pipeline]

The pipeline has seven stages. Each stage reads a typed input and writes a typed output; all serialisation is JSON with Pydantic schemas.

1. **Ingestion.** Accepts a repository path and a path to a coverage artefact. Parses the coverage artefact (Cobertura XML, JSON export, or `.coverage` SQLite). Emits a `CoverageReport` with per-file and per-line data.
2. **Static analyser.** Walks the repository, parses every `.py` file with `ast.parse`, computes per-function cyclomatic complexity via `radon`, and records function spans (`lineno`, `end_lineno`). Emits a `FunctionInventory`.
3. **Churn gatherer.** Uses PyDriller to traverse commits touching files in scope, builds a per-function churn estimate by intersecting commit diff hunks with function spans. Emits a `ChurnReport`.
4. **Call-graph builder.** Builds a static call graph from the inventory. Emits a `CallGraph` with per-function centrality.
5. **Signal fusion.** Combines coverage, churn, complexity, and centrality into a per-function `TestDebtScore`. The fusion is a weighted sum with weights set by a tuning study; the weights are versioned with the pipeline.
6. **LLM reasoner.** For each function in the top-N of the scored list, the reasoner reads the function's source plus the uncovered-line ranges and emits a prose `PropertyDescription` — one to three bullet points in English describing what a test ought to cover.
7. **Reporting.** Renders a Markdown PR comment, a JSON artefact, and an optional per-function stub test file.

### 3.3 Data flow

The seven stages pass typed contracts through a stable set of names:

- `CoverageReport` — per-file and per-line hit counts.
- `FunctionInventory` — every function in the repository with its span, complexity, and parameter list.
- `ChurnReport` — per-function commit count over a configurable window (default: last 180 days).
- `CallGraph` — directed graph, per-function in-degree and centrality.
- `TestDebtScore` — per-function score with component breakdown.
- `PropertyDescription` — prose description of missing test properties.
- `Report` — the final artefact: grade, ranked gap list, optional stub file paths.

Every contract is defined in `src/testgapfinder/contracts/` as a Pydantic model. Appendix B contains the full schema definitions.

## 4. Component Specifications

### 4.1 Ingestion

The ingester accepts three coverage formats because real projects emit all three:

- **Cobertura XML** — the output of `coverage xml` or `pytest-cov --cov-report=xml`. This is the canonical cross-language format and the primary supported input.
- **coverage.py JSON** — the output of `coverage json`, a newer and less-widely-adopted format.
- **`.coverage` SQLite** — the raw database file. Parsing this requires `coverage.py` itself as a dependency, so it is opt-in.

The ingester normalises all three into `CoverageReport`. File paths are normalised to repo-relative paths; line hits are integer counts (0 = uncovered, >0 = covered). Branch coverage is captured if present, but the default pipeline uses line coverage because branch coverage is less frequently enabled.

### 4.2 Static analyser

The analyser walks the repository with `ast.parse` and collects every function and method. For each node, it records:

- Fully-qualified name (`package.module.ClassName.method`).
- Source span (`lineno`, `end_lineno`).
- Parameter list and return annotation if present.
- Cyclomatic complexity (via `radon.complexity.cc_visit`).
- Whether the function is a test (matched against the configured test-discovery pattern — default `test_*` and `*_test.py`).

Tests are excluded from the inventory before scoring. A test file can still have uncovered lines (a `if __name__ == "__main__":` block, for example), but the output is never a ranked list of uncovered test lines.

### 4.3 Churn gatherer

PyDriller reads commits in the window (default: 180 days). For each commit, the gatherer extracts per-file diffs and maps added-or-removed lines to function spans from the inventory. A function's churn score is the count of commits that touched at least one of its lines, weighted by recency using a one-year exponential decay.

Recency decay matters: a function that was rewritten six months ago and has been stable since is a different kind of risk than a function that is actively changing. The decay is tuneable and versioned.

Mechanical-refactor filtering runs as a preprocessing step. Commits whose messages match one of a small set of known refactor patterns (`chore: format`, `style:`, `refactor: rename`, etc.) are down-weighted by 0.5. Commits whose diffs are entirely import reorderings or whitespace changes are filtered entirely.

### 4.4 Call-graph builder

The builder walks every function in the inventory and, for each `Call` node, attempts to resolve the callee to an inventory entry. Resolution is static and deliberately conservative: it resolves direct name references, attribute accesses on `self` within a class body, and top-level import references within the same package. It does not resolve callables passed as arguments, attribute accesses on arbitrary expressions, or `getattr`-style dynamic dispatch. Unresolved callees are discarded.

Each function has two centrality measures:

- **In-degree** — number of distinct callers. Raw count.
- **Weighted centrality** — a simplified PageRank iteration, initialised at 1.0 per node and run for ten iterations with damping 0.85.

The weighted centrality is the score used downstream. In-degree is reported alongside for reviewer intuition.

### 4.5 Signal fusion

The fusion stage combines four signals per function into a single `TestDebtScore`:

- **Coverage gap** — the count of uncovered lines in the function, normalised by function length.
- **Churn** — the recency-weighted commit count in the window.
- **Complexity** — the cyclomatic complexity from `radon`.
- **Centrality** — the weighted centrality from the call graph.

Each signal is min-max normalised across the repository so that the per-function score lives in `[0, 1]`. The fused score is a weighted sum:

[FIGURE:signal_fusion]

```
score = w_gap · gap + w_churn · churn + w_complex · complex + w_central · central
```

The weights are not learned from scratch. They are set from a small tuning study on an open-source corpus (see section 6.1) with reviewer-provided ground truth rankings. The study yields weights that are then hard-coded in the pipeline and re-tuned on a yearly cadence. This matches the SchemaShift pattern: the rule catalogue and weights are part of the pipeline's versioned behaviour, not a live-learning system.

### 4.6 LLM reasoner

The reasoner is a per-function prompt. For each of the top-N scored functions (default N = 20), it constructs a prompt with:

- The function's source, line-numbered.
- The list of uncovered line numbers and line ranges.
- The function's signature and docstring if present.
- The complexity breakdown (how many branches, how many exception handlers, how many external calls).

The model is asked to respond with one to three bullet points in plain English, each describing a property the tests are missing. The prompt explicitly forbids writing code; it is a reading-comprehension task, not a code-generation task. A small 7B-class model is sufficient for this format.

The reasoner is seeded. Any non-determinism observed between runs on the same input is a defect. A regression gate in CI runs the reasoner twice on a fixed snapshot and fails if the outputs differ.

### 4.7 Reporting

The reporter emits three artefacts:

- **PR comment** — Markdown, posted by a bot comment. Grade, top-five findings with prose descriptions, link to the full artefact.
- **JSON artefact** — the full `Report` object, uploaded as a workflow artefact for programmatic consumption.
- **Optional stub files** — one file per top-N function, in a configurable path (default: `tests/gaps/test_<module>_gaps.py`). The stub contains a class with empty test methods, one per described property, and a docstring naming the property. The engineer completes the tests.

[FIGURE:stub_flow]

## 5. Dashboard Design

The dashboard is a static site — the same build pattern as SchemaShift — that consumes the JSON artefact and renders:

- **Overview.** Repository grade, gap count, trend line over recent runs.
- **Gap list.** One row per function with a test-debt score, sortable by score, churn, complexity, and centrality.
- **Function detail.** A full function source listing with uncovered lines highlighted and the prose property descriptions beneath.
- **History.** Every past run filterable by grade, author of the commit that introduced the gap, and the age of the gap.

Accessibility is WCAG 2.2 AA. Colour is paired with icon shape for severity (a convention also used in SchemaShift). The interactive demo shipped with this repo is a reduced version — a paste-your-coverage-xml form that produces the gap list in-browser with heuristic weights, without the LLM stage.

[FIGURE:dashboard]

## 6. Evaluation Methodology

### 6.1 Datasets

Three datasets are defined:

**Synthetic micro-benchmarks.** A controlled repo with hand-crafted functions at known complexities and known coverage gaps. The expected ranking is hand-labelled. Every CI run regresses against it.

**Open-source corpus.** Ten medium-sized open-source Python projects (1k–50k LoC) selected for having active coverage and sustained commit history. For each project, three senior engineers produce a ranked list of the ten modules most in need of additional tests, blind to each other's rankings and to TestGapFinder's output. The system's ranking is compared against the consensus ranking via Kendall's tau.

**Internal dogfood.** The pipeline is run on the TestGapFinder repository itself every time it is modified. The grade is expected to improve monotonically over the build-out period; a regression in grade is a release gate.

### 6.2 Metrics

Three metrics are tracked:

- **Top-N agreement.** For top-N = 5, 10, 20: the intersection of TestGapFinder's top-N and the reviewer consensus top-N, as a fraction of N. Baseline is uniform random sampling.
- **Property-description utility.** For each generated prose description, a reviewer rates it on a three-point scale (useful / partly useful / noise). The metric is the fraction rated useful or partly useful.
- **Stability.** Two consecutive runs on the same input produce identical rankings and byte-identical prose descriptions. Failure is a defect.

### 6.3 Regression gates

CI enforces three gates:

- **Determinism.** The reasoner is run twice on a fixed snapshot; outputs must match byte-for-byte.
- **Synthetic ranking.** The hand-labelled synthetic dataset's top-10 agreement must be >= 0.8.
- **Performance budget.** The pipeline must complete in under 60 seconds on a 10,000-LoC repository with 500 functions. Exceeding the budget is a defect.

## 7. Implementation Roadmap

The minimum viable system is four weeks of single-engineer work. The path is structured to produce a shippable pipeline each week.

**Week 1 — Ingestion and static analysis.** Cobertura parser, function inventory with complexity, and the `FunctionInventory`/`CoverageReport` contracts. By end of week, a command-line invocation produces those two JSON artefacts for any Python repo.

**Week 2 — Churn and call graph.** PyDriller integration with recency decay. AST-based call graph with the simplified PageRank. By end of week, the per-function `TestDebtScore` is produced from the four signals with weights set from the synthetic dataset.

**Week 3 — LLM reasoner and reporting.** Prompt templates, seeded 7B model integration, PR comment renderer. By end of week, the pipeline posts a ranked gap list on a sample PR.

**Week 4 — Dashboard and CI polish.** Static dashboard shipped as a GitHub Pages site. CI regression gates. Documentation. Release v0.1.

[FIGURE:roadmap]

## 8. Risk Analysis

**Call-graph incompleteness.** A static call graph misses dynamic dispatch, metaclass wizardry, decorator-wrapped callers, and the entire Python plugin ecosystem. Centrality based on the static graph is a lower bound. Mitigation: the fusion weights are set so that centrality never dominates the score, and the dashboard explains that centrality is a static measure.

**Churn signal noise.** Large refactors produce commit clusters that do not correspond to bug-prone code. The refactor-pattern filter is heuristic and will miss cases. Mitigation: the dashboard shows the churn breakdown alongside the aggregate score, so the reviewer can dismiss spurious high-churn-low-bug-density items.

**LLM drift.** The seeded reasoner is expected to be deterministic, but model providers sometimes silently change their backends, producing drift. Mitigation: the CI determinism gate catches this within a day, and the pipeline pins to a specific model version and seed.

**Weights staleness.** The fusion weights were tuned on a corpus; they decay as the corpus becomes unrepresentative. Mitigation: the tuning study is re-run annually and the weights versioned in a config file.

**Language coverage.** The initial release is Python-only. The Cobertura format is shared with Java's JaCoCo, so a Java port is conceptually straightforward; JavaScript's Istanbul format is similar. The AST-based analyser is not transferable and would need to be rewritten per language.

**Stub generation misleading.** Auto-generated stub tests can create the appearance of coverage without its substance. Mitigation: the stub files are marked with a comment header explaining that the functions are placeholders, and the test names include the word "gap" to avoid confusion with real tests.

## 9. Ethical Considerations

Two concerns shape the design.

**Blame avoidance.** The dashboard exposes per-function churn, which is derived from `git log` and trivially maps to authors. The system deliberately does not attribute findings to authors. A test gap is a property of the code, not of its last committer. Author data is used only for recency-decay weighting in churn and is not surfaced in any reviewer-facing artefact.

**Coverage theatre.** A prioritisation tool can be weaponised to demand tests for a specific ranked list, producing tests-for-tests'-sake. The reporting copy is written to emphasise that the grade is a starting point for judgement, not a target. The optional stub generator is gated behind an opt-in.

## 10. Conclusion

TestGapFinder turns the coverage report from a progress bar into a triage queue. It does so by combining four mature signals — coverage, churn, complexity, and centrality — with a small prose-generation layer that describes the missing properties in English. The pipeline is specified end-to-end, the evaluation methodology is defined, and the four-week roadmap is specific enough to execute. No stage depends on unresolved research; every component has a precedent in the open-source ecosystem or in published literature.

The question the tool is designed to answer — *"of all the uncovered code, which uncovered code matters most right now?"* — is the question test-conscious engineers already answer implicitly, one PR at a time. TestGapFinder makes the answer explicit, ranked, and reviewable.

## Appendix A — Signal Catalogue

### COVERAGE
- **CG-001.** Uncovered line count (absolute).
- **CG-002.** Uncovered line count normalised by function length.
- **CG-003.** Uncovered branch count (when branch coverage is enabled).
- **CG-004.** Longest contiguous uncovered span.

### CHURN
- **CH-001.** Commit count over the window.
- **CH-002.** Recency-weighted commit count with exponential decay.
- **CH-003.** Distinct author count over the window.
- **CH-004.** Fraction of commits flagged as mechanical refactor (down-weight signal).

### COMPLEXITY
- **CX-001.** Cyclomatic complexity (McCabe, via `radon`).
- **CX-002.** Number of exception handlers.
- **CX-003.** Number of external calls (calls to functions outside the repo).
- **CX-004.** Halstead effort (optional, second-order signal).

### CENTRALITY
- **CE-001.** In-degree (number of static callers).
- **CE-002.** Weighted centrality (simplified PageRank, damping 0.85, 10 iterations).
- **CE-003.** Depth from entry point (if an entry point is declared).

### TEST-DEBT AGGREGATES
- **TD-001.** Fused test-debt score (weighted sum, normalised to [0, 1]).
- **TD-002.** Grade (A/B/C/D/F) per module, derived from the highest per-function score and the gap count.

## Appendix B — Data Contracts

All contracts are Pydantic models in `src/testgapfinder/contracts/`. The following are the core types, abbreviated to the signature-level:

```python
class FileCoverage(BaseModel):
    path: str
    line_hits: dict[int, int]
    branch_hits: dict[int, tuple[int, int]] | None
    total_lines: int
    covered_lines: int

class CoverageReport(BaseModel):
    source: Literal["cobertura", "coverage-json", "coverage-sqlite"]
    files: list[FileCoverage]
    overall_line_rate: float

class Function(BaseModel):
    qualified_name: str
    file: str
    lineno: int
    end_lineno: int
    parameters: list[str]
    return_annotation: str | None
    cyclomatic_complexity: int
    is_test: bool

class FunctionInventory(BaseModel):
    functions: list[Function]

class ChurnEntry(BaseModel):
    qualified_name: str
    commits: int
    recency_weighted: float
    distinct_authors: int

class ChurnReport(BaseModel):
    window_days: int
    entries: list[ChurnEntry]

class CallEdge(BaseModel):
    caller: str
    callee: str

class CallGraph(BaseModel):
    edges: list[CallEdge]
    in_degree: dict[str, int]
    centrality: dict[str, float]

class TestDebtScore(BaseModel):
    qualified_name: str
    score: float
    components: dict[str, float]  # gap, churn, complex, central

class PropertyDescription(BaseModel):
    qualified_name: str
    bullets: list[str]
    uncovered_spans: list[tuple[int, int]]

class Report(BaseModel):
    grade: Literal["A", "B", "C", "D", "F"]
    summary: str
    top_findings: list[tuple[TestDebtScore, PropertyDescription]]
    generated_at: datetime
```

## Appendix C — Deployment

The reference deployment is a GitHub Action that installs the tool from PyPI, runs the pipeline against the PR branch, and posts a comment with the grade and the top-five findings. A Docker image is published for self-hosted runners. The dashboard is a static site deployed to GitHub Pages from the `docs/` path of the repository.

## Appendix D — Engineering Conventions

All Python code is formatted with `ruff format` (the successor to `black`). Lint enforced with `ruff check` on the default rule set plus `PERF`, `SIM`, and `UP`. Types checked with `pyright` in strict mode. Tests run with `pytest` and coverage with `pytest-cov`. Every release is tagged with a semver tag and an associated GitHub release note generated from the commit log.

## Appendix E — Glossary

- **Churn.** The frequency with which a file or function has been modified, weighted by recency.
- **Centrality.** A graph-theoretic measure of how important a node is in a graph; here, a static call graph.
- **Cyclomatic complexity.** The number of linearly independent paths through a function's control-flow graph.
- **Test debt.** The accumulated cost of inadequate testing — functions that are important, complex, or actively changing but not well-covered.
- **Property description.** A prose statement of what a test ought to cover, in English, rather than a generated test body.
- **Gap.** An uncovered line, branch, or range that is a candidate for new test coverage.
