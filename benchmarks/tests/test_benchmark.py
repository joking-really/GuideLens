"""Unit tests for the GuideLens Visual Accuracy (IoU) Benchmark Harness."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BENCHMARKS_DIR = Path(__file__).resolve().parent.parent
if str(BENCHMARKS_DIR) not in sys.path:
    sys.path.insert(0, str(BENCHMARKS_DIR))

import run_benchmark as bm  # noqa: E402


class TestIoUBenchmark(unittest.TestCase):
    def test_compute_iou_identical_boxes(self) -> None:
        self.assertAlmostEqual(bm.compute_iou([10, 20, 100, 50], [10, 20, 100, 50]), 1.0)

    def test_compute_iou_disjoint_boxes(self) -> None:
        self.assertEqual(bm.compute_iou([0, 0, 50, 50], [100, 100, 50, 50]), 0.0)

    def test_compute_iou_partial_overlap(self) -> None:
        # Box A: [0, 0, 100, 100] (area 10,000)
        # Box B: [50, 0, 100, 100] (area 10,000)
        # Intersection: [50, 0, 50, 100] (area 5,000)
        # Union: 15,000 -> IoU = 1/3
        self.assertAlmostEqual(bm.compute_iou([0, 0, 100, 100], [50, 0, 100, 100]), 1.0 / 3.0, places=5)

    def test_compute_iou_zero_area(self) -> None:
        self.assertEqual(bm.compute_iou([10, 10, 0, 50], [10, 10, 20, 50]), 0.0)

    def test_validate_step_plan_enforces_140_char_rule_and_0_1000_coords(self) -> None:
        valid_plan = {
            "mode": "guide",
            "total_steps": 1,
            "steps": [
                {
                    "step_number": 1,
                    "instruction_line": "Click the Object Selection Tool in the left toolbar, or press W.",
                    "target_name": "Object Selection Tool",
                    "control_type": "Button",
                    "bbox": [12, 185, 28, 32],
                    "confidence": 0.94,
                    "shortcut": "W",
                    "terminal_command": None,
                    "explanation": None,
                }
            ],
        }
        self.assertEqual(bm.validate_step_plan(valid_plan), [])

        long_line_plan = {
            **valid_plan,
            "steps": [{**valid_plan["steps"][0], "instruction_line": "x" * 141}],
        }
        errors = bm.validate_step_plan(long_line_plan)
        self.assertTrue(any("exceeds 140 chars" in e for e in errors))

        out_of_range_plan = {
            **valid_plan,
            "steps": [{**valid_plan["steps"][0], "bbox": [10, 20, 1200, 50]}],
        }
        errors = bm.validate_step_plan(out_of_range_plan)
        self.assertTrue(any("out of 0..1000 range" in e for e in errors))

    def test_sample_cases_pass_release_gate(self) -> None:
        cases = bm.load_and_prepare_cases(bm.CASES_DIR, auto_generate_images=True)
        self.assertGreaterEqual(len(cases), 3)
        report = bm.evaluate_suite(cases, brain="mock", iou_threshold=0.5)
        self.assertTrue(report["suite_passed"])
        self.assertEqual(report["pass_rate"], 1.0)
        self.assertGreaterEqual(report["mean_iou"], 0.70)


if __name__ == "__main__":
    unittest.main()
