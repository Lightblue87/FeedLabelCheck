#!/usr/bin/env python3
"""Audit BVL-derived additive records for legally usable limit metadata.

This tool NEVER guesses units or rewrites the source dataset.
Run: python3 Data/audit_limit_units.py Data/zusatzstoffe.json
Optional: --strict (exit 1 if any record with a limit needs review).
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

UNIT_FIELDS = ("einheit", "Maßeinheit", "masseinheit", "unit")
LIMIT_FIELDS = ("min_mg_kg", "max_mg_kg", "min_value", "max_value")
# These two source rows are known regressions, not automatic corrections:
KNOWN_CASES = {
    "4a48": "2024/2177: FYT/kg enzyme activity, not mg/kg; check amendment and species row",
    "4b1823i": "2026/92: minimum 1e8 KBE/kg, not maximum 1 mg/kg",
}


def audit(records: list[dict]) -> dict:
    findings: list[dict] = []
    counts = Counter()
    for index, row in enumerate(records):
        if not isinstance(row, dict):
            findings.append({"index": index, "issue": "invalid_record"})
            counts["invalid_record"] += 1
            continue
        limits = {field: row.get(field) for field in LIMIT_FIELDS
                  if row.get(field) is not None and str(row.get(field)).strip() != ""}
        if not limits:
            continue
        counts["records_with_limits"] += 1
        identifier = str(row.get("kennnummer") or row.get("e_number") or "").strip()
        unit = next((str(row[field]).strip() for field in UNIT_FIELDS
                     if row.get(field) and str(row[field]).strip()), None)
        issues = []
        if not unit:
            issues.append("missing_explicit_unit")
        if not row.get("source_file") and not row.get("source_ref"):
            issues.append("missing_source")
        if not row.get("limit_basis") and not row.get("reference_moisture_percent"):
            issues.append("unverified_reference_basis")
        if identifier.lower() in KNOWN_CASES:
            issues.append("known_manual_review")
        for issue in issues:
            counts[issue] += 1
        if issues:
            findings.append({
                "index": index, "id": identifier, "issues": issues,
                "source_file": row.get("source_file"), "source_page": row.get("source_page"),
                "unit": unit, "limits": limits,
                **({"review_note": KNOWN_CASES[identifier.lower()]}
                   if identifier.lower() in KNOWN_CASES else {}),
            })
    return {"summary": dict(sorted(counts.items())), "findings": findings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, help="Write audit findings as JSON")
    parser.add_argument("--strict", action="store_true", help="Fail when any limit needs review")
    args = parser.parse_args()
    records = json.loads(args.dataset.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        parser.error("Expected JSON array")
    report = audit(records)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print("Records requiring review:", len(report["findings"]))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return int(bool(args.strict and report["findings"]))


if __name__ == "__main__":
    raise SystemExit(main())
