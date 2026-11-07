"""Evaluate actual merge-job event eligibility without executing workflow code."""

import ast
import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
# Interpreter adapted from venus-os-ci-toolkit/tests/test_metadata_events.py.
def evaluate(expression, context):
    """Interpret the small expression subset used here; reject unknown syntax."""
    expression = expression.removeprefix("${{").removesuffix("}}")

    def value(match):
        values = [context]
        for field in match.group().split("."):
            values = (
                [item for value in values for item in value]
                if field == "*"
                else [v.get(field, "") if isinstance(v, dict) else "" for v in values]
            )
        return repr(values if ".*." in match.group() else values[0])

    expression = re.sub(r"\b(?:github|inputs)(?:\.[\w*-]+)+", value, expression)
    expression = expression.replace("&&", " and ").replace("||", " or ")
    expression = re.sub(r"!(?!=)", " not ", expression)
    expression = re.sub(r"\bnull\b", "None", expression)

    def visit(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, (ast.Dict, ast.List)):
            return ast.literal_eval(node)
        if isinstance(node, ast.BoolOp):
            result = visit(node.values[0])
            for child in node.values[1:]:
                if isinstance(node.op, ast.And):
                    result = visit(child) if result else result
                else:
                    result = result if result else visit(child)
            return result
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not visit(node.operand)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = visit(node.left), visit(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            args = [visit(arg) for arg in node.args]
            if node.func.id == "fromJSON" and len(args) == 1:
                return json.loads(args[0])
            if node.func.id == "contains" and len(args) == 2:
                return args[1] in args[0]
            if node.func.id == "format" and len(args) == 2:
                return args[0].format(args[1])
        raise AssertionError(f"Unsupported metadata expression: {expression}")

    return visit(ast.parse("(" + expression.strip() + ")", mode="eval").body)



class TrustedReviewRoutesTests(unittest.TestCase):
    def setUp(self):
        self.approve = yaml.load((ROOT / ".github/workflows/auto-approve.yml").read_text(), Loader=yaml.BaseLoader)
        self.merge = yaml.load((ROOT / ".github/workflows/auto-merge.yml").read_text(), Loader=yaml.BaseLoader)

    def data(self, event="pull_request_target", author="californiantiramisu", **changes):
        data = {"github": {"event_name": event, "repository": "example/repo", "ref": "refs/heads/main",
                "event": {"action": "synchronize", "changes": {}, "repository": {"default_branch": "main"},
                "pull_request": {"head": {"repo": {"full_name": "example/repo"}}, "base": {"ref": "main"},
                    "user": {"login": author}, "draft": False, "labels": [{"name": "automerge"}]}}}}
        for path, value in changes.items():
            obj = data
            keys = path.split(".")
            for key in keys[:-1]:
                obj = obj[key]
            obj[keys[-1]] = value
        return data

    def test_only_trusted_target_callers_can_approve_and_merge(self):
        for workflow, job in ((self.approve, "auto-approve"), (self.merge, "auto-merge")):
            self.assertNotIn("pull_request", workflow["on"])
            self.assertNotIn("pull_request_review", workflow["on"])
            self.assertNotIn("steps", workflow["jobs"][job])
            expression = workflow["jobs"][job]["if"]
            for author in ("4alvit", "californiantiramisu", "dependabot[bot]", "renovate[bot]"):
                with self.subTest(job=job, author=author):
                    self.assertTrue(evaluate(expression, self.data(author=author)))
                    for event in ("pull_request", "pull_request_review", "push"):
                        self.assertFalse(evaluate(expression, self.data(event=event, author=author)))
                    for mutation in ({"github.ref": "refs/pull/42/merge"},
                                     {"github.event.pull_request.head.repo.full_name": "attacker/fork"},
                                     {"github.event.pull_request.base.ref": "release"}):
                        self.assertFalse(evaluate(expression, self.data(author=author, **mutation)))
            self.assertFalse(evaluate(expression, self.data(author="attacker")))
        self.assertFalse(evaluate(self.approve["jobs"]["auto-approve"]["if"], self.data(**{"github.event.pull_request.draft": True})))

    def test_withdrawals_remain_separate_cancellation_only(self):
        positive = self.merge["jobs"]["auto-merge"]["if"]
        withdrawal = self.merge["jobs"]["withdraw-auto-merge"]
        self.assertEqual(withdrawal["with"], {"withdrawal-only": "true"})
        cases = ({"github.event.action": "unlabeled", "github.event.label": {"name": "automerge"}},
                 {"github.event.action": "converted_to_draft", "github.event.pull_request.draft": True},
                 {"github.event.action": "edited", "github.event.changes.base": {"ref": {"from": "main"}},
                  "github.event.pull_request.base.ref": "release"})
        for mutation in cases:
            with self.subTest(mutation=mutation):
                context = self.data(**mutation)
                self.assertFalse(evaluate(positive, context))
                self.assertTrue(evaluate(withdrawal["if"], context))
                context["github"]["event_name"] = "pull_request"
                self.assertFalse(evaluate(withdrawal["if"], context))

    def test_delayed_approvals_recover_without_long_poll_or_pr_source(self):
        recovery = self.merge["jobs"]["recover-auto-merge"]
        for event in ("workflow_run", "status", "check_run", "schedule", "workflow_dispatch"):
            self.assertIn(event, self.merge["on"])
            self.assertTrue(evaluate(recovery["if"], self.data(event=event)))
            self.assertFalse(evaluate(recovery["if"], self.data(event=event, **{"github.ref": "refs/heads/topic"})))
        for job in (self.merge["jobs"]["auto-merge"], recovery):
            self.assertEqual(job["with"]["reviewed-single-pass"], "true")
            self.assertEqual(job["with"]["reviewed-merge"], "true")
            self.assertEqual(job["with"]["required-status-checks"], "CI gate")
            self.assertNotIn("steps", job)
        self.assertEqual(self.merge["on"]["schedule"], [{"cron": "41 * * * *"}])
        self.assertIn("Auto Approve PRs", self.merge["on"]["workflow_run"]["workflows"])
        self.assertIn("Quality gate", self.merge["on"]["workflow_run"]["workflows"])
        self.assertEqual(recovery["concurrency"]["cancel-in-progress"], "false")


if __name__ == "__main__":
    unittest.main()
