"""Keep native platform acceptance mandatory in PR and release validation."""

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
PLATFORMS = {"ubuntu-24.04", "windows-2022", "macos-15"}


def workflow(name):
    # BaseLoader preserves GitHub's `on` key and boolean-looking expressions.
    return yaml.load((WORKFLOWS / name).read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


class PlatformAcceptanceTests(unittest.TestCase):
    def test_platforms_are_required_by_existing_pr_and_release_gates(self):
        quality = workflow("quality-gate.yml")
        self.assertIn("pull_request", quality["on"])
        self.assertIn("merge_group", quality["on"])
        self.assertEqual(quality["jobs"]["check-0"]["uses"], "./.github/workflows/package.yml")
        self.assertIn("check-0", quality["jobs"]["gate"]["needs"])
        caller = workflow("package.yml")["jobs"]["platforms"]
        self.assertEqual(caller["uses"], "./.github/workflows/platform-acceptance.yml")
        self.assertNotIn("if", caller)
        self.assertNotIn("continue-on-error", caller)
        release = workflow("release-pipeline.yml")["jobs"]
        self.assertEqual(release["checks"]["uses"], "./.github/workflows/quality-gate.yml")
        self.assertEqual(release["checks"]["with"]["force-full"], "true")
        self.assertIn("checks", release["gate"]["needs"])

    def test_every_native_platform_and_engine_runs_without_failure_suppression(self):
        acceptance = workflow("platform-acceptance.yml")
        self.assertEqual(set(acceptance["on"]), {"workflow_call"})
        self.assertEqual(acceptance["permissions"], {"contents": "read"})
        for name in ("install", "browser"):
            job = acceptance["jobs"][name]
            with self.subTest(job=name):
                self.assertEqual(job["runs-on"], "${{ matrix.os }}")
                self.assertEqual(job["strategy"]["fail-fast"], "false")
                matrix = job["strategy"]["matrix"]
                self.assertEqual(set(matrix["os"]), PLATFORMS)
                self.assertNotIn("exclude", matrix)
                self.assertNotIn("include", matrix)
                self.assertNotIn("if", job)
                self.assertNotIn("continue-on-error", job)
                self.assertLessEqual(int(job["timeout-minutes"]), 25)
                for step in job["steps"]:
                    self.assertNotIn("continue-on-error", step)
        browser = acceptance["jobs"]["browser"]
        self.assertEqual(set(browser["strategy"]["matrix"]["engine"]), {"chromium", "firefox"})
        source = (WORKFLOWS / "platform-acceptance.yml").read_text(encoding="utf-8")
        self.assertNotIn("REPORT_ONLY", source)
        self.assertNotIn("|| true", source)

    def test_actual_installer_viewer_and_planner_are_exercised(self):
        jobs = workflow("platform-acceptance.yml")["jobs"]
        install = "\n".join(step.get("run", "") for step in jobs["install"]["steps"])
        for script in ("test-install-home-assistant.py", "test-public-package.py", "test_package_release.py"):
            self.assertIn(script, install)
        steps = jobs["browser"]["steps"]
        viewer = [step for step in steps if "node scripts/test-browser-stability.cjs" in step.get("run", "")]
        planner = [step for step in steps if "node scripts/test-planner-stability.cjs" in step.get("run", "")]
        self.assertEqual(len(viewer), 2)
        self.assertEqual(len(planner), 1)
        self.assertEqual(viewer[1]["env"]["BROWSER_STABILITY_ROOMS"], "24")
        for step in viewer + planner:
            self.assertIn("HOME_STUDIO_DIAGNOSTICS_DIR", step["env"])
            self.assertIn('if [ "$RUNNER_OS" = Linux ]', step["run"])
        upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(upload["if"], "${{ always() }}")
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        self.assertIn("${{ matrix.os }}", upload["with"]["name"])
        self.assertIn("${{ matrix.engine }}", upload["with"]["name"])


if __name__ == "__main__":
    unittest.main()
