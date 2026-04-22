"""Programmatic figures for the TestGapFinder design report.

Each factory returns a reportlab Drawing that is embedded directly in the PDF.
Everything is vector; nothing is rasterised.
"""

from __future__ import annotations

import math

from reportlab.graphics.shapes import (
    Drawing,
    Group,
    Line,
    Polygon,
    Rect,
    String,
)
from reportlab.lib import colors

# Palette -- same spine as PyOptimize (gold) and SchemaShift (teal).
# TestGapFinder's continuous-deliverable accent is a deep violet so the three
# projects are instantly distinguishable when placed side by side.
NAVY = colors.HexColor("#0a1f44")
STEEL = colors.HexColor("#2a3a5e")
INK = colors.HexColor("#1c2536")
MUTED = colors.HexColor("#5c6a82")
ACCENT = colors.HexColor("#5b21b6")  # violet
ACCENT_SOFT = colors.HexColor("#ede9fe")
BG = colors.HexColor("#f6f5fb")
SOFT = colors.HexColor("#e8e4f3")
WHITE = colors.HexColor("#ffffff")
BORDER = colors.HexColor("#c7cfe0")


def _box(
    x: float,
    y: float,
    w: float,
    h: float,
    label: str,
    *,
    fill=WHITE,
    stroke=NAVY,
    text_color=INK,
    font_size: float = 9,
    bold: bool = False,
) -> Group:
    g = Group()
    g.add(Rect(x, y, w, h, fillColor=fill, strokeColor=stroke, strokeWidth=0.8, rx=3, ry=3))
    font = "Helvetica-Bold" if bold else "Helvetica"
    lines = label.split("\n")
    total_h = len(lines) * (font_size + 2)
    start_y = y + h / 2 + total_h / 2 - font_size
    for i, line in enumerate(lines):
        g.add(
            String(
                x + w / 2,
                start_y - i * (font_size + 2),
                line,
                fontName=font,
                fontSize=font_size,
                fillColor=text_color,
                textAnchor="middle",
            )
        )
    return g


def _arrow(x1: float, y1: float, x2: float, y2: float, color=STEEL) -> Group:
    g = Group()
    g.add(Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=1.1))
    angle = math.atan2(y2 - y1, x2 - x1)
    ah = 5
    aw = 3
    tip_x, tip_y = x2, y2
    left_x = tip_x - ah * math.cos(angle) + aw * math.sin(angle)
    left_y = tip_y - ah * math.sin(angle) - aw * math.cos(angle)
    right_x = tip_x - ah * math.cos(angle) - aw * math.sin(angle)
    right_y = tip_y - ah * math.sin(angle) + aw * math.cos(angle)
    g.add(
        Polygon(
            points=[tip_x, tip_y, left_x, left_y, right_x, right_y],
            fillColor=color,
            strokeColor=color,
            strokeWidth=0.5,
        )
    )
    return g


def _caption(d: Drawing, text: str) -> None:
    d.add(
        String(
            d.width / 2,
            6,
            text,
            fontName="Helvetica-Oblique",
            fontSize=8.5,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )


# ---------------------------------------------------------------------------
# Figure 1 -- TestGapFinder seven-stage pipeline
# ---------------------------------------------------------------------------
def figure_pipeline() -> Drawing:
    d = Drawing(460, 280)
    d.add(Rect(0, 0, 460, 280, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Inputs
    d.add(_box(15, 220, 85, 28, "coverage.xml", fill=SOFT, bold=True))
    d.add(_box(15, 185, 85, 28, "Python\nsource tree", fill=SOFT))
    d.add(_box(15, 145, 85, 28, "Git history", fill=SOFT))

    # Stage column 1
    d.add(_box(115, 220, 95, 28, "Coverage\ningester", fill=WHITE))
    d.add(_box(115, 185, 95, 28, "Static\nanalyser", fill=WHITE))
    d.add(_box(115, 145, 95, 28, "Churn\ngatherer", fill=WHITE))

    # Stage column 2 (call graph depends on static analyser output)
    d.add(_box(225, 170, 85, 32, "Call-graph\nbuilder", fill=WHITE))

    # Signal fusion
    d.add(_box(325, 170, 115, 32, "Signal fusion", fill=ACCENT, text_color=WHITE, stroke=ACCENT, bold=True))

    # Reasoner
    d.add(_box(325, 120, 115, 32, "LLM reasoner", fill=WHITE))

    # Reporting
    d.add(_box(325, 70, 115, 32, "Reporting", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Outputs
    d.add(_box(215, 30, 100, 32, "PR comment", fill=SOFT))
    d.add(_box(325, 30, 115, 32, "JSON artefact +\nstub files", fill=SOFT))

    # Arrows -- inputs to stage 1
    d.add(_arrow(100, 234, 115, 234))
    d.add(_arrow(100, 199, 115, 199))
    d.add(_arrow(100, 159, 115, 159))

    # Stage 1 to static -> call graph
    d.add(_arrow(210, 199, 225, 195))
    # Coverage + churn into fusion
    d.add(_arrow(210, 234, 325, 195))
    d.add(_arrow(210, 159, 325, 180))
    # Call graph -> fusion
    d.add(_arrow(310, 186, 325, 186))
    # Fusion -> reasoner
    d.add(_arrow(382, 170, 382, 152))
    # Reasoner -> reporting
    d.add(_arrow(382, 120, 382, 102))
    # Reporting -> outputs
    d.add(_arrow(370, 70, 280, 62))
    d.add(_arrow(382, 70, 382, 62))

    _caption(d, "Figure 1. TestGapFinder seven-stage pipeline. Three inputs feed three analyser stages; fusion drives a small LM reasoner and two outputs.")
    return d


# ---------------------------------------------------------------------------
# Figure 2 -- Signal fusion weights
# ---------------------------------------------------------------------------
def figure_signal_fusion() -> Drawing:
    d = Drawing(460, 200)
    d.add(Rect(0, 0, 460, 200, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Four signal inputs, with weight labels
    signals = [
        ("Coverage gap", "w_gap = 0.40", 155),
        ("Churn (decayed)", "w_churn = 0.25", 120),
        ("Complexity", "w_complex = 0.20", 85),
        ("Centrality", "w_central = 0.15", 50),
    ]
    for label, weight, y in signals:
        d.add(_box(20, y, 120, 28, label, fill=WHITE))
        d.add(
            String(
                150,
                y + 15,
                weight,
                fontName="Courier-Bold",
                fontSize=8.5,
                fillColor=ACCENT,
            )
        )

    # Weighted-sum node
    d.add(_box(260, 95, 80, 40, "Σ weighted", fill=ACCENT, text_color=WHITE, stroke=ACCENT, bold=True))

    # Output
    d.add(_box(360, 95, 85, 40, "TestDebtScore\n[0, 1]", fill=SOFT, bold=True))

    # Arrows
    for _, _, y in signals:
        d.add(_arrow(220, y + 14, 260, 115))
    d.add(_arrow(340, 115, 360, 115))

    # Note
    d.add(
        String(
            230,
            20,
            "Weights are tuned on an open-source corpus and hard-coded in the pipeline. Retuning is annual.",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 2. Signal fusion. Four normalised signals are combined by a fixed-weight sum into a per-function score in [0, 1].")
    return d


# ---------------------------------------------------------------------------
# Figure 3 -- Stub generation flow
# ---------------------------------------------------------------------------
def figure_stub_flow() -> Drawing:
    d = Drawing(460, 220)
    d.add(Rect(0, 0, 460, 220, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    d.add(_box(25, 165, 110, 34, "Top-N scored\nfunctions", fill=SOFT, bold=True))
    d.add(_box(170, 165, 125, 34, "Function source +\nuncovered lines", fill=WHITE))
    d.add(_box(330, 165, 110, 34, "Seeded\nLLM reasoner", fill=ACCENT, text_color=WHITE, stroke=ACCENT, bold=True))

    d.add(_box(25, 100, 110, 34, "PropertyDescription\nbullets", fill=WHITE))
    d.add(_box(170, 100, 125, 34, "Stub test file\n(pytest class)", fill=WHITE))
    d.add(_box(330, 100, 110, 34, "Engineer completes\ntests", fill=SOFT, bold=True))

    d.add(_arrow(135, 182, 170, 182))
    d.add(_arrow(295, 182, 330, 182))
    d.add(_arrow(385, 165, 80, 134))
    d.add(_arrow(135, 117, 170, 117))
    d.add(_arrow(295, 117, 330, 117))

    d.add(
        String(
            230,
            55,
            "Stub generation is opt-in. Files are namespaced tests/gaps/test_<module>_gaps.py so they",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )
    d.add(
        String(
            230,
            42,
            "are never confused with production tests.",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 3. Stub-generation flow. The LM produces prose; stubs are scaffolding, not substitutes.")
    return d


# ---------------------------------------------------------------------------
# Figure 4 -- Dashboard wireframe
# ---------------------------------------------------------------------------
def figure_dashboard() -> Drawing:
    d = Drawing(460, 280)
    d.add(Rect(0, 0, 460, 280, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Browser chrome
    d.add(Rect(15, 15, 430, 245, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.8, rx=3, ry=3))
    d.add(Rect(15, 235, 430, 25, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.6, rx=3, ry=3))
    for i, col in enumerate([colors.HexColor("#d97757"), colors.HexColor("#d7b56d"), colors.HexColor("#6ea97a")]):
        d.add(Rect(25 + i * 12, 244, 7, 7, fillColor=col, strokeColor=col, rx=3.5, ry=3.5))
    d.add(
        String(
            85,
            244,
            "testgapfinder.local / Gaps",
            fontName="Helvetica",
            fontSize=8,
            fillColor=MUTED,
        )
    )

    # Sidebar
    d.add(Rect(25, 30, 80, 195, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.5))
    for i, item in enumerate(["Overview", "Gaps", "Function", "Churn", "History"]):
        fill = ACCENT if i == 1 else SOFT
        text = WHITE if i == 1 else INK
        d.add(Rect(30, 205 - i * 28, 70, 22, fillColor=fill, strokeColor=BORDER, strokeWidth=0.3, rx=2, ry=2))
        d.add(
            String(
                65,
                212 - i * 28,
                item,
                fontName="Helvetica-Bold" if i == 1 else "Helvetica",
                fontSize=8,
                fillColor=text,
                textAnchor="middle",
            )
        )

    # Metric cards
    labels = [
        ("Grade", "C"),
        ("Gaps", "24"),
        ("Hot", "7"),
        ("Covered", "71%"),
    ]
    for i, (label, value) in enumerate(labels):
        x = 115 + i * 82
        d.add(Rect(x, 180, 72, 45, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
        d.add(String(x + 36, 210, value, fontName="Helvetica-Bold", fontSize=13, fillColor=ACCENT, textAnchor="middle"))
        d.add(String(x + 36, 190, label, fontName="Helvetica", fontSize=7.5, fillColor=MUTED, textAnchor="middle"))

    # Gap list table
    d.add(Rect(115, 30, 320, 140, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
    d.add(String(125, 158, "Top gaps (ranked by test-debt score)", fontName="Helvetica-Bold", fontSize=8.5, fillColor=INK))
    cols = ["Function", "Score", "Gap", "Churn", "Complex"]
    col_x = [125, 255, 295, 335, 380]
    for label, x in zip(cols, col_x):
        d.add(String(x, 142, label, fontName="Helvetica-Bold", fontSize=7.5, fillColor=MUTED))
    rows = [
        ("billing.apply_discount", "0.92", "48", "9", "14"),
        ("orders.retry_policy", "0.81", "22", "12", "8"),
        ("users.authenticate", "0.76", "14", "6", "11"),
        ("payments.__normalise", "0.68", "31", "4", "6"),
        ("inventory.reserve", "0.55", "18", "7", "5"),
    ]
    for i, row in enumerate(rows):
        y = 124 - i * 16
        d.add(Line(120, y + 12, 430, y + 12, strokeColor=BORDER, strokeWidth=0.3))
        for value, x in zip(row, col_x):
            d.add(String(x, y, value, fontName="Courier" if x == 125 else "Helvetica", fontSize=7.5, fillColor=INK))
        # Score bar
        score = float(row[1])
        d.add(Rect(255 + 40, y - 2, 30 * score, 6, fillColor=ACCENT, strokeColor=ACCENT))

    _caption(d, "Figure 4. Dashboard wireframe. A scored, filterable list of gaps with inline score bars.")
    return d


# ---------------------------------------------------------------------------
# Figure 5 -- Four-week roadmap
# ---------------------------------------------------------------------------
def figure_roadmap() -> Drawing:
    d = Drawing(460, 200)
    d.add(Rect(0, 0, 460, 200, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    weeks = [
        ("Week 1", "Ingestion +\nstatic analysis", "Cobertura parser,\nFunctionInventory"),
        ("Week 2", "Churn + call graph", "PyDriller, centrality,\nfused TestDebtScore"),
        ("Week 3", "Reasoner +\nreporting", "Seeded 7B LM,\nPR comment"),
        ("Week 4", "Dashboard +\npolish", "GH Pages site,\nCI gates, v0.1"),
    ]
    col_w = 100
    gap = 10
    start_x = 20
    for i, (week, title, detail) in enumerate(weeks):
        x = start_x + i * (col_w + gap)
        # Week header
        d.add(Rect(x, 145, col_w, 28, fillColor=ACCENT, strokeColor=ACCENT, rx=3, ry=3))
        d.add(String(x + col_w / 2, 157, week, fontName="Helvetica-Bold", fontSize=10, fillColor=WHITE, textAnchor="middle"))
        # Title body
        d.add(Rect(x, 95, col_w, 44, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.6, rx=3, ry=3))
        for li, line in enumerate(title.split("\n")):
            d.add(
                String(
                    x + col_w / 2,
                    125 - li * 12,
                    line,
                    fontName="Helvetica-Bold",
                    fontSize=9,
                    fillColor=INK,
                    textAnchor="middle",
                )
            )
        # Detail
        d.add(Rect(x, 40, col_w, 48, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.3, rx=3, ry=3))
        for li, line in enumerate(detail.split("\n")):
            d.add(
                String(
                    x + col_w / 2,
                    70 - li * 11,
                    line,
                    fontName="Helvetica",
                    fontSize=8,
                    fillColor=INK,
                    textAnchor="middle",
                )
            )
    # Arrows between weeks
    for i in range(len(weeks) - 1):
        x1 = start_x + i * (col_w + gap) + col_w
        x2 = start_x + (i + 1) * (col_w + gap)
        d.add(_arrow(x1 + 1, 158, x2 - 1, 158, color=NAVY))

    _caption(d, "Figure 5. Four-week roadmap. Each week ends with a shippable increment.")
    return d


# ---------------------------------------------------------------------------
# Figure 6 -- Data contract relationships
# ---------------------------------------------------------------------------
def figure_data_model() -> Drawing:
    d = Drawing(460, 280)
    d.add(Rect(0, 0, 460, 280, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Entities
    entities = [
        ("CoverageReport", 25, 220, 120, 40, "per-file hits"),
        ("FunctionInventory", 170, 220, 120, 40, "spans + CC"),
        ("ChurnReport", 315, 220, 120, 40, "recency-weighted"),
        ("CallGraph", 170, 150, 120, 40, "centrality"),
        ("TestDebtScore", 170, 90, 120, 40, "fused score"),
        ("PropertyDescription", 25, 30, 160, 40, "prose bullets"),
        ("Report", 230, 30, 180, 40, "grade + top-N findings"),
    ]
    for name, x, y, w, h, note in entities:
        is_final = name == "Report"
        fill = ACCENT if is_final else WHITE
        text = WHITE if is_final else INK
        d.add(
            _box(
                x,
                y,
                w,
                h,
                f"{name}\n{note}",
                fill=fill,
                stroke=ACCENT if is_final else NAVY,
                text_color=text,
                font_size=8.5,
                bold=is_final,
            )
        )

    # Arrows -- data flow
    d.add(_arrow(85, 220, 200, 195))  # Coverage -> fusion via graph indirectly? just to score
    d.add(_arrow(230, 220, 230, 195))  # Inventory -> CallGraph
    d.add(_arrow(375, 220, 290, 195))  # Churn -> score
    d.add(_arrow(230, 150, 230, 135))  # Graph -> score
    d.add(_arrow(170, 110, 185, 70))   # Score -> prose
    d.add(_arrow(290, 110, 320, 70))   # Score -> Report
    d.add(_arrow(185, 45, 230, 45))    # Prose -> Report

    _caption(d, "Figure 6. Data contract relationships. Each arrow is a typed Pydantic artefact written to disk.")
    return d


FIGURES = {
    "pipeline": figure_pipeline,
    "signal_fusion": figure_signal_fusion,
    "stub_flow": figure_stub_flow,
    "dashboard": figure_dashboard,
    "roadmap": figure_roadmap,
    "data_model": figure_data_model,
}
