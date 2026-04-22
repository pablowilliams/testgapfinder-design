/* =========================================================================
 * TestGapFinder — Coverage Gap Analyser
 * Client-side Cobertura parser + test-debt scorer. Runs entirely in the
 * browser. No network. Nothing leaves this page.
 *
 * Scope — this demo
 *   The full design described in TestGapFinder_Design_Report.pdf fuses four
 *   signals: coverage gap, git churn, cyclomatic complexity, and call-graph
 *   centrality. This demo uses the coverage.xml only. The other three signals
 *   require the repository itself (for churn) and a static analyser (for
 *   complexity and call-graph); neither is available from a Cobertura file.
 *
 *   Rather than pretend to run those steps, the UI is explicit about it — the
 *   findings intro tells the user what is in scope, and the heuristic-prose
 *   panel carries a plain-language disclaimer.
 *
 * Grade mapping (overall line rate)
 *   >= 0.90 → A          >= 0.60 → C          <  0.40 → F
 *   >= 0.75 → B          >= 0.40 → D
 *
 *   Critical files drag the grade: if the top-debt file is bucket=high,
 *   an A or B is capped at C, matching the report's "a single production-
 *   critical untested region defeats headline coverage" rule.
 *
 * Per-file debt score
 *   debt = uncovered_lines
 *        + 0.5 * longest_uncovered_span
 *        + severity_multiplier
 *
 *   severity_multiplier is derived from the file's path:
 *     billing, payment, auth, security, crypto, token → +20
 *     api, handler, controller, route, service        → +10
 *     util, logging, log, repr, format                →  -4
 *   …capped so no single hint flips the sign.
 *
 *   The debt value is then bucketed for the visual badge:
 *     low     <  12
 *     medium  12 … 30
 *     high    >= 30
 *
 *   This thresholding is the same one the report shows in Appendix C.
 * ========================================================================= */

/* ----------------------------- DOM handles ------------------------------ */
const el = {
  fileInput: document.getElementById("coverage-file"),
  fileLabel: document.querySelector(".upload-file-label"),
  xmlInput: document.getElementById("xml-input"),
  analysePasteBtn: document.getElementById("analyse-paste-btn"),
  resetBtn: document.getElementById("reset-btn"),
  dropZone: document.getElementById("drop-zone"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),

  resultsSection: document.getElementById("results-section"),
  resultsH: document.getElementById("results-h"),
  scoreCard: document.getElementById("score-card"),
  scoreNumber: document.getElementById("score-number"),
  scoreTitle: document.getElementById("score-title"),
  scoreSummary: document.getElementById("score-summary"),
  scoreSr: document.getElementById("score-sr"),
  ringFg: document.getElementById("ring-fg"),
  gradeBadge: document.getElementById("grade-badge"),
  gradeLetter: document.getElementById("grade-letter"),
  gradeWord: document.getElementById("grade-word"),
  gradeGlyph: document.getElementById("grade-glyph-path"),

  findingsSection: document.getElementById("findings-section"),
  findingsList: document.getElementById("findings-list"),
  findingsEmpty: document.getElementById("findings-empty"),

  proseSection: document.getElementById("prose-section"),
  proseList: document.getElementById("prose-list"),

  themeToggle: document.getElementById("theme-toggle"),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 from SVG viewBox
const MAX_RANK = 25; // cap the ranked list so the page remains readable
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/* ------------------------------ Path hints ------------------------------ */
const SEVERITY_PATHS = [
  { re: /\b(billing|payment|auth|security|crypto|token|secret|password)\b/i, delta: 20 },
  { re: /\b(api|handler|controller|route|router|service|endpoint)\b/i, delta: 10 },
  { re: /\b(util|utils|logging|log|repr|format|helper|helpers)\b/i, delta: -4 },
];

function severityDeltaFor(path) {
  let total = 0;
  for (const s of SEVERITY_PATHS) if (s.re.test(path)) total += s.delta;
  // Don't let a single file be bumped by more than +30 or docked below -4.
  if (total > 30) total = 30;
  if (total < -4) total = -4;
  return total;
}

/* --------------------------- Cobertura parsing -------------------------- */
/* Cobertura XML shape (abbreviated):
 *
 *   <coverage line-rate="0.72" branch-rate="0.61" lines-covered="…"
 *             lines-valid="…" branches-covered="…" branches-valid="…"
 *             timestamp="…" version="…">
 *     <sources><source>.</source></sources>
 *     <packages>
 *       <package name="src.billing" line-rate="…">
 *         <classes>
 *           <class name="Invoice" filename="src/billing.py" line-rate="…">
 *             <methods>…</methods>
 *             <lines>
 *               <line number="14" hits="0" branch="false"/>
 *               <line number="15" hits="3"/>
 *               <line number="16" hits="0" branch="true"
 *                     condition-coverage="50% (1/2)"/>
 *             </lines>
 *           </class>
 *         </classes>
 *       </package>
 *     </packages>
 *   </coverage>
 *
 * coverage.py and pytest-cov emit this exact shape.
 */
function parseCobertura(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const perr = doc.querySelector("parsererror");
  if (perr) {
    const msg = perr.textContent.split("\n").slice(0, 2).join(" ").trim();
    throw new Error(`XML parse error: ${msg || "invalid document"}`);
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "coverage") {
    throw new Error(
      "Root element is not <coverage>. This does not look like Cobertura XML."
    );
  }

  const overall = {
    lineRate: parseFloat(root.getAttribute("line-rate") || "0") || 0,
    branchRate: parseFloat(root.getAttribute("branch-rate") || "0") || 0,
    linesCovered: parseInt(root.getAttribute("lines-covered") || "0", 10) || 0,
    linesValid: parseInt(root.getAttribute("lines-valid") || "0", 10) || 0,
    branchesCovered:
      parseInt(root.getAttribute("branches-covered") || "0", 10) || 0,
    branchesValid:
      parseInt(root.getAttribute("branches-valid") || "0", 10) || 0,
    timestamp: root.getAttribute("timestamp") || null,
    version: root.getAttribute("version") || null,
  };

  // Group by filename — one class per file in most coverage.py outputs,
  // but we merge defensively in case the report splits a file across classes.
  const filesByPath = new Map();
  const classes = doc.querySelectorAll("classes > class");
  classes.forEach((cls) => {
    const filename = cls.getAttribute("filename");
    if (!filename) return;
    const lineNodes = cls.querySelectorAll("lines > line");
    const lines = [];
    lineNodes.forEach((ln) => {
      const number = parseInt(ln.getAttribute("number") || "0", 10);
      if (!number) return;
      const hits = parseInt(ln.getAttribute("hits") || "0", 10) || 0;
      const isBranch =
        (ln.getAttribute("branch") || "").toLowerCase() === "true";
      const conditionCoverage = ln.getAttribute("condition-coverage") || null;
      lines.push({ number, hits, isBranch, conditionCoverage });
    });

    const existing = filesByPath.get(filename);
    if (existing) {
      existing.lines.push(...lines);
    } else {
      filesByPath.set(filename, { path: filename, lines });
    }
  });

  // Canonicalise: sort each file's lines by line number, dedup by number.
  const files = Array.from(filesByPath.values()).map((f) => {
    const seen = new Map();
    for (const ln of f.lines) {
      const prev = seen.get(ln.number);
      // Keep the node with the highest hits — some tools emit duplicates.
      if (!prev || ln.hits > prev.hits) seen.set(ln.number, ln);
    }
    const lines = Array.from(seen.values()).sort(
      (a, b) => a.number - b.number
    );
    return { path: f.path, lines };
  });

  if (files.length === 0) {
    throw new Error(
      "No <class> elements were found in this coverage file. Confirm it is Cobertura XML."
    );
  }

  return { overall, files };
}

/* -------------------------- Debt scoring + spans ------------------------ */
/* Contiguous uncovered spans — two lines are in the same span if their
 * line numbers differ by 1. Branch-only partials are included in the span
 * with an annotation, so the reader sees them in context. */
function uncoveredSpans(lines) {
  const spans = [];
  let cur = null;
  for (const ln of lines) {
    const isUncovered = ln.hits === 0;
    if (!isUncovered) {
      if (cur) {
        spans.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && ln.number === cur.end + 1) {
      cur.end = ln.number;
      cur.lineCount += 1;
      if (ln.isBranch) cur.branchCount += 1;
    } else {
      if (cur) spans.push(cur);
      cur = {
        start: ln.number,
        end: ln.number,
        lineCount: 1,
        branchCount: ln.isBranch ? 1 : 0,
      };
    }
  }
  if (cur) spans.push(cur);
  return spans;
}

function fileDebt(file) {
  const total = file.lines.length;
  const uncovered = file.lines.filter((l) => l.hits === 0).length;
  const covered = total - uncovered;
  const lineRate = total > 0 ? covered / total : 1;
  const spans = uncoveredSpans(file.lines);
  const longest = spans.reduce((m, s) => Math.max(m, s.lineCount), 0);
  const branchGap = file.lines.filter((l) => l.isBranch && l.hits === 0).length;
  const sev = severityDeltaFor(file.path);

  const rawDebt = uncovered + 0.5 * longest + sev;
  const debt = Math.max(0, Math.round(rawDebt));

  let bucket = "low";
  if (debt >= 30) bucket = "high";
  else if (debt >= 12) bucket = "medium";

  return {
    path: file.path,
    total,
    covered,
    uncovered,
    lineRate,
    spans,
    longest,
    branchGap,
    severityDelta: sev,
    debt,
    bucket,
  };
}

function analyse(xmlText) {
  const { overall, files } = parseCobertura(xmlText);

  const perFile = files.map(fileDebt);
  // Hide files with nothing to measure (no executable lines).
  const nonEmpty = perFile.filter((f) => f.total > 0);

  // Rank by debt score, then by uncovered count as a tiebreaker, then path.
  nonEmpty.sort((a, b) => {
    if (b.debt !== a.debt) return b.debt - a.debt;
    if (b.uncovered !== a.uncovered) return b.uncovered - a.uncovered;
    return a.path.localeCompare(b.path);
  });

  // A file only makes the ranked list if it has at least one uncovered line.
  const ranked = nonEmpty.filter((f) => f.uncovered > 0).slice(0, MAX_RANK);

  // Recompute overall line rate from the per-file data if the root attribute
  // is missing or plainly inconsistent.
  const rolledTotal = nonEmpty.reduce((a, f) => a + f.total, 0);
  const rolledCovered = nonEmpty.reduce((a, f) => a + f.covered, 0);
  const computedRate =
    rolledTotal > 0 ? rolledCovered / rolledTotal : overall.lineRate;

  const pct = Math.round(computedRate * 1000) / 10; // one decimal
  const percentWhole = Math.round(computedRate * 100);

  return {
    overall: {
      ...overall,
      lineRate: computedRate,
      percent: percentWhole,
      percentDisplay: pct,
    },
    files: nonEmpty,
    ranked,
    totals: {
      fileCount: nonEmpty.length,
      filesWithGaps: nonEmpty.filter((f) => f.uncovered > 0).length,
      totalLines: rolledTotal,
      coveredLines: rolledCovered,
      uncoveredLines: rolledTotal - rolledCovered,
    },
  };
}

/* ------------------------------ Grading --------------------------------- */
function gradeFor(percent, ranked) {
  let g;
  if (percent >= 90) g = "A";
  else if (percent >= 75) g = "B";
  else if (percent >= 60) g = "C";
  else if (percent >= 40) g = "D";
  else g = "F";
  // A single high-debt file caps the grade at C.
  const hasHighDebt = ranked.some((r) => r.bucket === "high");
  if (hasHighDebt && (g === "A" || g === "B")) g = "C";
  return g;
}

const GRADE_META = {
  A: {
    word: "Strong coverage",
    title: "Coverage looks healthy",
    summary:
      "The coverage report shows a high line rate and no production-critical files in the top-debt bucket. Review any medium-debt items below, but this tree is in good shape.",
    glyph: "M6 12l4 4 8-8",
  },
  B: {
    word: "Minor gaps",
    title: "A few files to triage",
    summary:
      "Coverage is generally good, with some medium-debt files. Work through the ranked list below in order — the top items are where the next test would buy you the most.",
    glyph: "M6 12l4 4 8-8",
  },
  C: {
    word: "Review required",
    title: "Several files with meaningful gaps",
    summary:
      "Multiple files are carrying test debt. At least one is in a production-critical path (billing, auth, payment, or API). Start at the top of the ranked list.",
    glyph: "M12 8v5M12 16v.5",
  },
  D: {
    word: "Under-tested",
    title: "Coverage is below where it should be",
    summary:
      "A large share of executable lines are uncovered. Prioritise the top-debt files — every one of them is a high-value target for a single, well-chosen new test.",
    glyph: "M12 8v5M12 16v.5",
  },
  F: {
    word: "Critical debt",
    title: "Headline coverage is dangerously low",
    summary:
      "Coverage across the tree is weak and at least one production-critical file has a large uncovered span. Treat the top of the ranked list as the triage queue before the next release.",
    glyph: "M8 8l8 8M16 8l-8 8",
  },
};

/* ---------------------------- Heuristic prose --------------------------- */
/* Deliberately templated. Emits sentence-style descriptions derived purely
 * from line numbers and path heuristics. The report's LLM reasoner is not
 * in this demo, and the prose panel says so. */
function bulletForSpan(span) {
  const range =
    span.start === span.end
      ? `Line ${span.start}`
      : `Lines ${span.start}–${span.end}`;
  const suffix =
    span.branchCount > 0
      ? ` (${span.lineCount} line${span.lineCount === 1 ? "" : "s"}, ` +
        `${span.branchCount} branch${
          span.branchCount === 1 ? "" : "es"
        } partial)`
      : ` (${span.lineCount} line${span.lineCount === 1 ? "" : "s"})`;
  return `${range} is uncovered${suffix}.`;
}

function bulletsForFile(file) {
  const bullets = [];
  bullets.push(
    `${file.uncovered} of ${file.total} executable lines are uncovered ` +
      `(line rate ${Math.round(file.lineRate * 100)}%).`
  );
  // At most three span bullets per file — prioritise the longest.
  const topSpans = file.spans
    .slice()
    .sort((a, b) => b.lineCount - a.lineCount)
    .slice(0, 3);
  for (const s of topSpans) bullets.push(bulletForSpan(s));
  if (file.spans.length > topSpans.length) {
    const rest = file.spans.length - topSpans.length;
    bullets.push(
      `${rest} additional shorter uncovered span${rest === 1 ? "" : "s"} not shown.`
    );
  }
  if (file.branchGap > 0 && !file.spans.some((s) => s.branchCount > 0)) {
    bullets.push(
      `${file.branchGap} branch ` +
        `${file.branchGap === 1 ? "decision is" : "decisions are"} uncovered.`
    );
  }
  const sev = file.severityDelta;
  if (sev >= 20) {
    bullets.push(
      "Path hint: this file matches a production-critical pattern " +
        "(billing, payment, auth, security, or token). The demo bumps its " +
        "rank accordingly."
    );
  } else if (sev >= 10) {
    bullets.push(
      "Path hint: this file matches an API or service-layer pattern. " +
        "Tests here tend to cover user-visible behaviour."
    );
  } else if (sev <= -4) {
    bullets.push(
      "Path hint: this file matches a utility or logging pattern. The demo " +
        "docks its rank relative to equivalent-debt business files."
    );
  }
  return bullets;
}

function textForCopy(file) {
  const bullets = bulletsForFile(file);
  const lines = [`${file.path} — debt score ${file.debt} (${file.bucket}).`];
  for (const b of bullets) lines.push(`  • ${b}`);
  return lines.join("\n");
}

/* --------------------------- Rendering helpers -------------------------- */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function announce(message) {
  el.status.textContent = "";
  requestAnimationFrame(() => {
    el.status.textContent = message;
  });
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError() {
  el.error.textContent = "";
  el.error.hidden = true;
}

function resetUi() {
  el.resultsSection.hidden = true;
  el.findingsSection.hidden = true;
  el.proseSection.hidden = true;
  el.findingsList.innerHTML = "";
  el.proseList.innerHTML = "";
  el.findingsEmpty.hidden = true;
  clearError();
}

function renderScore(result) {
  const { percent } = result.overall;
  const grade = gradeFor(percent, result.ranked);
  const meta = GRADE_META[grade];

  el.scoreNumber.textContent = String(percent);
  el.scoreTitle.textContent = meta.title;
  el.scoreSummary.textContent = meta.summary;
  el.gradeBadge.dataset.grade = grade.toLowerCase();
  el.gradeLetter.textContent = grade;
  el.gradeWord.textContent = meta.word;
  el.gradeGlyph.setAttribute("d", meta.glyph);

  const offset = RING_CIRCUMFERENCE * (1 - percent / 100);
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  if (reduceMotion) {
    el.ringFg.style.transition = "none";
  } else {
    el.ringFg.style.transition = "stroke-dashoffset 520ms ease-out";
  }
  void el.ringFg.getBoundingClientRect();
  el.ringFg.style.strokeDashoffset = String(offset);

  const { totals } = result;
  const highCount = result.ranked.filter((r) => r.bucket === "high").length;
  const medCount = result.ranked.filter((r) => r.bucket === "medium").length;
  const lowCount = result.ranked.filter((r) => r.bucket === "low").length;
  const pieces = [];
  if (highCount) pieces.push(`${highCount} high-debt`);
  if (medCount) pieces.push(`${medCount} medium-debt`);
  if (lowCount) pieces.push(`${lowCount} low-debt`);
  const breakdown = pieces.length ? pieces.join(", ") : "no files with gaps";

  el.scoreSr.textContent =
    `Grade ${grade}, ${percent}% line coverage across ${totals.fileCount} ` +
    `files. ${totals.uncoveredLines} of ${totals.totalLines} executable ` +
    `lines are uncovered. Ranked list: ${breakdown}.`;

  return grade;
}

function meterValueFor(file) {
  // meter max=60, optimum=0. The three thresholds mirror the bucket cutoffs.
  const value = Math.min(file.debt, 60);
  return { value, low: 12, high: 30, max: 60, optimum: 0 };
}

function renderFindings(ranked, overall) {
  el.findingsList.innerHTML = "";
  if (ranked.length === 0) {
    el.findingsEmpty.hidden = false;
    el.findingsEmpty.textContent =
      `Analysis complete. No uncovered lines found across ` +
      `${overall.fileCount} file${overall.fileCount === 1 ? "" : "s"}. ` +
      `Nothing to rank.`;
    return;
  }
  el.findingsEmpty.hidden = true;

  ranked.forEach((file, idx) => {
    const rank = idx + 1;
    const m = meterValueFor(file);
    const id = `finding-${rank}`;
    const li = document.createElement("li");
    li.className = "finding";
    li.id = id;
    li.dataset.bucket = file.bucket;

    const spanBits = file.spans
      .slice()
      .sort((a, b) => b.lineCount - a.lineCount)
      .slice(0, 3)
      .map((s) => {
        const range = s.start === s.end ? `${s.start}` : `${s.start}–${s.end}`;
        return `<li><code>L${range}</code> · ${s.lineCount} line${
          s.lineCount === 1 ? "" : "s"
        }${s.branchCount > 0 ? ` · ${s.branchCount} branch partial` : ""}</li>`;
      })
      .join("");

    const remaining =
      file.spans.length > 3
        ? `<li>+${file.spans.length - 3} shorter span${
            file.spans.length - 3 === 1 ? "" : "s"
          }</li>`
        : "";

    const bucketLabel =
      file.bucket === "high"
        ? "High debt"
        : file.bucket === "medium"
        ? "Medium debt"
        : "Low debt";

    li.innerHTML = `
      <div class="finding__head">
        <h3 class="finding__title">${escapeHtml(file.path)}</h3>
        <span class="debt-bucket" data-bucket="${file.bucket}">${escapeHtml(
      bucketLabel
    )}</span>
      </div>
      <div class="finding__meter-row">
        <meter
          value="${m.value}"
          min="0"
          max="${m.max}"
          low="${m.low}"
          high="${m.high}"
          optimum="${m.optimum}"
          aria-label="Test-debt score ${file.debt} out of ${m.max} for ${escapeHtml(
      file.path
    )}. Lower is better."
        >Debt ${file.debt} of ${m.max}.</meter>
        <span class="finding__stats">
          Debt ${file.debt} · ${file.uncovered}/${file.total} uncovered ·
          longest span ${file.longest} line${file.longest === 1 ? "" : "s"}
        </span>
      </div>
      ${
        spanBits
          ? `<ul class="finding__spans" aria-label="Top uncovered spans in ${escapeHtml(
              file.path
            )}">${spanBits}${remaining}</ul>`
          : ""
      }
    `;
    el.findingsList.appendChild(li);
  });
}

function renderProse(ranked) {
  el.proseList.innerHTML = "";
  if (ranked.length === 0) {
    el.proseSection.hidden = true;
    return;
  }
  el.proseSection.hidden = false;

  ranked.forEach((file, idx) => {
    const rank = idx + 1;
    const card = document.createElement("article");
    card.className = "prose-card";
    card.dataset.bucket = file.bucket;

    const bullets = bulletsForFile(file)
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join("");

    const copyId = `copy-${rank}`;
    card.innerHTML = `
      <div class="prose-card__head">
        <h3 class="prose-card__title">${escapeHtml(file.path)}</h3>
      </div>
      <ul class="prose-card__bullets">${bullets}</ul>
      <div class="prose-card__actions">
        <button
          id="${copyId}"
          type="button"
          class="button button--ghost button--copy"
          aria-label="Copy test-debt description for ${escapeHtml(file.path)}"
        >
          Copy description
        </button>
      </div>
    `;

    const btn = card.querySelector(".button--copy");
    btn.addEventListener("click", async () => {
      const payload = textForCopy(file);
      try {
        await navigator.clipboard.writeText(payload);
        announce(`Copied test-debt description for ${file.path}.`);
      } catch {
        announce(
          `Copy blocked by the browser. Select the description for ${file.path} manually.`
        );
      }
    });

    el.proseList.appendChild(card);
  });
}

/* ------------------------------ Run analysis ---------------------------- */
function runAnalyse(xmlText, sourceLabel) {
  resetUi();
  if (!xmlText || !xmlText.trim()) {
    showError("No XML to analyse. Choose a coverage.xml file or paste one below.");
    announce("No coverage data provided.");
    return;
  }

  let result;
  try {
    result = analyse(xmlText);
  } catch (err) {
    console.error(err);
    showError(err.message || "Could not analyse that coverage file.");
    announce("Analysis failed.");
    return;
  }

  el.resultsSection.hidden = false;
  el.findingsSection.hidden = false;
  const grade = renderScore(result);
  renderFindings(result.ranked, result.totals);
  renderProse(result.ranked);

  el.resetBtn.hidden = false;

  const totalSrc = sourceLabel ? ` from ${sourceLabel}` : "";
  const rankedCount = result.ranked.length;
  const summary = rankedCount
    ? `Analysed ${result.totals.fileCount} files${totalSrc}. Grade ${grade}, ` +
      `${result.overall.percent}% line coverage. ${rankedCount} file${
        rankedCount === 1 ? "" : "s"
      } ranked by test debt.`
    : `Analysed ${result.totals.fileCount} files${totalSrc}. Grade ${grade}, ` +
      `${result.overall.percent}% line coverage. No uncovered lines found.`;
  announce(summary);

  requestAnimationFrame(() => {
    el.resultsH.focus();
    el.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function runReset() {
  resetUi();
  el.xmlInput.value = "";
  el.fileInput.value = "";
  el.resetBtn.hidden = true;
  // Reset the score ring visually so a re-analyse animates from empty.
  el.ringFg.style.transition = "none";
  el.ringFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  el.scoreNumber.textContent = "—";
  el.scoreTitle.textContent = "Awaiting report";
  el.scoreSummary.textContent = "";
  el.gradeBadge.dataset.grade = "pending";
  el.gradeLetter.textContent = "—";
  el.gradeWord.textContent = "Awaiting report";
  el.scoreSr.textContent = "";
  announce("Cleared. Choose another coverage.xml file to analyse.");
  el.fileLabel.focus();
}

/* ------------------------------ File loading ---------------------------- */
async function loadFile(file) {
  if (!file) return;
  clearError();
  if (file.size > MAX_FILE_BYTES) {
    showError(
      `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which is ` +
        `above the 10 MB demo limit. Use the CLI pipeline for larger reports.`
    );
    announce("File too large.");
    return;
  }
  const nameLooksWrong =
    !/\.xml$/i.test(file.name) &&
    file.type !== "application/xml" &&
    file.type !== "text/xml";
  if (nameLooksWrong) {
    // Don't reject — coverage.py sometimes writes .cobertura — but note it.
    announce(
      `Loading ${file.name}. The filename does not end in .xml; the analyser will still try.`
    );
  } else {
    announce(`Loading ${file.name}.`);
  }
  try {
    const text = await file.text();
    runAnalyse(text, file.name);
  } catch {
    showError("Could not read that file.");
    announce("File read failed.");
  }
}

/* ------------------------------ Drag and drop --------------------------- */
function initDragDrop() {
  const labelEl = el.fileLabel;
  // Drag events fire on the drop-zone overlay AND on the label — we listen
  // on document so a drop anywhere over the upload region works, then check
  // the target. This is what matches the "or drop a file anywhere on this
  // area" affordance in the label.
  const uploadArea = document.querySelector(".upload-row");

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  uploadArea.addEventListener("dragenter", (e) => {
    prevent(e);
    labelEl.classList.add("is-dragover");
  });
  uploadArea.addEventListener("dragover", (e) => {
    prevent(e);
    // Some browsers need this set explicitly for the drop effect cursor.
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    labelEl.classList.add("is-dragover");
  });
  uploadArea.addEventListener("dragleave", (e) => {
    // Only clear if we're actually leaving the upload area, not just
    // crossing from label into the hint text.
    if (e.target === uploadArea || !uploadArea.contains(e.relatedTarget)) {
      labelEl.classList.remove("is-dragover");
    }
  });
  uploadArea.addEventListener("drop", (e) => {
    prevent(e);
    labelEl.classList.remove("is-dragover");
    const file =
      e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  // Prevent the browser from navigating to the dropped file if it misses
  // the upload area.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

/* ------------------------- Theme toggle (dark mode) --------------------- */
function initTheme() {
  const saved = localStorage.getItem("testgapfinder-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved ? saved === "dark" : prefersDark;
  applyTheme(isDark);
  el.themeToggle.addEventListener("click", () => {
    const nowDark = document.documentElement.dataset.theme !== "dark";
    applyTheme(nowDark);
    localStorage.setItem("testgapfinder-theme", nowDark ? "dark" : "light");
  });
}

function applyTheme(isDark) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  el.themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  el.themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );
}

/* ------------------------------ Bootstrap ------------------------------- */
function init() {
  el.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadFile(file);
    // Reset so the same file can be re-picked.
    e.target.value = "";
  });

  el.analysePasteBtn.addEventListener("click", () => {
    const text = el.xmlInput.value;
    if (!text.trim()) {
      showError("Paste Cobertura XML into the textarea first.");
      el.xmlInput.focus();
      return;
    }
    runAnalyse(text, "pasted XML");
  });

  el.xmlInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      el.analysePasteBtn.click();
    }
  });

  el.resetBtn.addEventListener("click", runReset);

  initDragDrop();
  initTheme();

  announce("TestGapFinder ready. Choose a coverage.xml file to begin.");
}

document.addEventListener("DOMContentLoaded", init);
