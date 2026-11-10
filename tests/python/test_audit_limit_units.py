"""Tests for the non-mutating additive limit metadata audit."""
import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[2] / "Data" / "audit_limit_units.py"
spec = importlib.util.spec_from_file_location("audit_limit_units", MODULE)
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


class LimitAuditTests(unittest.TestCase):
    def test_missing_unit_is_flagged(self):
        report = audit_module.audit([{
            "kennnummer": "x", "max_mg_kg": 10, "source_file": "a.pdf",
            "source_page": 1, "reference_moisture_percent": 12,
        }])
        self.assertIn("missing_explicit_unit", report["findings"][0]["issues"])

    def test_fully_annotated_record_not_flagged(self):
        report = audit_module.audit([{
            "kennnummer": "x", "max_mg_kg": 10, "einheit": "mg/kg",
            "source_file": "a.pdf", "reference_moisture_percent": 12,
        }])
        self.assertEqual(report["findings"], [])

    def test_known_regressions_cannot_silently_pass(self):
        for code in ("4a48", "4b1823i"):
            with self.subTest(code=code):
                result = audit_module.audit([{
                    "kennnummer": code, "min_mg_kg": 200, "einheit": "FYT/kg",
                    "source_file": "a.pdf", "reference_moisture_percent": 12,
                }])
                self.assertIn("known_manual_review", result["findings"][0]["issues"])

    def test_empty_limits_need_no_unit(self):
        self.assertEqual(audit_module.audit([{"kennnummer": "x"}])["findings"], [])


if __name__ == "__main__":
    unittest.main()
