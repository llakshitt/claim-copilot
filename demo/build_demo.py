"""Builds the fictional demo documents (real PDF text layers) plus a scanned bill image and the ground truth.
Run: python3 demo/build_demo.py   (needs playwright + chromium)"""
import json, os
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(__file__), "..", "frontend", "demo")
CSS = """body{font:13px/1.55 Arial,Helvetica,sans-serif;color:#111;margin:0;padding:0}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}
.small{color:#444;font-size:11px}.box{border:1px solid #777;padding:8px 10px;margin:10px 0}
p{margin:6px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:5px 8px;text-align:left}
th{background:#eee}td.r,th.r{text-align:right}.pb{page-break-before:always}"""

POLICY = """<h1>Sample Care Plus: Policy Wording</h1>
<p class="small">DEMONSTRATION DOCUMENT. Issued by a fictional insurer, Sample Health Insurance Company Ltd. Not a real policy.</p>
<div class="box"><b>Schedule.</b> Policy start date: 1 April 2024. Policy period: 12 months, renewable. Plan type: Individual. Insured: Demo Policyholder.</div>
<h2>Section 1: Definitions</h2>
<p>1.1 "Hospital" means an institution with at least 15 inpatient beds, qualified nursing staff round the clock and a qualified medical practitioner in charge.</p>
<p>1.2 "Admissible claim" means the part of a hospital bill that is payable under this policy after the terms below are applied.</p>
<h2>Section 2: Cover</h2>
<p>2.1 The Sum Insured under this policy is Rs 5,00,000 per policy year.</p>
<p>2.2 We pay the reasonable and customary cost of hospitalisation of at least 24 hours for an illness or injury that begins after the waiting periods in Section 7.</p>
<h2>Section 3: Hospital room</h2>
<p>3.1 Room rent, boarding and nursing charges are limited to 1% of the Sum Insured per day for a single private room.</p>
<p>3.2 If you choose a room costing more than this limit, the related medical charges (doctor fees, surgery, operation theatre, nursing, diagnostics and procedures) are reduced in the same proportion.</p>
<h2>Section 4: Sharing of cost</h2>
<p>4.1 The insured bears 10% of every admissible claim.</p>
<p>4.2 A deductible of Rs 2,000 applies to each claim, after the co-payment in 4.1.</p>
<h2 class="pb">Section 5: Limits on specific charges</h2>
<p>5.1 Diagnostic and investigation charges are limited to Rs 15,000 per claim.</p>
<p>5.2 Items such as registration charges, admission kits, toiletries and similar non-medical items are not payable.</p>
<h2>Section 6: Claims</h2>
<p>6.1 Claims must be notified within 48 hours of admission in an emergency and 3 days before a planned admission.</p>
<p>6.2 If we reduce or reject a claim you may complain to our grievance officer, then to the Insurance Regulatory and Development Authority of India (IRDAI), then to the Insurance Ombudsman.</p>
<h2>Section 7: Waiting periods</h2>
<p>7.1 Hernia is subject to a waiting period of 730 days from the policy start date.</p>
<p>7.2 Cataract is subject to a waiting period of 365 days from the policy start date.</p>
<h2>Section 8: What is not covered</h2>
<p>8.1 Cosmetic or aesthetic treatment is not covered.</p>
<p>8.2 Treatment outside India is not covered.</p>"""

LINES = [  # description, category, amount, days
 ("Room rent, deluxe room (4 days at Rs 8,000)", "room", 32000, 4),
 ("Surgeon fees, hernia repair", "surgery", 45000, None),
 ("Anaesthetist fees", "doctor_fees", 12000, None),
 ("Consultant doctor visits", "doctor_fees", 8000, None),
 ("Operation theatre charges", "ot_charges", 15000, None),
 ("Nursing charges", "nursing", 6000, None),
 ("Blood tests", "diagnostics", 4200, None),
 ("Ultrasound abdomen", "diagnostics", 3500, None),
 ("CT scan abdomen", "diagnostics", 18000, None),
 ("Pharmacy and medicines", "pharmacy", 14650, None),
 ("Surgical mesh and sutures", "consumables", 8400, None),
 ("Registration charges", "non_payable", 500, None),
 ("Admission kit", "non_payable", 1200, None),
 ("Disposable gloves", "consumables", 400, None),
 ("Disposable gloves", "consumables", 400, None),
]
TOTAL = sum(l[2] for l in LINES)

def bill_html():
    rows = "".join(f"<tr><td>{i}</td><td>{d}</td><td class='r'>{a:,}</td></tr>" for i, (d, c, a, _) in enumerate(LINES, 1))
    return f"""<h1>Sample City Hospital</h1>
<p class="small">DEMONSTRATION DOCUMENT. Fictional hospital and patient. Not a real bill.</p>
<div class="box"><b>ITEMIZED FINAL BILL</b><br>Patient: Demo Patient &nbsp; | &nbsp; IP No: SCH-2026-0457<br>Admitted: 12 Oct 2026 &nbsp; | &nbsp; Discharged: 16 Oct 2026 &nbsp; | &nbsp; Diagnosis: Inguinal hernia, repair</div>
<table><tr><th>No</th><th>Description</th><th class="r">Amount (Rs)</th></tr>{rows}
<tr><td></td><td><b>Total bill amount</b></td><td class="r"><b>{TOTAL:,}</b></td></tr>
<tr><td></td><td>Advance received</td><td class="r">20,000</td></tr>
<tr><td></td><td>Balance payable</td><td class="r">{TOTAL-20000:,}</td></tr></table>
<p class="small">Amounts in Indian rupees. Subject to final audit.</p>"""

def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        pg = b.new_page(viewport={"width": 800, "height": 1000})
        for name, body in (("demo-policy", POLICY), ("demo-hospital-bill", bill_html())):
            pg.set_content(f"<html><head><style>{CSS}</style></head><body>{body}</body></html>")
            pg.pdf(path=os.path.join(OUT, name + ".pdf"), format="A4", margin={"top": "18mm", "bottom": "18mm", "left": "16mm", "right": "16mm"})
        pg.set_content(f"<html><head><style>{CSS} body{{padding:24px;width:700px;background:#fff}}</style></head><body>{bill_html()}</body></html>")
        pg.screenshot(path=os.path.join(OUT, "demo-hospital-bill-scan.png"), full_page=True)
        b.close()
    truth = {"sum_insured": 500000, "room_rent_cap_pct_of_si": 1, "copay_pct": 10, "deductible": 2000,
             "sub_limits": {"diagnostics": 15000}, "waiting_period_days": {"hernia": 730, "cataract": 365},
             "lines": [{"description": d, "category": c, "amount": a, "days": dy} for d, c, a, dy in LINES], "total": TOTAL}
    json.dump(truth, open(os.path.join(os.path.dirname(__file__), "truth.json"), "w"), indent=1)
    print("total", TOTAL)

main()
