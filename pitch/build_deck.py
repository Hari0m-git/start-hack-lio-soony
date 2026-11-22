"""Builds the five-slide pitch deck. Run from the repository root:

    uv run --with python-pptx python pitch/build_deck.py

Figures are the ones the running system showed when the screenshots in pitch/img were taken.
"""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

HERE = Path(__file__).parent
BG, PANEL, LINE = RGBColor(0x0E, 0x0E, 0x10), RGBColor(0x17, 0x17, 0x1A), RGBColor(0x2C, 0x2C, 0x33)
WHITE, MUTED, ACCENT, CORAL = RGBColor(0xFF, 0xFF, 0xFF), RGBColor(0xA6, 0xA6, 0xB0), RGBColor(0xD0, 0x37, 0x5E), RGBColor(0xFF, 0x82, 0x7E)
FONT = "Segoe UI"

deck = Presentation()
deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)


def box(slide, x, y, w, h, fill=PANEL, line=None, radius=0.06):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.adjustments[0] = radius
    shape.shadow.inherit = False
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(1)
    return shape


def text(slide, x, y, w, h, paragraphs, size=14, color=WHITE, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.08):
    """paragraphs: a string, or a list whose items are a string or a list of (text, colour, bold) runs."""
    frame = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h)).text_frame
    frame.word_wrap = True
    frame.vertical_anchor = anchor
    for side in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(frame, side, 0)
    for i, runs in enumerate([paragraphs] if isinstance(paragraphs, str) else paragraphs):
        para = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        para.alignment, para.line_spacing = align, spacing
        for content, run_color, run_bold in ([(runs, color, bold)] if isinstance(runs, str) else runs):
            run = para.add_run()
            run.text = content
            run.font.name, run.font.size, run.font.bold = FONT, Pt(size), run_bold
            run.font.color.rgb = run_color or color
    return frame


def tag(slide, x, y, label, kind):
    fill, line, color = {"verified": (None, WHITE, WHITE), "book": (LINE, None, WHITE), "assumption": (None, CORAL, CORAL),
                         "pending": (ACCENT, None, WHITE)}[kind]
    box(slide, x, y, 1.42, 0.3, fill=fill, line=line, radius=0.5)
    text(slide, x, y, 1.42, 0.3, label, size=9.5, color=color, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def slide(number, headline, notes):
    s = deck.slides.add_slide(deck.slide_layouts[6])
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = BG
    box(s, 0.6, 0.52, 0.16, 0.16, fill=ACCENT, radius=0.3)
    text(s, 0.86, 0.47, 6, 0.3, "LIO LAUNCH CONTROL", size=10.5, color=MUTED, bold=True)
    text(s, 10.7, 0.47, 2.03, 0.3, f"0{number} / 05", size=10.5, color=MUTED, bold=True, align=PP_ALIGN.RIGHT)
    text(s, 0.6, 0.95, 12.1, 1.0, headline, size=34, bold=True, spacing=0.98)
    text(s, 0.6, 7.02, 12.1, 0.3, "START Hack Munich 2026 · Lio challenge “Keep the Line Running” · figures from Soony’s data as of Sat 21 Nov, 20:50", size=9, color=MUTED)
    s.notes_slide.notes_text_frame.text = notes
    return s


# 1 ─ The problem ─────────────────────────────────────────────────────────────────────────────────────────────
s = slide(1, "One missing component can stop a 700,000-copy launch.", """[0:00–0:30 · 30 seconds]

Sunday, 20:00. Soony launches Grand Heist 6: 640,000 Standard Editions and 72,000 numbered Collector's Editions, every one of them pre-ordered. Six suppliers, one warehouse in Hamburg, and a deadline that does not move.

A copy needs every part. One missing statue, one case stuck at the port, and the line stands.

The information to see that coming exists. It is just in five places: purchase orders in SAP, confirmations in emails and PDFs in four languages, shipments in a spreadsheet, receiving on paper, pack-out in a separate report.

So today Soony's system says every copy ships. The paperwork says 35,400 will not. As their Head of Procurement puts it: "We find out at the dock."

(Do not read the tiles. Say the hook, point at the two numbers at the bottom, move on.)""")
tiles = [("712,000", "copies due on day one", "640,000 Standard · 72,000 Collector’s"), ("6", "suppliers, four languages", "Korea · USA · India · China · Poland"),
         ("1", "warehouse", "the Hamburg distribution centre"), ("Sun 20:00", "trucks leave", "22 Nov 2026 · the date does not move")]
for i, (big, label, small) in enumerate(tiles):
    x, y = 0.6 + (i % 2) * 3.05, 2.35 + (i // 2) * 1.75
    box(s, x, y, 2.85, 1.55, line=LINE)
    text(s, x + 0.25, y + 0.2, 2.4, 0.6, big, size=30, bold=True)
    text(s, x + 0.25, y + 0.85, 2.4, 0.3, label, size=12.5, bold=True, color=CORAL)
    text(s, x + 0.25, y + 1.13, 2.4, 0.3, small, size=10, color=MUTED)
text(s, 7.1, 2.3, 5.6, 0.3, "THE SAME LAUNCH, IN FIVE PLACES", size=10.5, color=MUTED, bold=True)
sources = [("SAP", "purchase orders and book stock"), ("Email and PDF", "supplier confirmations, in four languages"), ("A spreadsheet", "shipments, updated by hand"),
           ("Paper and scans", "what was really received"), ("A separate report", "how far packing has come")]
for i, (where, what) in enumerate(sources):
    y = 2.72 + i * 0.6
    box(s, 7.1, y, 5.63, 0.5, line=LINE, radius=0.12)
    text(s, 7.32, y, 1.9, 0.5, where, size=13, bold=True, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 9.2, y, 3.4, 0.5, what, size=12, color=MUTED, anchor=MSO_ANCHOR.MIDDLE)
box(s, 0.6, 5.95, 12.13, 0.85, fill=ACCENT, radius=0.12)
text(s, 0.9, 5.95, 7.4, 0.85, [[("Soony’s system: ", WHITE, False), ("0 copies short.", WHITE, True), ("   The paperwork: ", WHITE, False), ("35,400.", WHITE, True)]], size=19, anchor=MSO_ANCHOR.MIDDLE)
text(s, 8.2, 5.95, 4.3, 0.85, [[("“We find out at the dock.”", WHITE, True)], [("Head of Procurement, Soony", WHITE, False)]], size=13, align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)

# 2 ─ The product ─────────────────────────────────────────────────────────────────────────────────────────────
s = slide(2, "An AI operations team that keeps the supply chain running.", """[0:30–1:00 · 30 seconds]

Lio Launch Control is not a dashboard and not a chatbot. It is a small team of agents that does the work a planner does at midnight.

Every two minutes it reads whatever changed: ERP exports, scanned delivery notes, supplier PDFs and mails, in Polish, Korean, Chinese or English.

Then the important part: it connects them. An inspection report is linked to the stock batch, the bill of materials and the packing plan, so a finding becomes "this many copies, this line, this hour".

AI reads and decides; code does the arithmetic, so the numbers are reproducible. An agent with tools prices the options and looks up in Soony's own approval policy who may sign. Questions to suppliers go out on their own after every check. Anything that commits money or terms waits for a person's click.

(Technical-depth answer if asked: small model for extraction, fixed rules and an hour-by-hour simulation in code, a tool-calling agent for the decision, guardrails and an audit record around sending.)""")
steps = [("Supplier and ERP data", "exports, scans, PDFs, mail"), ("Specialised agents", "read every file into sourced facts"), ("Risk and impact", "ERP against the paper, hour by hour"),
         ("Recommended action", "priced, with deadline and approver"), ("Human approval", "one click for money or terms")]
for i, (title, sub) in enumerate(steps):
    x = 0.6 + i * 2.47
    last = i == len(steps) - 1
    box(s, x, 2.3, 2.2, 1.6, fill=ACCENT if last else PANEL, line=None if last else LINE)
    text(s, x + 0.2, 2.42, 1.8, 0.3, f"0{i + 1}", size=10.5, bold=True, color=WHITE if last else CORAL)
    text(s, x + 0.2, 2.7, 1.85, 0.6, title, size=13.5, bold=True, spacing=1.0)
    text(s, x + 0.2, 3.3, 1.85, 0.5, sub, size=10.5, color=WHITE if last else MUTED)
    if not last:
        text(s, x + 2.2, 2.3, 0.27, 1.6, "›", size=26, color=ACCENT, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.6, 4.2, 12.1, 0.4, [[("It connects information across the supply chain. ", WHITE, True), ("It does not summarise documents one by one.", MUTED, False)]], size=17)
columns = [("AI reads", "A small model turns scans, PDFs, spreadsheets and mail in four languages into facts, each linked to its source file."),
           ("Code calculates", "Fixed rules compare the ERP with the paperwork. A simulation packs the weekend hour by hour. No model does the arithmetic."),
           ("An agent decides", "It uses tools for the forecast, the part, the documents and the approval policy, and returns one recommendation with who may sign."),
           ("People stay in charge", "Questions to suppliers go out after every check. Orders, releases and concessions wait for a named person. Everything is recorded.")]
for i, (title, body) in enumerate(columns):
    x = 0.6 + i * 3.07
    box(s, x, 4.9, 2.9, 1.85, line=LINE)
    text(s, x + 0.22, 5.03, 2.5, 0.35, title, size=14.5, bold=True, color=CORAL)
    text(s, x + 0.22, 5.42, 2.5, 1.3, body, size=11, color=WHITE, spacing=1.12)

# 3 ─ The live demo ───────────────────────────────────────────────────────────────────────────────────────────
s = slide(3, "From a supplier problem to an actionable decision.", """[1:00–2:15 · 75 seconds, most of it in the live product]

Take one real case: the die-cast statue from Pune Diecast, a part of every Collector's Edition.

Verified, from the inspection report: a lot of 5,600 statues failed incoming inspection, 9 paint defects in a sample of 125. The ERP still shows them as free stock.

Book stock: 13,900 statues. Take out the failed lot and 8,300 are usable. 11,700 Collector's Editions are still to pack. Lio does that subtraction for every part, every pass: 3,400 copies short.

It then reads Soony's approval policy. The lot may only be used under a concession signed by Supplier Quality and the Category Lead. That post is vacant until Monday, so it routes the exception to the Head of Procurement. That concession is pending. Nothing is released.

Replacements: the ERP shows the next statue shipment for 28 November, after the launch. Asking Pune for earlier stock is the proposed next step; we have not sent it yet.

SWITCH TO THE LIVE PRODUCT HERE (see the strip at the bottom):
1. Today page: flip "System view" to "Evidence view". 0 short becomes 35,400.
2. Open the statue case: recommendation, who signs, the inspection report one click away.
3. Tick the fix under "What if": the dock and the number update.
4. Ask by voice, in German or Polish: "Which line stops first?"

Come back to the slide for the magnet point: the Chinese export restriction on magnets is real, but it is not a confirmed Sunday shortage. The supplier fits the magnets into the Collector's Box, and the books show 14,000 boxes against 11,700 needed. That is book stock. A physical check that the boxes on site have their magnets is still required. Lio says that, instead of raising a false alarm.""")
s.shapes.add_picture(str(HERE / "img" / "deck_case.png"), Inches(0.6), Inches(2.15), height=Inches(4.25))
box(s, 0.6, 2.15, 3.17, 4.25, fill=None, line=LINE, radius=0.03)
text(s, 0.6, 6.45, 3.2, 0.3, "The statue case in the product", size=9.5, color=MUTED)
text(s, 4.1, 2.12, 5, 0.3, "PUNE DIECAST · STATUE “THE GETAWAY”", size=10.5, color=MUTED, bold=True)
rows = [("verified", "VERIFIED", [("5,600 statues failed incoming inspection", WHITE, True), (" · 9 defects in a sample of 125 · inspection report", MUTED, False)]),
        ("book", "BOOK STOCK", [("13,900 on the books → 8,300 usable", WHITE, True), (" once the failed lot is taken out · 11,700 editions left to pack", MUTED, False)]),
        ("pending", "PENDING", [("Concession not signed.", WHITE, True), (" Needs Supplier Quality and the Category Lead; that post is vacant, so it goes to the Head of Procurement", MUTED, False)]),
        ("assumption", "ASSUMPTION", [("Replacements: next statue shipment shows 28 Nov.", WHITE, True), (" Asking Pune for earlier stock is the next step, not yet sent", MUTED, False)])]
for i, (kind, label, runs) in enumerate(rows):
    y = 2.5 + i * 0.72
    tag(s, 4.1, y + 0.03, label, kind)
    text(s, 5.68, y - 0.02, 4.0, 0.7, [runs], size=11.5, spacing=1.05)
box(s, 9.95, 2.12, 2.78, 2.95, fill=ACCENT, radius=0.06)
text(s, 10.15, 2.3, 2.4, 0.3, "IMPACT ON SUNDAY", size=10, bold=True)
text(s, 10.15, 2.62, 2.4, 0.9, "3,400", size=50, bold=True)
text(s, 10.15, 3.6, 2.4, 0.6, "Collector’s Editions cannot be packed", size=13, bold=True, spacing=1.05)
text(s, 10.15, 4.28, 2.4, 0.7, "11,700 needed − 8,300 usable. Worked out in code, not by a model.", size=10.5, spacing=1.1)
box(s, 4.1, 5.42, 8.63, 0.98, line=LINE)
tag(s, 4.3, 5.52, "BOOK STOCK", "book")
text(s, 5.9, 5.47, 6.7, 0.9, [[("China magnet export restriction: real. Sunday shortage: not confirmed.", WHITE, True)],
                             [("The supplier fits the magnets into the Collector’s Box: 14,000 boxes on the books, 11,700 needed. A physical check is still required.", MUTED, False)]], size=11.5, spacing=1.1)
text(s, 4.1, 6.5, 8.63, 0.3, [[("LIVE DEMO  ", ACCENT, True), ("System view → Evidence view   ›   open the statue case   ›   tick the fix in “What if”   ›   ask by voice", WHITE, False)]], size=11)

# 4 ─ Business impact ─────────────────────────────────────────────────────────────────────────────────────────
s = slide(4, "Less firefighting. Faster decisions. Fewer surprises.", """[2:15–2:40 · 25 seconds]

What does Soony get?

They see the problem on Saturday, at a desk, not on Sunday at the dock. Nobody had to open three hundred documents to find it: the agents read them, including the handwritten correction on a scanned delivery note.

The decision arrives ready: one recommendation, what it saves, what it costs, by when, and who is allowed to sign under Soony's own policy.

And it stays accountable. Every approval, every question an agent sent, every handover is on the record, and nothing that commits money goes out without a person.

(If asked about cost: working one case costs cents of model time, measured and capped per hour and per day. We do not claim savings figures; we have one weekend of data.)""")
points = [("Earlier detection of supplier risk", "Failed statues booked as usable stock, a container nobody collected, a delivery booked as 80,000 that was 8,000: found from the files on Saturday."),
          ("Less manual document checking", "303 documents read so far, including scans with handwriting and supplier paperwork in four languages."),
          ("Faster procurement decisions", "One recommendation per problem: copies saved, cost, deadline and the approver."),
          ("Stock and quality you can see", "For every part: what the books say against what the paperwork supports."),
          ("Clear accountability", "The approver comes from Soony’s own policy. Nothing that commits money or terms leaves without a click, and every step is recorded.")]
for i, (title, body) in enumerate(points):
    y = 2.2 + i * 0.9
    box(s, 0.6, y + 0.05, 0.08, 0.68, fill=ACCENT, radius=0.5)
    text(s, 0.85, y, 5.6, 0.3, title, size=15, bold=True)
    text(s, 0.85, y + 0.32, 5.6, 0.55, body, size=11, color=MUTED, spacing=1.08)
s.shapes.add_picture(str(HERE / "img" / "deck_hero.png"), Inches(6.85), Inches(2.25), width=Inches(5.88))
box(s, 6.85, 2.25, 5.88, 2.08, fill=None, line=LINE, radius=0.03)
text(s, 6.85, 4.4, 5.88, 0.3, "The launch as the product shows it, built from the forecast: stopped lines glow, missing copies stand at the dock", size=9.5, color=MUTED)
box(s, 6.85, 4.95, 2.84, 1.45, line=LINE)
text(s, 7.07, 5.08, 2.5, 0.3, "WHAT THE SYSTEM SAYS", size=10, color=MUTED, bold=True)
text(s, 7.07, 5.38, 2.5, 0.6, "0 short", size=28, bold=True)
text(s, 7.07, 5.95, 2.5, 0.35, "both editions finish in time", size=10.5, color=MUTED)
box(s, 9.89, 4.95, 2.84, 1.45, fill=ACCENT)
text(s, 10.11, 5.08, 2.5, 0.3, "WHAT THE EVIDENCE SAYS", size=10, bold=True)
text(s, 10.11, 5.38, 2.5, 0.6, "35,400 short", size=28, bold=True)
text(s, 10.11, 5.95, 2.5, 0.35, "3,400 Collector’s · 32,000 Standard", size=10.5)

# 5 ─ The opportunity ─────────────────────────────────────────────────────────────────────────────────────────
s = slide(5, "Built for Soony. Scalable across supply chains.", """[2:40–3:00 · 20 seconds]

Soony is the first customer. But nothing in the product knows what a statue or a game card is: no part number, supplier or rule is written into the code. It learns the business from the customer's own files.

The same gap between the system and the paperwork exists wherever a line depends on many suppliers: manufacturing, automotive, electronics, consumer goods.

We would sell it as a subscription per site, scaled by the number of suppliers, starting with one launch or one plant. That is a proposal; we have no customers or revenue to report.

Close, slowly:
"We don't just tell companies that something went wrong. We help them understand what it means, what they can still do, and who needs to act. That's how we keep the line running."

(Q&A, be straight about limits: the agents cannot reach Soony's own staff yet, the ERP is read from exports rather than a live connection, and approvals use personal keys rather than a company login.)""")
text(s, 0.6, 2.15, 3.8, 0.3, "THE SAME GAP, ELSEWHERE", size=10.5, color=MUTED, bold=True)
for i, market in enumerate(["Manufacturing", "Automotive", "Electronics", "Consumer goods", "Any business run on a supplier network"]):
    y = 2.52 + i * 0.56
    box(s, 0.6, y, 3.8, 0.46, line=LINE, radius=0.12)
    text(s, 0.82, y, 3.5, 0.46, market, size=13, bold=True, anchor=MSO_ANCHOR.MIDDLE)
text(s, 4.75, 2.15, 3.8, 0.3, "HOW WE WOULD CHARGE · PROPOSED", size=10.5, color=MUTED, bold=True)
box(s, 4.75, 2.52, 3.8, 2.7, line=LINE)
text(s, 4.97, 2.68, 3.4, 2.5, [[("Subscription per site", WHITE, True)], [("Tiered by number of suppliers and documents read.", MUTED, False)], [("", MUTED, False)],
                               [("Start small", WHITE, True)], [("One launch or one plant, then more sites.", MUTED, False)], [("", MUTED, False)],
                               [("AI cost stays visible", WHITE, True)], [("Metered per case, with an hourly and a daily cap.", MUTED, False)]], size=11.5, spacing=1.1)
text(s, 8.9, 2.15, 3.83, 0.3, "WHAT RUNS TODAY · WHAT COMES NEXT", size=10.5, color=MUTED, bold=True)
box(s, 8.9, 2.52, 3.83, 2.7, line=LINE)
text(s, 9.12, 2.68, 3.45, 2.5, [[("Today", CORAL, True)], [("Watching the portal · reading every file · ERP against paper · packing forecast · decision agent · supplier mail with approval · voice assistant in five languages", WHITE, False)],
                                [("", MUTED, False)], [("Next", CORAL, True)], [("Live ERP connection · a channel to the customer’s approvers · company login · supplier track records", MUTED, False)]], size=11, spacing=1.12)
box(s, 0.6, 5.5, 12.13, 1.25, fill=ACCENT, radius=0.08)
text(s, 0.95, 5.5, 11.45, 1.25, [[("We don’t just tell companies that something went wrong. ", WHITE, False), ("We help them understand what it means, what they can still do, and who needs to act.", WHITE, True)],
                                 [("That’s how we keep the line running.", WHITE, True)]], size=17, anchor=MSO_ANCHOR.MIDDLE, spacing=1.12)

out = HERE / "Lio_Launch_Control_pitch.pptx"
deck.save(out)
print("saved", out)
