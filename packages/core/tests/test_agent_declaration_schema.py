"""The agent declaration schema decides what a stub can be generated from.

An argument's `type` is pasted verbatim into the generated stub as an
annotation and the stub imports nothing, so `List[str]` or a project's own
model class produced a module that only failed once the container tried to
import it.
"""

import glob
import os
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.schema import (
    BUILTIN_TYPE_NAMES,
    SchemaError,
    load_agent_declaration,
    render_violation,
    validate_project,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


class _DeclarationCase(unittest.TestCase):
    def load(self, document, filename="example_agent.yaml"):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, filename)
            with open(path, "w") as f:
                yaml.safe_dump(document, f, sort_keys=False)
            return load_agent_declaration(path)

    def violations(self, document):
        with self.assertRaises(SchemaError) as raised:
            self.load(document)
        return raised.exception.violations

    def one(self, document):
        violations = self.violations(document)
        self.assertEqual(len(violations), 1, [render_violation(v) for v in violations])
        return violations[0]


class ExampleDeclarationTests(unittest.TestCase):
    def test_every_example_declaration_loads(self):
        declarations = sorted(glob.glob(str(REPO_ROOT / "examples/*/agents/*.yaml")))
        self.assertTrue(declarations, "no example declarations found")
        for path in declarations:
            with self.subTest(declaration=os.path.relpath(path, REPO_ROOT)):
                declaration = load_agent_declaration(path)
                self.assertTrue(declaration.name)


class DeclarationShapeTests(_DeclarationCase):
    def test_a_declaration_without_an_agent_block_is_rejected(self):
        violations = self.violations({"agents": [{"name": "ExampleAgent"}]})

        self.assertEqual([v.field for v in violations], ["agents", "agent"])
        self.assertIn("did you mean 'agent'?", violations[0].message)
        self.assertIn("is required and must be a mapping", violations[1].message)

    def test_an_agent_without_a_name_is_rejected(self):
        violation = self.one({"agent": {"functions": []}})

        self.assertEqual(violation.field, "agent.name")
        self.assertEqual(violation.message, "is required but missing")

    def test_a_declaration_with_no_functions_is_fine(self):
        declaration = self.load({"agent": {"name": "ExampleAgent"}})

        self.assertEqual(declaration.name, "ExampleAgent")
        self.assertEqual(declaration.functions, ())

    def test_a_function_needs_a_name(self):
        violation = self.one(
            {"agent": {"name": "ExampleAgent", "functions": [{"description": "hi"}]}}
        )

        self.assertEqual(violation.field, "agent.functions[0].name")

    def test_returns_is_optional(self):
        declaration = self.load(
            {
                "agent": {
                    "name": "ExampleAgent",
                    "functions": [{"name": "hello", "arguments": []}],
                }
            }
        )

        (function,) = declaration.functions
        self.assertIsNone(function.returns)
        self.assertEqual(function.description, "")
        self.assertEqual(function.arguments, ())


class ArgumentTypeTests(_DeclarationCase):
    def _declaration(self, type_name):
        return {
            "agent": {
                "name": "ExampleAgent",
                "functions": [
                    {
                        "name": "hello",
                        "arguments": [{"name": "value", "type": type_name}],
                    }
                ],
            }
        }

    def test_every_builtin_type_is_accepted(self):
        for type_name in sorted(BUILTIN_TYPE_NAMES):
            with self.subTest(type=type_name):
                declaration = self.load(self._declaration(type_name))
                self.assertEqual(declaration.functions[0].arguments[0].type, type_name)

    def test_a_type_the_stub_cannot_import_is_rejected(self):
        for type_name in ("List[str]", "MyModel", "Str", "typing.Any"):
            with self.subTest(type=type_name):
                violation = self.one(self._declaration(type_name))
                self.assertEqual(
                    violation.field, "agent.functions[0].arguments[0].type"
                )
                self.assertIn(repr(type_name), violation.message)
                self.assertIn("not a builtin type", violation.message)

    def test_the_rejection_names_the_file_and_the_field(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "example_agent.yaml")
            with open(path, "w") as f:
                yaml.safe_dump(self._declaration("List[str]"), f, sort_keys=False)
            with self.assertRaises(SchemaError) as raised:
                load_agent_declaration(path)

        (violation,) = raised.exception.violations
        rendered = render_violation(violation)
        self.assertTrue(rendered.startswith(f"{path}:"))
        self.assertIn("agent.functions[0].arguments[0].type", rendered)
        self.assertNotIn("\n", rendered)

    def test_an_argument_type_is_optional(self):
        declaration = self.load(
            {
                "agent": {
                    "name": "ExampleAgent",
                    "functions": [{"name": "hello", "arguments": [{"name": "value"}]}],
                }
            }
        )

        self.assertIsNone(declaration.functions[0].arguments[0].type)


class ValidateProjectTests(unittest.TestCase):
    def _project(self, tmpdir, declaration_name="ExampleAgent"):
        project = Path(tmpdir)
        (project / "config").mkdir()
        (project / "agents").mkdir()
        (project / "config" / "global_controller.yaml").write_text(
            yaml.safe_dump(
                {
                    "agents": [
                        {
                            "name": "ExampleAgent",
                            "entrypoint": "agents/example_agent.py",
                        }
                    ]
                }
            )
        )
        (project / "agents" / "example_agent.yaml").write_text(
            yaml.safe_dump({"agent": {"name": declaration_name}})
        )
        return (
            str(project / "config" / "global_controller.yaml"),
            str(project / "agents"),
        )

    def test_a_valid_project_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest, declarations = self._project(tmpdir)
            self.assertEqual(validate_project(manifest, declarations), ())

    def test_a_declaration_naming_a_different_agent_is_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest, declarations = self._project(tmpdir, declaration_name="Typo")
            violations = validate_project(manifest, declarations)

        (violation,) = violations
        self.assertEqual(violation.field, "agents[0].name")
        self.assertIn("agent.name: ExampleAgent", violation.message)

    def test_a_broken_manifest_does_not_hide_a_broken_declaration(self):
        # Both files are checked independently, so one run finds both problems
        # instead of costing the user a second deploy to see the next one.
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest, declarations = self._project(tmpdir)
            Path(manifest).write_text(yaml.safe_dump({"agents": [{"name": "X"}]}))
            Path(declarations, "example_agent.yaml").write_text(
                yaml.safe_dump(
                    {
                        "agent": {
                            "name": "ExampleAgent",
                            "functions": [
                                {
                                    "name": "hello",
                                    "arguments": [{"name": "v", "type": "MyModel"}],
                                }
                            ],
                        }
                    }
                )
            )
            violations = validate_project(manifest, declarations)

        self.assertEqual(
            [v.field for v in violations],
            ["agents[0].entrypoint", "agent.functions[0].arguments[0].type"],
        )
        self.assertEqual(
            {os.path.basename(v.path) for v in violations},
            {"global_controller.yaml", "example_agent.yaml"},
        )

    def test_a_declaration_violation_is_reported_with_the_manifest_intact(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest, declarations = self._project(tmpdir)
            Path(declarations, "example_agent.yaml").write_text(
                yaml.safe_dump(
                    {
                        "agent": {
                            "name": "ExampleAgent",
                            "functions": [
                                {
                                    "name": "hello",
                                    "arguments": [{"name": "v", "type": "List[str]"}],
                                }
                            ],
                        }
                    }
                )
            )
            violations = validate_project(manifest, declarations)

        (violation,) = violations
        self.assertEqual(violation.field, "agent.functions[0].arguments[0].type")

    def test_a_yaml_that_is_not_a_declaration_is_left_alone(self):
        # The .car layout keeps the manifest and policy.yaml in the same
        # directory as the declarations; the build skips them the same way.
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest, declarations = self._project(tmpdir)
            Path(declarations, "policy.yaml").write_text(
                yaml.safe_dump({"rules": [{"service": "ExampleAgent"}]})
            )
            self.assertEqual(validate_project(manifest, declarations), ())

    def test_every_example_project_validates(self):
        for manifest in sorted(
            glob.glob(str(REPO_ROOT / "examples/*/config/global_controller.yaml"))
        ):
            declarations = os.path.join(
                os.path.dirname(os.path.dirname(manifest)), "agents"
            )
            with self.subTest(project=os.path.relpath(manifest, REPO_ROOT)):
                violations = validate_project(manifest, declarations)
                self.assertEqual(
                    violations, (), [render_violation(v) for v in violations]
                )


if __name__ == "__main__":
    unittest.main()
