"""`validate_car` over a prepared `.car`, one fixture per contract it checks."""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.stub_generator import (
    AGENT_FLAT_MODULES,
    IMAGE_PYTHON_VERSION,
    WORKFLOW_FLAT_MODULES,
    generate_docker,
    generate_workflow_docker,
)
from canyonos_core.validate import main, validate_car

REPO_ROOT = Path(__file__).resolve().parents[3]

CONFIG = """\
agents:
  - name: EchoAgent
    entrypoint: agents/echo_agent.py

  - name: Workflow
    type: workflow
    workflow_file: workflow/echo_workflow.py
"""

DECLARATION = """\
agent:
  name: EchoAgent
  functions:
    - name: echo
      arguments:
        - name: text
          type: str
"""

AGENT = """\
class EchoAgent:
    def echo(self, text):
        return text
"""

WORKFLOW = """\
from agents.echo_agent import EchoAgent


def main(query):
    return {"echo": EchoAgent().echo(text=query).value()}


deploy(main, port=8080)
"""

BASE = {
    "config/global_controller.yaml": CONFIG,
    "config/echo_agent.yaml": DECLARATION,
    "app/agents/echo_agent.py": AGENT,
    "app/workflow/echo_workflow.py": WORKFLOW,
}


class ValidateCarTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, True)

    def car(self, files=None):
        """A minimal clean `.car`, with any of its files replaced or added."""
        root = Path(self.tmpdir) / ".car"
        for relative, text in {**BASE, **(files or {})}.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        return str(root)

    def codes(self, files=None):
        return [finding.code for finding in validate_car(self.car(files))]

    # -------------------------------------------------------------- #
    #  Nothing to report                                              #
    # -------------------------------------------------------------- #

    def test_a_minimal_port_is_clean(self):
        self.assertEqual(validate_car(self.car()), [])

    def test_the_helloworld_example_is_clean(self):
        """The shipped example is what a port is meant to look like."""
        example = REPO_ROOT / "examples" / "helloworld"
        root = Path(self.tmpdir) / ".car"
        (root / "config").mkdir(parents=True)
        shutil.copytree(example / "config", root / "config", dirs_exist_ok=True)
        for part in ("agents", "workflow"):
            shutil.copytree(example / part, root / "app" / part)
        for declaration in (root / "app" / "agents").glob("*.yaml"):
            declaration.rename(root / "config" / declaration.name)

        self.assertEqual(validate_car(str(root)), [])

    # -------------------------------------------------------------- #
    #  The adapter the controller loads                               #
    # -------------------------------------------------------------- #

    def test_a_class_not_named_after_the_agent_is_reported(self):
        findings = validate_car(
            self.car({"app/agents/echo_agent.py": "class Echo:\n    pass\n"})
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-CLASS"])
        self.assertIn("no class named `EchoAgent`", findings[0].summary)
        self.assertEqual(
            findings[0].path, os.path.join("app", "agents", "echo_agent.py")
        )

    def test_an_entrypoint_that_does_not_parse_is_reported(self):
        findings = validate_car(
            self.car({"app/agents/echo_agent.py": "class EchoAgent(\n"})
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-CLASS"])

    def test_a_constructor_that_needs_arguments_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def __init__(self, api_key):\n"
                    "        self.api_key = api_key\n\n"
                    "    def echo(self, text):\n"
                    "        return text\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-INIT"])
        self.assertIn("`EchoAgent.__init__` requires api_key", findings[0].summary)

    def test_a_defaulted_constructor_argument_is_fine(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def __init__(self, api_key=None):\n"
                    "        self.api_key = api_key\n\n"
                    "    def echo(self, text):\n"
                    "        return text\n"
                }
            ),
            [],
        )

    def test_a_declared_method_that_does_not_exist_is_reported(self):
        findings = validate_car(
            self.car({"app/agents/echo_agent.py": "class EchoAgent:\n    pass\n"})
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-SIGNATURE"])
        self.assertIn("has no method `echo`", findings[0].summary)

    def test_a_declared_argument_the_method_cannot_take_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def echo(self, message):\n"
                    "        return message\n"
                }
            )
        )

        # The method takes an argument the declaration does not send, and the
        # declaration sends one the method cannot take.
        self.assertEqual(
            [f.code for f in findings],
            ["CAR-ADAPTER-SIGNATURE", "CAR-ADAPTER-SIGNATURE"],
        )
        self.assertIn("has no parameter 'text'", findings[0].summary)
        self.assertIn("requires message", findings[1].summary)

    def test_an_undeclared_parameter_with_a_default_is_fine(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def echo(self, text, times=1):\n"
                    "        return text * times\n"
                }
            ),
            [],
        )

    def test_a_method_inherited_from_a_base_in_the_module_is_found(self):
        """The controller does getattr(agent, name), which walks the MRO."""
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class _Base:\n"
                    "    def echo(self, text):\n"
                    "        return text\n\n\n"
                    "class EchoAgent(_Base):\n"
                    "    pass\n"
                }
            ),
            [],
        )

    def test_an_inherited_method_is_still_checked(self):
        findings = validate_car(
            self.car(
                {
                    "app/agents/echo_agent.py": "class _Base:\n"
                    "    async def echo(self, text):\n"
                    "        return text\n\n\n"
                    "class EchoAgent(_Base):\n"
                    "    pass\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-ASYNC"])
        self.assertEqual(findings[0].line, 2)

    def test_a_method_inherited_from_another_module_is_found(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "from agents.base import Base\n\n\n"
                    "class EchoAgent(Base):\n"
                    "    pass\n",
                    "app/agents/base.py": "class Base:\n"
                    "    def echo(self, text):\n"
                    "        return text\n",
                }
            ),
            [],
        )

    def test_a_base_that_cannot_be_read_does_not_report_a_missing_method(self):
        """A base from an installed package may define it; only the import knows."""
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "from somelib import Base\n\n\n"
                    "class EchoAgent(Base):\n"
                    "    pass\n"
                }
            ),
            [],
        )

    def test_a_method_bound_by_assignment_is_not_reported(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "def _echo(self, text):\n"
                    "    return text\n\n\n"
                    "class EchoAgent:\n"
                    "    echo = _echo\n"
                }
            ),
            [],
        )

    def test_a_class_with_getattr_does_not_report_a_missing_method(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def __getattr__(self, name):\n"
                    "        return lambda text: text\n"
                }
            ),
            [],
        )

    def test_a_method_taking_var_keywords_accepts_every_declared_argument(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    def echo(self, **kwargs):\n"
                    "        return kwargs['text']\n"
                }
            ),
            [],
        )

    def test_an_adapter_imported_into_the_entrypoint_is_found_and_checked(self):
        findings = validate_car(
            self.car(
                {
                    "app/agents/echo_agent.py": "from agents._impl import EchoAgent\n",
                    "app/agents/_impl.py": "class EchoAgent:\n"
                    "    async def echo(self, text):\n"
                    "        return text\n",
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-ASYNC"])
        self.assertEqual(findings[0].path, os.path.join("app", "agents", "_impl.py"))

    def test_an_adapter_imported_relatively_is_found(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "from ._impl import EchoAgent\n",
                    "app/agents/_impl.py": "class EchoAgent:\n"
                    "    def echo(self, text):\n"
                    "        return text\n",
                }
            ),
            [],
        )

    def test_an_adapter_assigned_from_another_class_is_found(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "class _Echo:\n"
                    "    def echo(self, text):\n"
                    "        return text\n\n\n"
                    "EchoAgent = _Echo\n"
                }
            ),
            [],
        )

    def test_an_adapter_bound_by_something_unreadable_is_not_reported(self):
        """A factory call binds the name; only running it would say to what."""
        self.assertEqual(
            self.codes(
                {
                    "app/agents/echo_agent.py": "def build():\n"
                    "    class Echo:\n"
                    "        def echo(self, text):\n"
                    "            return text\n"
                    "    return Echo\n\n\n"
                    "EchoAgent = build()\n"
                }
            ),
            [],
        )

    def test_an_async_method_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/agents/echo_agent.py": "class EchoAgent:\n"
                    "    async def echo(self, text):\n"
                    "        return text\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-ADAPTER-ASYNC"])
        self.assertEqual(findings[0].line, 2)

    # -------------------------------------------------------------- #
    #  The workflow the platform posts to                             #
    # -------------------------------------------------------------- #

    def test_a_workflow_without_main_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "def run(query):\n"
                    "    return query\n\n\n"
                    "deploy(run)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn("no top-level function named `main`", findings[0].summary)

    def test_an_async_main_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "async def main(query):\n"
                    "    return query\n\n\n"
                    "deploy(main)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn("`main` is `async def`", findings[0].summary)

    def test_a_first_parameter_other_than_query_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": 'def main(prompt="hi"):\n'
                    "    return prompt\n\n\n"
                    "deploy(main)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn("first parameter is `prompt`", findings[0].summary)

    def test_a_second_required_parameter_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "def main(query, depth):\n"
                    "    return query * depth\n\n\n"
                    "deploy(main)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn("requires depth beyond `query`", findings[0].summary)

    def test_a_workflow_that_never_deploys_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "def main(query):\n    return query\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn("never calls `deploy(...)`", findings[0].summary)

    def test_deploy_called_through_its_module_is_fine(self):
        self.assertEqual(
            self.codes(
                {
                    "app/workflow/echo_workflow.py": WORKFLOW.replace(
                        "deploy(main, port=8080)",
                        "import deploy\n\ndeploy.deploy(main, port=8080)",
                    )
                }
            ),
            [],
        )

    def test_deploy_imported_under_another_name_is_fine(self):
        self.assertEqual(
            self.codes(
                {
                    "app/workflow/echo_workflow.py": "from deploy import deploy as serve\n"
                    + WORKFLOW.replace(
                        "deploy(main, port=8080)", "serve(main, port=8080)"
                    )
                }
            ),
            [],
        )

    def test_a_main_guard_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "def main(query):\n"
                    "    return query\n\n\n"
                    "deploy(main)\n\n"
                    'if __name__ == "__main__":\n'
                    '    main("hi")\n'
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-SHAPE"])
        self.assertIn('`if __name__ == "__main__":`', findings[0].summary)

    def test_an_import_that_bypasses_the_stub_module_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "from agents import EchoAgent\n\n\n"
                    "def main(query):\n"
                    "    return EchoAgent().echo(text=query).value()\n\n\n"
                    "deploy(main)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-STUB-IMPORT"])
        self.assertIn("agents/echo_agent.py", findings[0].summary)

    def test_the_stub_suffixed_class_name_is_reported(self):
        findings = validate_car(
            self.car(
                {
                    "app/workflow/echo_workflow.py": "from agents.echo_agent import EchoAgentStub\n\n\n"
                    "def main(query):\n"
                    "    return EchoAgentStub().echo(text=query).value()\n\n\n"
                    "deploy(main)\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-WORKFLOW-STUB-IMPORT"])
        self.assertIn("not the class it writes", findings[0].summary)

    def test_a_dot_slash_entrypoint_resolves_to_the_same_stub_module(self):
        """The schema accepts `./agents/x.py`; it is the module `agents.x`."""
        self.assertEqual(
            self.codes(
                {
                    "config/global_controller.yaml": CONFIG.replace(
                        "entrypoint: agents/", "entrypoint: ./agents/"
                    )
                }
            ),
            [],
        )

    def test_the_flat_import_of_a_stub_is_fine(self):
        """The stub is written at the context root under its basename too."""
        self.assertEqual(
            self.codes(
                {
                    "app/workflow/echo_workflow.py": "from echo_agent import EchoAgent\n\n\n"
                    "def main(query):\n"
                    "    return EchoAgent().echo(text=query).value()\n\n\n"
                    "deploy(main)\n"
                }
            ),
            [],
        )

    # -------------------------------------------------------------- #
    #  What the image copies over the port                            #
    # -------------------------------------------------------------- #

    def test_a_module_named_after_the_runtime_is_reported(self):
        findings = validate_car(
            self.car({"app/future.py": "class Future:\n    pass\n"})
        )

        self.assertEqual([f.code for f in findings], ["CAR-FLAT-COLLISION"])
        self.assertEqual(findings[0].path, os.path.join("app", "future.py"))

    def test_a_runtime_name_below_the_source_root_is_fine(self):
        self.assertEqual(self.codes({"app/util/future.py": "x = 1\n"}), [])

    def test_a_package_that_reexports_the_entrypoint_is_reported(self):
        findings = validate_car(
            self.car({"app/agents/__init__.py": "from .echo_agent import EchoAgent\n"})
        )

        self.assertEqual([f.code for f in findings], ["CAR-PACKAGE-REEXPORT"])
        self.assertEqual(findings[0].path, os.path.join("app", "agents", "__init__.py"))

    def test_a_dot_slash_entrypoint_is_checked_for_a_reexport_too(self):
        """`./agents/x.py` puts its stub over the same file `agents/x.py` does."""
        findings = validate_car(
            self.car(
                {
                    "app/agents/__init__.py": "from agents.echo_agent import EchoAgent\n",
                    "config/global_controller.yaml": CONFIG.replace(
                        "entrypoint: agents/", "entrypoint: ./agents/"
                    ),
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-PACKAGE-REEXPORT"])
        self.assertIn("`agents/__init__.py`", findings[0].summary)

    def test_a_package_that_reexports_another_module_is_fine(self):
        self.assertEqual(
            self.codes(
                {
                    "app/agents/__init__.py": "from .helpers import helper\n",
                    "app/agents/helpers.py": "def helper():\n    return 1\n",
                }
            ),
            [],
        )

    # -------------------------------------------------------------- #
    #  Files the manifest points at                                   #
    # -------------------------------------------------------------- #

    def test_a_missing_entrypoint_is_reported(self):
        root = self.car()
        os.remove(os.path.join(root, "app", "agents", "echo_agent.py"))

        findings = validate_car(root)

        self.assertEqual([f.code for f in findings], ["CAR-ENTRYPOINT-MISSING"])
        self.assertEqual(
            findings[0].summary,
            f"agents[0].entrypoint: {os.path.join('app', 'agents', 'echo_agent.py')} "
            "does not exist",
        )
        self.assertEqual(
            findings[0].path, os.path.join("config", "global_controller.yaml")
        )
        self.assertEqual(findings[0].line, 0)

    def test_a_missing_workflow_file_is_reported(self):
        root = self.car()
        os.remove(os.path.join(root, "app", "workflow", "echo_workflow.py"))

        findings = validate_car(root)

        self.assertEqual([f.code for f in findings], ["CAR-ENTRYPOINT-MISSING"])
        self.assertIn("agents[1].workflow_file:", findings[0].summary)

    def test_an_entrypoint_that_resolves_outside_the_source_is_reported(self):
        """The deploy rejects it; validate must not pass what the deploy refuses."""
        root = self.car()
        entrypoint = os.path.join(root, "app", "agents", "echo_agent.py")
        outside = os.path.join(self.tmpdir, "echo_agent.py")
        shutil.move(entrypoint, outside)
        os.symlink(outside, entrypoint)

        findings = validate_car(root)

        self.assertEqual([f.code for f in findings], ["CAR-ENTRYPOINT-OUTSIDE"])
        self.assertIn("agents[0].entrypoint:", findings[0].summary)
        self.assertIn("resolves outside", findings[0].summary)

    def test_a_missing_source_root_is_reported_once(self):
        root = self.car()
        shutil.rmtree(os.path.join(root, "app"))

        findings = validate_car(root)

        self.assertEqual([f.code for f in findings], ["CAR-ENTRYPOINT-MISSING"])
        self.assertIn("no `app/` beside `config/`", findings[0].summary)

    # -------------------------------------------------------------- #
    #  The schema, reported as findings of its own                    #
    # -------------------------------------------------------------- #

    def test_a_schema_violation_surfaces_with_its_file_and_line(self):
        findings = validate_car(
            self.car(
                {
                    "config/echo_agent.yaml": "agent:\n"
                    "  name: EchoAgent\n"
                    "  functions:\n"
                    "    - name: echo\n"
                    "      arguments:\n"
                    "        - name: text\n"
                    "          type: List[str]\n"
                }
            )
        )

        self.assertEqual([f.code for f in findings], ["CAR-SCHEMA"])
        self.assertEqual(findings[0].path, os.path.join("config", "echo_agent.yaml"))
        self.assertEqual(findings[0].line, 7)
        self.assertIn("is not built from builtin types", findings[0].summary)

    def test_a_manifest_that_does_not_check_out_stops_at_the_schema(self):
        """With no model to check, the contracts below it have nothing to run over."""
        findings = validate_car(
            self.car({"config/global_controller.yaml": "agents: not-a-list\n"})
        )

        self.assertEqual({f.code for f in findings}, {"CAR-SCHEMA"})

    # -------------------------------------------------------------- #
    #  The module entry point                                         #
    # -------------------------------------------------------------- #

    def test_the_json_entry_prints_findings_and_exits_one(self):
        root = self.car(
            {
                "app/agents/echo_agent.py": "class EchoAgent:\n"
                "    async def echo(self, text):\n"
                "        return text\n"
            }
        )
        output = io.StringIO()
        with redirect_stdout(output):
            status = main([root, "--json"])

        payload = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(payload["artifact_root"], root)
        self.assertEqual(payload["errors"], 1)
        self.assertEqual(
            sorted(payload["findings"][0]),
            ["code", "line", "mechanism", "path", "summary"],
        )
        self.assertEqual(payload["findings"][0]["code"], "CAR-ADAPTER-ASYNC")

    def test_the_json_entry_exits_zero_on_a_clean_car(self):
        output = io.StringIO()
        with redirect_stdout(output):
            status = main([self.car(), "--json"])

        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["findings"], [])

    def test_the_config_flag_is_read_relative_to_the_artifact(self):
        root = self.car({"config/other.yaml": CONFIG})
        os.remove(os.path.join(root, "config", "global_controller.yaml"))
        output = io.StringIO()
        with redirect_stdout(output):
            status = main([root, "--config", "config/other.yaml", "--json"])

        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["findings"], [])


class RuntimeConstantTests(unittest.TestCase):
    """The facts the flat-collision check reads are the ones the build uses."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, True)

    def _agent_context(self):
        yaml_path = Path(self.tmpdir) / "EchoAgent.yaml"
        yaml_path.write_text("agent:\n  name: EchoAgent\n")
        agent_file = Path(self.tmpdir) / "echo_agent.py"
        agent_file.write_text("class EchoAgent:\n    pass\n")
        output_dir = os.path.join(self.tmpdir, "agent-out")
        with redirect_stdout(io.StringIO()):
            generate_docker(str(yaml_path), str(agent_file), output_dir=output_dir)
        return Path(output_dir)

    def _workflow_context(self):
        workflow_file = Path(self.tmpdir) / "echo_workflow.py"
        workflow_file.write_text("def main(query):\n    return query\n")
        output_dir = os.path.join(self.tmpdir, "workflow-out")
        with redirect_stdout(io.StringIO()):
            generate_workflow_docker(str(workflow_file), [], output_dir=output_dir)
        return Path(output_dir)

    def test_the_agent_image_copies_exactly_its_flat_modules(self):
        context = self._agent_context()

        self.assertTrue(all((context / name).is_file() for name in AGENT_FLAT_MODULES))
        for name in WORKFLOW_FLAT_MODULES - AGENT_FLAT_MODULES:
            self.assertFalse((context / name).exists(), name)

    def test_the_workflow_image_copies_exactly_its_flat_modules(self):
        context = self._workflow_context()

        self.assertTrue(
            all((context / name).is_file() for name in WORKFLOW_FLAT_MODULES)
        )

    def test_both_generated_dockerfiles_are_built_on_the_image_python(self):
        expected = f"FROM python:{IMAGE_PYTHON_VERSION}-slim"

        self.assertIn(expected, (self._agent_context() / "Dockerfile").read_text())
        self.assertIn(expected, (self._workflow_context() / "Dockerfile").read_text())

    def test_the_core_image_is_built_on_the_same_python(self):
        """The image `canyonos validate` falls back to runs the same interpreter."""
        dockerfile = (REPO_ROOT / "packages" / "core" / "Dockerfile").read_text()

        self.assertIn(f"FROM python:{IMAGE_PYTHON_VERSION}-slim", dockerfile)


if __name__ == "__main__":
    unittest.main()
