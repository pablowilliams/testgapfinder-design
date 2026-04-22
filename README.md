# TestGapFinder — Coverage Gap Analyser

> Design project. A coverage-aware test-debt scorer that turns a Cobertura coverage report into a triage queue — ranked by uncovered-span size, path-based severity, and (in the full pipeline) git churn, cyclomatic complexity, and call-graph centrality.

TestGapFinder is a technical design specification. This repository contains:

1. **An 18-page design report** (`TestGapFinder_Design_Report.pdf`, built from `report.md`, `figures.py`, and `build_pdf.py`) that describes a seven-stage pipeline, a full signal catalogue, evaluation methodology, and a four-week roadmap.
2. **An interactive prototype** (`docs/`) that runs the coverage-only portion of the design entirely in the browser. Upload a `coverage.xml` file (or paste the XML), receive a grade, a ranked test-debt queue, and heuristic descriptions of the uncovered spans. Live at the GitHub Pages site linked in the repository sidebar.

The analyser consumes the Cobertura XML format emitted by [coverage.py](https://coverage.readthedocs.io) and [pytest-cov](https://pytest-cov.readthedocs.io). Nothing leaves the page — parsing and scoring are client-side.

## Why this exists

Line-coverage reports are usually dashboards, not triage queues. They show a headline percentage and a tree of files, but they don't tell the reviewer *where to write the next test*. The reviewer has to scroll the list, cross-reference the codebase, guess at severity, and then decide.

TestGapFinder is a design for the missing piece. It takes the coverage report as one of several signals, fuses it with repository-level evidence (churn, complexity, call-graph centrality), and emits a ranked list of files where a single new test would buy the most. The demo implements the coverage-signal half of that design; the report specifies the full pipeline and makes explicit which pieces are live and which are specification-only.

## The interactive demo

Open [docs/index.html](docs/index.html) locally, or visit the GitHub Pages site, and either:

- Choose a `coverage.xml` file with the file picker,
- Drop a `coverage.xml` anywhere on the upload area, or
- Expand "Paste XML instead" and paste a small example.

The analyser then:

- Parses the Cobertura XML with `DOMParser` and groups lines by filename.
- Computes, per file, the uncovered-line count, longest contiguous uncovered span, branch gap, and a path-based severity hint (paths matching `billing`, `payment`, `auth`, `security`, `crypto`, `token` rank higher; `util`, `logging`, `log`, `repr`, `format` rank lower).
- Combines those into a single test-debt score, then buckets each file as low / medium / high debt.
- Emits an overall A–F grade from the rolled-up line rate, capped at C if a high-debt file sits in a production-critical path.
- Renders a ranked `<ol>` of files with a `<meter optimum="0">` per item (inverted semantic: low debt = good), plus a heuristic-prose panel with a `<button>` copy-to-clipboard for each file's description.

The scoring is deterministic and documented in `docs/app.js`. The prose is templated from line ranges, not LLM-generated — this is called out in the UI.

A worked example to paste in:

```xml
<?xml version="1.0" ?>
<coverage line-rate="0.58" branch-rate="0.41" lines-covered="29" lines-valid="50" version="7.5.0" timestamp="1713830400000">
  <packages>
    <package name="src.billing" line-rate="0.37">
      <classes>
        <class name="invoice" filename="src/billing/invoice.py" line-rate="0.37">
          <lines>
            <line number="10" hits="2"/>
            <line number="11" hits="2"/>
            <line number="14" hits="0" branch="true" condition-coverage="50% (1/2)"/>
            <line number="15" hits="0"/>
            <line number="16" hits="0"/>
            <line number="17" hits="0"/>
            <line number="18" hits="0"/>
            <line number="19" hits="0"/>
            <line number="20" hits="0"/>
            <line number="21" hits="0"/>
            <line number="22" hits="0"/>
            <line number="30" hits="3"/>
            <line number="31" hits="3"/>
          </lines>
        </class>
      </classes>
    </package>
    <package name="src.utils" line-rate="0.86">
      <classes>
        <class name="dates" filename="src/utils/dates.py" line-rate="0.86">
          <lines>
            <line number="5" hits="4"/>
            <line number="6" hits="4"/>
            <line number="7" hits="4"/>
            <line number="8" hits="4"/>
            <line number="9" hits="4"/>
            <line number="10" hits="0"/>
            <line number="11" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
```

That input produces a C grade, ranks `src/billing/invoice.py` above `src/utils/dates.py` despite both having uncovered lines (the billing path carries a +20 severity bump; utils is docked by −4), and generates a heuristic bullet list that names the nine-line uncovered span in the billing file as the top-priority target.

## Accessibility

The prototype is built to WCAG 2.2 AA. Specifically:

- Semantic landmarks (`header`, `main`, `footer`), a skip link, and a single `h1`.
- Full keyboard operability: every interactive element is reachable by Tab and operable by Enter/Space. `Cmd/Ctrl+Enter` in the paste-XML textarea runs analysis. The file picker is a real `<input type="file">` wrapped in a visible `<label>`, not a JS-dispatched dialog.
- Drag-and-drop overlays the file-picker label. The drop-target state is signalled with a **3 px solid outline** and a background tint — not colour alone — so it survives `forced-colors: active`.
- Debt severity is encoded redundantly: a label (Low / Medium / High), a colour, a border style (solid / dashed / double), and a `<meter>` value.
- `<meter optimum="0">` is used for the debt score so assistive tech reads it correctly — low debt is good, high debt is bad.
- A single `aria-live="polite"` region announces analysis completion, copy confirmations, and error states. Every copy-to-clipboard button has a unique `aria-label` that names the file it describes.
- The empty state is a rendered panel with its own verbatim sentence, not a missing list.
- `prefers-reduced-motion` disables the score-ring transition. `prefers-color-scheme` is respected, with a manual override persisted via `localStorage`.
- The heuristic-prose panel carries a plain-language disclaimer that the text is template-generated, not LLM-authored.

The `<details>`/`<summary>` "Paste XML instead" block uses the browser's native keyboard behaviour. There is no custom disclosure JavaScript.

## Repository layout

| Path | Purpose |
|---|---|
| `report.md` | Source of the design report. Ten sections plus five appendices. |
| `figures.py` | Six vector figures (Platypus `Drawing` objects). |
| `build_pdf.py` | Renders `report.md` + `figures.py` into the final PDF with a bookmark outline. |
| `TestGapFinder_Design_Report.pdf` | Built artefact, committed for convenience and rebuilt in CI. |
| `docs/` | Interactive demo — static files, served via GitHub Pages. |
| `.github/workflows/build-pdf.yml` | Rebuilds the PDF on every change to the source, asserts a minimum page count, uploads as an artefact. |

## Building the PDF locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install reportlab==4.2.2 pypdf==4.3.1
python build_pdf.py
```

The output is `TestGapFinder_Design_Report.pdf` in the repository root, ~56 KB and 18 pages.

## Running the demo locally

The demo is a single HTML file with two siblings (`styles.css`, `app.js`) and no build step. Any static file server works:

```bash
cd docs
python -m http.server 8000
# visit http://localhost:8000
```

No network requests leave the page. Analysis runs entirely client-side.

## Scope and non-goals

- **Coverage.py / pytest-cov input only.** The Cobertura schema is used because it is the common denominator — JaCoCo XML and lcov look broadly similar but are not tested in the demo.
- **Python-first.** The path-based severity hints assume Python module naming. The report discusses extending to JavaScript, TypeScript, and Go.
- **The full pipeline is not in the demo.** Churn, cyclomatic complexity, and call-graph centrality each require the source tree and a static analyser. The demo runs on a single uploaded XML file.
- **Not a replacement for coverage.py, pytest-cov, or a human reviewer.** The grade is a triage signal, not a ship/no-ship gate.
- **The LLM reasoner described in Section 2.6 of the report is not in the browser demo.** The prose panel uses deterministic templates, which is a strict subset of what the full system specifies.

## Citations and prior art

The signal catalogue and methodology draw on:

- [coverage.py](https://coverage.readthedocs.io) by Ned Batchelder — the canonical Python coverage tool. Cobertura XML is its default machine-readable format.
- [pytest-cov](https://pytest-cov.readthedocs.io) — the pytest plugin wrapper around coverage.py.
- [Cobertura](https://cobertura.github.io/cobertura/) — the original Java coverage tool whose XML schema is now a lingua franca.
- [PyDriller](https://github.com/ishepard/pydriller) — library for mining git history (churn signal in the full pipeline).
- [radon](https://github.com/rubik/radon), [mccabe](https://github.com/PyCQA/mccabe) — cyclomatic-complexity tools referenced in the complexity signal.
- T. J. McCabe, "A Complexity Measure" (IEEE TSE, 1976) — the original cyclomatic-complexity paper.
- N. Nagappan, T. Ball, "Use of Relative Code Churn Measures to Predict System Defect Density" (ICSE, 2005) — empirical basis for the churn signal.
- G. Rothermel, M. J. Harrold, "Analyzing Regression Test Selection Techniques" (IEEE TSE, 1996) — prior art on selecting tests by impacted code.

Other tools referenced in the design but not in the demo:

- [Codecov](https://about.codecov.io), [SonarQube](https://www.sonarsource.com/products/sonarqube/), [Coverage Gutters](https://marketplace.visualstudio.com/items?itemName=ryanluker.vscode-coverage-gutters) — coverage dashboards and IDE overlays.
- [mutmut](https://mutmut.readthedocs.io), [cosmic-ray](https://cosmic-ray.readthedocs.io) — mutation testers whose survivor-set complements coverage but is out of scope for this demo.

## License

This is a design project. All original text and code in this repository are released under the MIT license. The cited external tools retain their own licenses.
