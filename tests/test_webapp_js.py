"""Führt die Node-Unit-Tests der Web-App aus (tests/js/*.test.mjs).

Getestet werden die OCR-Nachbearbeitung (webapp/js/ocr.js) und die
Futtermitteltyp-Erkennung (webapp/js/labeling.js). Ohne installiertes
Node.js wird der Test übersprungen.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_JS_TEST_DIR = Path(__file__).parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js nicht verfügbar")
def test_webapp_js_units() -> None:
    test_files = sorted(_JS_TEST_DIR.glob("*.test.mjs"))
    assert test_files, f"Keine Node-Testdateien in {_JS_TEST_DIR}"
    result = subprocess.run(
        ["node", "--test", *map(str, test_files)],
        capture_output=True,
        text=True,
        cwd=_JS_TEST_DIR.parent.parent,
        timeout=120,
    )
    assert result.returncode == 0, (
        f"Node-Tests fehlgeschlagen:\n{result.stdout}\n{result.stderr}"
    )
