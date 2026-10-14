# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The agent `functions` schema decides what a stub can be generated from.

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
from unittest.mock import patch
from pathlib import Path

import yaml
from test_manifest_schema import SERVED_AGENT, SERVED_ENDPOINT, example_environment

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.schema import (
    BUILTIN_TYPE_NAMES,
    SchemaError,
    load_manifest,
    render_violation,
    validate_project,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


class _FunctionsCase(unittest.TestCase):
    def load(self, agent):
        """The parsed agent entry of a manifest holding `agent` and the agent its endpoint serves."""
        entry = {"name": "ExampleAgent", "entrypoint": "agents/example_agent.py"}
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "global_controller.yaml")
            with open(path, "w") as f:
                yaml.safe_dump(
                    {
                        "agents": [{**entry, **agent}, SERVED_AGENT],
                        "endpoint": SERVED_ENDPOINT,
                    },
                    f,
                    sort_keys=False,
                )
            return load_manifest(path).agents[0]

    def violations(self, document):
        with self.assertRaises(SchemaError) as raised:
            self.load(document)
        return raised.exception.violations

    def one(self, document):
        violations = self.violations(document)
        self.assertEqual(len(violations), 1, [render_violation(v) for v in violations])
        return violations[0]


class FunctionsShapeTests(_FunctionsCase):
    def test_an_agent_without_a_name_is_rejected_once(self):
        violation = self.one({"name": None, "functions": [{"name": "work"}]})

        self.assertEqual(violation.field, "agents[0].name")
        self.assertEqual(violation.message, "is required but missing")

    def test_a_key_set_twice_is_rejected_at_the_second(self):
        # Two `name:` keys would otherwise generate a method for whichever came
        # last, with no word about the other.
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "global_controller.yaml")
            Path(path).write_text(
                "agents:\n"
                "  - name: ExampleAgent\n"
                "    entrypoint: agents/example_agent.py\n"
                "    functions:\n"
                "      - name: hello\n"
                "        name: other\n"
            )
            with self.assertRaises(SchemaError) as raised:
                load_manifest(path)

        (violation,) = raised.exception.violations
        self.assertEqual(violation.line, 6)
        self.assertIn("found duplicate key 'name'", violation.message)
        self.assertNotIn("\n", render_violation(violation))

    def test_an_agent_may_declare_no_functions(self):
        for document in ({}, {"functions": []}):
            with self.subTest(document=document):
                self.assertEqual(self.load(document).functions, ())

    def test_a_function_needs_a_name(self):
        violation = self.one({"functions": [{"arguments": []}]})

        self.assertEqual(violation.field, "agents[0].functions[0].name")

    def test_returns_is_optional(self):
        service = self.load({"functions": [{"name": "hello", "arguments": []}]})

        (function,) = service.functions
        self.assertIsNone(function.returns)
        self.assertEqual(function.arguments, ())


class ArgumentTypeTests(_FunctionsCase):
    def _entry(self, type_name):
        return {
            "functions": [
                {
                    "name": "hello",
                    "arguments": [{"name": "value", "type": type_name}],
                }
            ],
        }

    def test_every_builtin_type_is_accepted(self):
        for type_name in sorted(BUILTIN_TYPE_NAMES):
            with self.subTest(type=type_name):
                service = self.load(self._entry(type_name))
                self.assertEqual(service.functions[0].arguments[0].type, type_name)

    def test_a_type_the_stub_cannot_import_is_rejected(self):
        for type_name in (
            "List[str]",
            "MyModel",
            "Str",
            "typing.Any",
            "list[MyModel]",
            "'str'",
            "str(",
            "int[str]",
            "list[int][str]",
            "None | None",
        ):
            with self.subTest(type=type_name):
                violation = self.one(self._entry(type_name))
                self.assertEqual(
                    violation.field, "agents[0].functions[0].arguments[0].type"
                )
                self.assertIn(repr(type_name), violation.message)
                self.assertIn("not built from builtin types", violation.message)

    def test_a_type_built_from_builtins_is_accepted(self):
        for type_name in (
            "list[str]",
            "dict[str, int]",
            "tuple[int, ...]",
            "int | None",
            "None",
        ):
            with self.subTest(type=type_name):
                service = self.load(self._entry(type_name))
                self.assertEqual(service.functions[0].arguments[0].type, type_name)

    def test_the_rejection_names_the_manifest_the_field_and_the_line(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "global_controller.yaml")
            Path(path).write_text(
                "agents:\n"
                "  - name: StateDB\n"
                "    type: database\n"
                "    image: postgres:16-alpine\n"
                "  - name: ExampleAgent\n"
                "    entrypoint: agents/example_agent.py\n"
                "    functions:\n"
                "      - name: hello\n"
                "        arguments:\n"
                "          - name: value\n"
                "            type: List[str]\n"
                "endpoint: {agent: ExampleAgent, method: hello}\n"
            )
            with self.assertRaises(SchemaError) as raised:
                load_manifest(path)

        (violation,) = raised.exception.violations
        rendered = render_violation(violation)
        self.assertTrue(rendered.startswith(f"{path}:11"))
        self.assertIn("agents[1].functions[0].arguments[0].type", rendered)
        self.assertNotIn("\n", rendered)

    def test_an_argument_type_is_optional(self):
        service = self.load(
            {"functions": [{"name": "hello", "arguments": [{"name": "value"}]}]}
        )

        self.assertIsNone(service.functions[0].arguments[0].type)


class GeneratedNameTests(_FunctionsCase):
    """Every name in an agent entry is written into the stub as Python source."""

    def _entry(self, agent="ExampleAgent", function="hello", arguments=()):
        return {
            "name": agent,
            "functions": [{"name": function, "arguments": list(arguments)}],
        }

    def test_a_name_that_is_not_an_identifier_is_rejected(self):
        cases = [
            ("agents[0].name", self._entry(agent="Bad-Agent")),
            ("agents[0].functions[0].name", self._entry(function="bad-name")),
            ("agents[0].functions[0].name", self._entry(function="class")),
            (
                "agents[0].functions[0].arguments[0].name",
                self._entry(arguments=[{"name": "from"}]),
            ),
            (
                "agents[0].functions[0].arguments[0].name",
                self._entry(arguments=[{"name": "my-arg"}]),
            ),
        ]
        for field, document in cases:
            with self.subTest(field=field, document=document):
                violation = self.one(document)
                self.assertEqual(violation.field, field)
                self.assertIn("not a valid Python identifier", violation.message)

    def test_a_name_the_stub_itself_uses_is_rejected(self):
        for name in ("Future", "inspect", "isinstance"):
            for field, document in (
                ("agents[0].name", self._entry(agent=name)),
                (
                    "agents[0].functions[0].arguments[0].name",
                    self._entry(arguments=[{"name": name}]),
                ),
            ):
                with self.subTest(name=name, field=field):
                    violation = self.one(document)
                    self.assertEqual(violation.field, field)
                    self.assertIn("would shadow", violation.message)

    def test_an_argument_named_self_is_rejected(self):
        violation = self.one(self._entry(arguments=[{"name": "self"}]))

        self.assertEqual(violation.field, "agents[0].functions[0].arguments[0].name")

    def test_a_repeated_argument_name_is_rejected(self):
        violation = self.one(self._entry(arguments=[{"name": "a"}, {"name": "a"}]))

        self.assertEqual(violation.field, "agents[0].functions[0].arguments[1].name")


class ValidateProjectTests(unittest.TestCase):
    def _project(self, tmpdir, functions=({"name": "work"},)):
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
                            "functions": list(functions),
                        }
                    ],
                    "endpoint": {
                        "agent": "ExampleAgent",
                        "method": functions[0]["name"],
                    },
                }
            )
        )
        return str(project / "config" / "global_controller.yaml")

    def test_a_valid_project_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            self.assertEqual(validate_project(manifest), ())

    def test_a_missing_entrypoint_does_not_hide_a_broken_function(self):
        # One run finds both problems instead of costing the user a second
        # deploy to see the next one.
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            Path(manifest).write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "functions": [
                                    {
                                        "name": "hello",
                                        "arguments": [{"name": "v", "type": "MyModel"}],
                                    }
                                ],
                            }
                        ],
                        "endpoint": {"agent": "ExampleAgent", "method": "hello"},
                    }
                )
            )
            violations = validate_project(manifest)

        self.assertEqual(
            [v.field for v in violations],
            ["agents[0].entrypoint", "agents[0].functions[0].arguments[0].type"],
        )

    def test_a_functions_violation_is_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(
                tmpdir,
                functions=[
                    {"name": "hello", "arguments": [{"name": "v", "type": "List[str]"}]}
                ],
            )
            violations = validate_project(manifest)

        (violation,) = violations
        self.assertEqual(violation.field, "agents[0].functions[0].arguments[0].type")

    def test_source_dir_is_optional_and_off_by_default(self):
        # 2c calls validate_project without one; nothing on disk is checked.
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            self.assertEqual(validate_project(manifest), ())

    def test_a_declared_entrypoint_must_exist_under_the_source_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            violations = validate_project(manifest, tmpdir)

        (violation,) = violations
        self.assertEqual(violation.field, "agents[0].entrypoint")
        self.assertEqual(
            violation.message,
            f"{os.path.join(tmpdir, 'agents', 'example_agent.py')} does not exist",
        )

    def test_the_missing_file_is_named_the_way_the_manifest_writes_it(self):
        # The build runs from the project root, so that is the form the reader
        # is looking at; an absolute /tmp/... path makes them translate.
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                violations = validate_project(manifest, ".")
            finally:
                os.chdir(cwd)

        (violation,) = violations
        self.assertEqual(
            violation.message,
            f"{os.path.join('agents', 'example_agent.py')} does not exist",
        )

    def test_an_entrypoint_that_is_there_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            Path(tmpdir, "agents", "example_agent.py").write_text("print('ok')\n")
            self.assertEqual(validate_project(manifest, tmpdir), ())

    def test_an_entrypoint_that_resolves_outside_the_project_is_rejected(self):
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            tempfile.TemporaryDirectory() as outside,
        ):
            manifest = self._project(tmpdir)
            Path(outside, "secret.py").write_text("SECRET = 1\n")
            os.symlink(
                os.path.join(outside, "secret.py"),
                os.path.join(tmpdir, "agents", "example_agent.py"),
            )
            violations = validate_project(manifest, tmpdir)

        (violation,) = violations
        self.assertEqual(violation.field, "agents[0].entrypoint")
        self.assertIn("resolves outside the project", violation.message)

    def test_a_symlink_inside_the_project_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            Path(tmpdir, "real_agent.py").write_text("print('ok')\n")
            os.symlink(
                os.path.join(tmpdir, "real_agent.py"),
                os.path.join(tmpdir, "agents", "example_agent.py"),
            )
            self.assertEqual(validate_project(manifest, tmpdir), ())

    def test_a_missing_source_dir_is_one_violation_naming_it(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = self._project(tmpdir)
            source_dir = os.path.join(tmpdir, "app")
            violations = validate_project(manifest, source_dir)

        (violation,) = violations
        self.assertEqual(violation.field, "agents")
        self.assertIn(source_dir, violation.message)
        self.assertIn("does not exist", violation.message)

    def test_every_example_project_validates(self):
        for manifest in sorted(
            glob.glob(str(REPO_ROOT / "examples/*/config/global_controller.yaml"))
        ):
            with (
                self.subTest(project=os.path.relpath(manifest, REPO_ROOT)),
                patch.dict(os.environ, example_environment(manifest)),
            ):
                violations = validate_project(manifest)
                self.assertEqual(
                    violations, (), [render_violation(v) for v in violations]
                )


if __name__ == "__main__":
    unittest.main()
