import io
import os
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

import yaml
from packaging.requirements import Requirement

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core import stub_generator
from canyonos_core.stub_generator import (
    BASE_AGENT_REQUIREMENTS,
    BASE_WORKFLOW_REQUIREMENTS,
    PROTOBUF_FLOOR,
    TESTED_MAJOR_VERSIONS,
    _stub_destination,
    _sweep_project_files,
    generate_docker,
    generate_workflow_docker,
)


def _read_requirements(output_dir):
    return (Path(output_dir) / "requirements.txt").read_text().splitlines()


def _read_dockerfile(output_dir):
    return (Path(output_dir) / "Dockerfile").read_text()


class GenerateDockerRequirementsTests(unittest.TestCase):
    def _write_agent_yaml(self, tmpdir, name="ExampleAgent"):
        yaml_path = Path(tmpdir) / f"{name}.yaml"
        yaml_path.write_text(yaml.safe_dump({"agent": {"name": name}}))
        agent_file = Path(tmpdir) / "agent.py"
        agent_file.write_text("print('ok')\n")
        return str(yaml_path), str(agent_file)

    def test_base_only_when_requirements_omitted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path, agent_file = self._write_agent_yaml(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(yaml_path, agent_file, output_dir=output_dir)

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_AGENT_REQUIREMENTS)
        self.assertEqual(
            requirements,
            [
                "grpcio>=1.76.0",
                "protobuf>=6.31.1",
                "redis>=3.5",
            ],
        )
        self.assertNotIn("yfinance", requirements)

    def test_per_agent_requirements_are_appended_to_base(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path, agent_file = self._write_agent_yaml(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                yaml_path, agent_file, output_dir=output_dir, requirements=["yfinance"]
            )

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_AGENT_REQUIREMENTS + ["yfinance"])


class GenerateWorkflowDockerRequirementsTests(unittest.TestCase):
    def _write_workflow_file(self, tmpdir):
        workflow_file = Path(tmpdir) / "workflow.py"
        workflow_file.write_text("print('ok')\n")
        return str(workflow_file)

    def test_base_only_when_requirements_omitted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = self._write_workflow_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_workflow_docker(workflow_file, [], output_dir=output_dir)

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_WORKFLOW_REQUIREMENTS)
        self.assertNotIn("yfinance", requirements)

    def test_per_workflow_requirements_are_appended_to_base(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = self._write_workflow_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_workflow_docker(
                workflow_file, [], output_dir=output_dir, requirements=["yfinance"]
            )

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_WORKFLOW_REQUIREMENTS + ["yfinance"])

    def test_log_entry_is_copied_into_the_workflow_context(self):
        """local_controller.py unconditionally imports log_entry -- if the
        generator's source path for it is wrong, the file is silently skipped
        (a warning, not an error) and the Workflow container fails at import
        time on every deploy, not just when logs_enabled is set."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = self._write_workflow_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_workflow_docker(workflow_file, [], output_dir=output_dir)

            self.assertTrue(
                os.path.isfile(os.path.join(output_dir, "log_entry.py")),
                "log_entry.py was not copied into the workflow's Docker context",
            )
            self.assertTrue(os.path.isfile(os.path.join(output_dir, "log_handler.py")))


class GenerateWorkflowDockerLauncherTests(unittest.TestCase):
    def test_launcher_reports_ready_only_after_the_workflow_port_accepts_connections(
        self,
    ):
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = Path(tmpdir) / "workflow.py"
            workflow_file.write_text("raise RuntimeError('broken')\n")
            output_dir = os.path.join(tmpdir, "out")

            generate_workflow_docker(
                str(workflow_file), [], output_dir=output_dir, api_port=9123
            )

            launcher = (Path(output_dir) / "workflow_launcher.py").read_text()

        self.assertIn(
            "controller = LocalController(port=50051, publish_ready=False)", launcher
        )
        self.assertIn("target=controller.run", launcher)
        self.assertIn('socket.create_connection(("127.0.0.1", 9123)', launcher)
        self.assertIn("controller.mark_ready()", launcher)
        self.assertIn("WORKFLOW_READY_TIMEOUT_SECONDS = 120", launcher)
        # The watcher gives up as failed, not silently: a port that never opens
        # must not leave the deploy waiting on a status nobody wrote.
        watcher = launcher[
            launcher.index("def mark_ready_when_serving") : launcher.index(
                "controller = LocalController("
            )
        ]
        self.assertIn("controller.mark_failed()", watcher)
        self.assertIn("except Exception:", launcher)
        self.assertIn("controller.mark_failed()", launcher)
        self.assertIn("traceback.print_exc()", launcher)
        self.assertIn("sys.exit(1)", launcher)


def _write(path, content="x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


class ProjectSweepTests(unittest.TestCase):
    """The sweep carries the whole project, not only its .py files."""

    def _swept(self, project_dir):
        with redirect_stdout(io.StringIO()):
            return {rel for _, rel in _sweep_project_files(str(project_dir))}

    def _swept_with_output(self, project_dir):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            swept = {rel for _, rel in _sweep_project_files(str(project_dir))}
        return swept, buffer.getvalue()

    def test_non_python_files_are_swept_with_their_layout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "notes.txt")
            _write(project / "pyproject.toml")
            _write(project / "langgraph.json")
            _write(project / "agent.py")
            _write(project / "docs" / "manual.pdf")
            _write(project / "src" / "pkg" / "prompts" / "system.md")

            swept = self._swept(project)

        self.assertEqual(
            swept,
            {
                "notes.txt",
                "pyproject.toml",
                "langgraph.json",
                "agent.py",
                os.path.join("docs", "manual.pdf"),
                os.path.join("src", "pkg", "prompts", "system.md"),
            },
        )

    def test_generated_hidden_and_host_local_paths_are_left_behind(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "keep.txt")
            _write(project / ".env", "OPENAI_API_KEY=real")
            _write(project / ".config" / "settings.json")
            _write(project / "stubs" / "Old.py")
            _write(project / "grpc_stubs" / "old_pb2.py")
            _write(project / "docker_container" / "Agent" / "Dockerfile")
            _write(project / "__pycache__" / "agent.cpython-311.pyc")
            _write(project / "venv" / "lib" / "site.py")
            _write(project / "node_modules" / "left-pad" / "index.js")
            _write(project / "proj.egg-info" / "PKG-INFO")
            _write(project / "compiled.pyc")
            _write(project / "client.pem", "-----BEGIN PRIVATE KEY-----")

            swept = self._swept(project)

        self.assertEqual(swept, {"keep.txt"})

    def test_generated_directory_names_are_only_reserved_at_the_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "stubs" / "Generated.py")
            _write(project / "src" / "stubs" / "handwritten.py")

            swept = self._swept(project)

        self.assertEqual(swept, {os.path.join("src", "stubs", "handwritten.py")})

    def test_symlinks_are_not_followed_and_are_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            outside = Path(tmpdir) / "outside"
            _write(outside / "secret.txt", "not ours")
            project = Path(tmpdir) / "project"
            _write(project / "real.txt")
            (project / "link.txt").symlink_to(project / "real.txt")
            (project / "escape").symlink_to(outside)

            swept, output = self._swept_with_output(project)

        self.assertEqual(swept, {"real.txt"})
        self.assertIn("link.txt", output)
        self.assertIn("escape", output)

    def test_project_requirements_does_not_replace_the_generated_one(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "requirements.txt", "yfinance==0.1\n")
            yaml_path = project / "ExampleAgent.yaml"
            yaml_path.write_text(yaml.safe_dump({"agent": {"name": "ExampleAgent"}}))
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                str(yaml_path),
                str(agent_file),
                output_dir=output_dir,
                project_dir=str(project),
            )

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_AGENT_REQUIREMENTS)

    def test_agent_context_receives_the_swept_project(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            yaml_path = project / "ExampleAgent.yaml"
            yaml_path.write_text(yaml.safe_dump({"agent": {"name": "ExampleAgent"}}))
            agent_file = _write(project / "agent.py", "print('ok')\n")
            _write(project / "data" / "handbook.pdf", "%PDF-1.4")
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                str(yaml_path),
                str(agent_file),
                output_dir=output_dir,
                project_dir=str(project),
            )

            copied = Path(output_dir) / "data" / "handbook.pdf"

            self.assertEqual(copied.read_text(), "%PDF-1.4")

    def test_workflow_context_receives_the_swept_project(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            workflow_file = _write(project / "workflow.py", "print('ok')\n")
            _write(project / "config" / "langgraph.json", "{}")
            output_dir = os.path.join(tmpdir, "out")

            generate_workflow_docker(
                str(workflow_file),
                [],
                output_dir=output_dir,
                project_dir=str(project),
            )

            copied = Path(output_dir) / "config" / "langgraph.json"

            self.assertEqual(copied.read_text(), "{}")

    def test_private_keys_are_recognized_by_armor_not_by_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n")
            _write(project / "server.pem", "-----BEGIN RSA PRIVATE KEY-----\nabc\n")
            _write(project / "keystore.p12", "binary-ish")
            _write(project / "ca.pem", "-----BEGIN CERTIFICATE-----\nabc\n")
            _write(project / "notes.key", "this is a text file about keys")

            swept, output = self._swept_with_output(project)

        self.assertEqual(swept, {"ca.pem", "notes.key"})
        self.assertIn("id_rsa", output)
        self.assertIn("keystore.p12", output)

    def test_skipped_hidden_paths_are_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "agent.py")
            _write(project / ".env", "OPENAI_API_KEY=real")
            _write(project / ".streamlit" / "config.toml")

            swept, output = self._swept_with_output(project)

        self.assertEqual(swept, {"agent.py"})
        self.assertIn(".env", output)
        self.assertIn(".streamlit", output)

    def test_an_oversized_context_is_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "dataset.bin", "x" * 4096)
            _write(project / "agent.py")

            original = stub_generator._LARGE_CONTEXT_BYTES
            stub_generator._LARGE_CONTEXT_BYTES = 1024
            try:
                swept, output = self._swept_with_output(project)
            finally:
                stub_generator._LARGE_CONTEXT_BYTES = original

        self.assertEqual(swept, {"dataset.bin", "agent.py"})
        self.assertIn("dataset.bin", output)

    def test_a_normal_project_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "agent.py")
            _write(project / "notes.txt")
            _write(project / "__pycache__" / "agent.cpython-311.pyc")

            _, output = self._swept_with_output(project)

        self.assertEqual(output, "")

    def test_the_build_context_is_not_swept_into_itself(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            yaml_path = project / "ExampleAgent.yaml"
            yaml_path.write_text(yaml.safe_dump({"agent": {"name": "ExampleAgent"}}))
            agent_file = _write(project / "agent.py", "print('ok')\n")
            # Not docker_container/, so nothing but exclude_dir keeps this out.
            output_dir = project / "build_context"

            generate_docker(
                str(yaml_path),
                str(agent_file),
                output_dir=str(output_dir),
                project_dir=str(project),
            )

            nested = list(output_dir.rglob("build_context"))

        self.assertEqual(nested, [])

    def test_an_empty_file_does_not_break_the_sweep(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            # An empty __init__.py is in nearly every Python project, and it
            # used to make the largest-file bookkeeping compare a path to None.
            _write(project / "src" / "__init__.py", "")
            _write(project / "src" / "agent.py", "print('ok')\n")

            swept = self._swept(project)

        self.assertEqual(
            swept,
            {os.path.join("src", "__init__.py"), os.path.join("src", "agent.py")},
        )

    def test_ordinary_repo_furniture_is_not_reported(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "agent.py")
            _write(project / ".gitignore", "*.pyc")
            _write(project / ".git" / "config")
            _write(project / ".venv" / "pyvenv.cfg")
            _write(project / ".mypy_cache" / "cache.json")

            swept, output = self._swept_with_output(project)

        self.assertEqual(swept, {"agent.py"})
        self.assertEqual(output, "")

    def test_host_local_directories_are_reported_because_they_used_to_ship(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            _write(project / "agent.py")
            # These held .py files that the old .py-only sweep shipped, so
            # dropping them is a behavior change and has to be visible.
            _write(project / "venv" / "lib" / "site.py")
            _write(project / "proj.egg-info" / "PKG-INFO")
            _write(project / "__pycache__" / "agent.cpython-311.pyc")

            swept, output = self._swept_with_output(project)

        self.assertEqual(swept, {"agent.py"})
        self.assertIn("venv", output)
        self.assertIn("proj.egg-info", output)
        self.assertNotIn("__pycache__", output)


class StubDestinationTests(unittest.TestCase):
    """A stub replaces the real module at its entrypoint path, so it is written
    to exactly that one location. A stub that cannot be placed there is an error.
    """

    def test_entrypoint_mapping_is_the_only_destination(self):
        destination = _stub_destination(
            "/stubs/split_agent.py", {"split_agent.py": "agents/split_agent.py"}
        )
        self.assertEqual(destination, "agents/split_agent.py")

    def test_flat_entrypoint_stays_flat(self):
        destination = _stub_destination(
            "/stubs/split_agent.py", {"split_agent.py": "split_agent.py"}
        )
        self.assertEqual(destination, "split_agent.py")

    def test_unmapped_stub_is_an_error(self):
        with self.assertRaises(ValueError):
            _stub_destination("/stubs/split_agent.py", {})

    def test_stub_missing_from_a_populated_map_is_an_error(self):
        with self.assertRaises(ValueError):
            _stub_destination(
                "/stubs/retail_flow_agent.py",
                {"RetailAnalyticsAgent.py": "src/retail_flow_agent.py"},
            )

    def test_unsafe_entrypoint_is_an_error(self):
        with self.assertRaises(ValueError):
            _stub_destination(
                "/stubs/split_agent.py", {"split_agent.py": "../../etc/passwd"}
            )


class GenerateWorkflowDockerStubPlacementTests(unittest.TestCase):
    def test_stub_lands_both_flat_and_at_its_entrypoint_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = Path(tmpdir) / "workflow.py"
            workflow_file.write_text("from agents.split_agent import SplitAgent\n")

            stub_file = Path(tmpdir) / "stubs" / "split_agent.py"
            stub_file.parent.mkdir()
            stub_file.write_text("class SplitAgent:\n    pass\n")

            output_dir = os.path.join(tmpdir, "out")
            generate_workflow_docker(
                str(workflow_file),
                [str(stub_file)],
                output_dir=output_dir,
                stub_entrypoints={"split_agent.py": "agents/split_agent.py"},
            )

            nested_path = Path(output_dir) / "agents" / "split_agent.py"
            flat_path = Path(output_dir) / "split_agent.py"
            self.assertIn("class SplitAgent", nested_path.read_text())
            self.assertIn("class SplitAgent", flat_path.read_text())


class PlatformPinTests(unittest.TestCase):
    """Only protobuf is forced, intersected with whatever bound the app declares."""

    def _context(self, requirements, workflow=False):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            output_dir = os.path.join(tmpdir, "out")
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                if workflow:
                    workflow_file = _write(project / "workflow.py", "print('ok')\n")
                    generate_workflow_docker(
                        str(workflow_file),
                        [],
                        output_dir=output_dir,
                        requirements=requirements,
                    )
                else:
                    yaml_path = project / "ExampleAgent.yaml"
                    yaml_path.write_text(
                        yaml.safe_dump({"agent": {"name": "ExampleAgent"}})
                    )
                    agent_file = _write(project / "agent.py", "print('ok')\n")
                    generate_docker(
                        str(yaml_path),
                        str(agent_file),
                        output_dir=output_dir,
                        requirements=requirements,
                    )
            dockerfile = _read_dockerfile(output_dir)
        written = dockerfile.split("printf '%s\\n' ")[1]
        written = written.split(" > /tmp/overrides.txt")[0]
        notes = [
            line.strip()
            for line in buffer.getvalue().splitlines()
            if line.startswith(("  Note:", "  Warning:"))
        ]
        return [entry.strip("'") for entry in written.split()], notes

    def test_base_requirements_are_ranges_not_exact_pins(self):
        for requirement in BASE_AGENT_REQUIREMENTS:
            with self.subTest(requirement=requirement):
                self.assertNotIn("==", requirement)

    def test_the_protobuf_floor_loads_host_compiled_gencode(self):
        # The host's grpcio-tools 1.76.0 emits *_pb2.py that need protobuf>=6.31.1 at runtime.
        self.assertIn("6.31.1", PROTOBUF_FLOOR.specifier)
        self.assertNotIn("6.31.0", PROTOBUF_FLOOR.specifier)

    def test_only_protobuf_is_forced(self):
        for requirements in (
            [],
            ["streamlit==1.31.1"],
            ["requests==2.28.0", "flask==2.3.3", "grpcio==1.80.0"],
        ):
            with self.subTest(requirements=requirements):
                overrides, notes = self._context(requirements)
                self.assertEqual(overrides, [str(PROTOBUF_FLOOR)])
                self.assertEqual(notes, [])

    def test_an_app_protobuf_bound_is_intersected_with_the_floor(self):
        overrides, _ = self._context(["protobuf>=6.32"])
        self.assertEqual(len(overrides), 1)
        forced = Requirement(overrides[0]).specifier
        self.assertNotIn("6.31.5", forced)
        self.assertIn("6.33.5", forced)

    def test_other_base_packages_are_left_to_the_resolver(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workflow_file = _write(Path(tmpdir) / "workflow.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                generate_workflow_docker(
                    str(workflow_file),
                    [],
                    output_dir=output_dir,
                    requirements=["flask==2.3.3"],
                )
            requirements = _read_requirements(output_dir)

        self.assertIn("flask>=2.3.3", requirements)
        self.assertIn("flask==2.3.3", requirements)

    def test_base_requirements_carry_no_upper_bound(self):
        for requirement in BASE_WORKFLOW_REQUIREMENTS:
            with self.subTest(requirement=requirement):
                self.assertNotIn("<", requirement)

    def test_every_base_package_has_a_tested_major_version(self):
        names = {Requirement(r).name for r in BASE_WORKFLOW_REQUIREMENTS}
        self.assertEqual(names, set(TESTED_MAJOR_VERSIONS))

    def _dockerfile(self, workflow, requirements=None):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                if workflow:
                    wf = _write(project / "workflow.py", "print('ok')\n")
                    generate_workflow_docker(
                        str(wf), [], output_dir=output_dir, requirements=requirements
                    )
                else:
                    yaml_path = project / "ExampleAgent.yaml"
                    yaml_path.write_text(
                        yaml.safe_dump({"agent": {"name": "ExampleAgent"}})
                    )
                    agent = _write(project / "agent.py", "print('ok')\n")
                    generate_docker(
                        str(yaml_path),
                        str(agent),
                        output_dir=output_dir,
                        requirements=requirements,
                    )
            return _read_dockerfile(output_dir)

    def test_the_proxy_gets_its_own_venv_after_the_app_install(self):
        for workflow in (False, True):
            with self.subTest(workflow=workflow):
                dockerfile = self._dockerfile(workflow)
                app_install = dockerfile.index("uv pip install --system")
                proxy_install = dockerfile.index("uv venv /opt/canyonos-proxy")
                self.assertLess(app_install, proxy_install)
                proxy_stage = dockerfile[proxy_install:]
                for pin in stub_generator.PROXY_REQUIREMENTS:
                    self.assertIn(pin, proxy_stage)
                self.assertIn(
                    'if python -c "import boto3" 2>/dev/null; then uv pip install '
                    f"--python /opt/canyonos-proxy/bin/python {stub_generator.PROXY_BEDROCK_REQUIREMENT}; fi",
                    proxy_stage,
                )

    def test_installs_are_held_below_each_images_tested_majors(self):
        for workflow, caps in (
            (False, "'grpcio<2' 'protobuf<7' 'redis<9'"),
            (True, "'grpcio<2' 'protobuf<7' 'redis<9' 'flask<4'"),
        ):
            with self.subTest(workflow=workflow):
                dockerfile = self._dockerfile(workflow)
                self.assertIn(f"printf '%s\\n' {caps} > /tmp/tested.txt", dockerfile)
                self.assertIn(
                    "uv pip install --system -r requirements.txt "
                    "--overrides /tmp/overrides.txt -c /tmp/tested.txt",
                    dockerfile,
                )

    def test_a_package_the_app_asks_newer_for_is_left_uncapped(self):
        dockerfile = self._dockerfile(False, requirements=["protobuf>=7"])
        self.assertIn(
            "printf '%s\\n' 'grpcio<2' 'redis<9' > /tmp/tested.txt", dockerfile
        )

    def test_requirements_above_the_tested_major_are_reported(self):
        self.assertEqual(
            stub_generator.too_new_requirements(
                [
                    "protobuf>=7",
                    "protobuf==7.1",
                    "protobuf==7.*",
                    "protobuf~=7.0",
                    "flask>4",
                    "grpcio>=2",
                ],
                BASE_WORKFLOW_REQUIREMENTS,
            ),
            [
                ("protobuf>=7", "protobuf<7"),
                ("protobuf==7.1", "protobuf<7"),
                ("protobuf==7.*", "protobuf<7"),
                ("protobuf~=7.0", "protobuf<7"),
                ("flask>4", "flask<4"),
                ("grpcio>=2", "grpcio<2"),
            ],
        )

    def test_requirements_that_still_allow_a_tested_version_are_not_reported(self):
        self.assertEqual(
            stub_generator.too_new_requirements(
                ["protobuf>6.9", "protobuf>=6,<8", "redis", "yfinance>=9"],
                BASE_WORKFLOW_REQUIREMENTS,
            ),
            [],
        )

    def test_an_agent_flask_pin_is_not_a_base_package_to_warn_about(self):
        self.assertEqual(stub_generator.too_new_requirements(["flask>=4"]), [])

    def test_agents_no_longer_carry_the_proxys_packages(self):
        for name in ("flask", "requests", "boto3"):
            with self.subTest(name=name):
                self.assertFalse(
                    any(Requirement(r).name == name for r in BASE_AGENT_REQUIREMENTS)
                )

    def test_requirements_below_a_floor_are_reported(self):
        self.assertEqual(
            stub_generator.too_old_requirements(
                [
                    "flask==1.9",
                    "flask<2.3",
                    "flask~=2.2.0",
                    "flask==2.2.*",
                    "protobuf<5",
                ],
                BASE_WORKFLOW_REQUIREMENTS,
            ),
            [
                ("flask==1.9", "flask>=2.3.3"),
                ("flask<2.3", "flask>=2.3.3"),
                ("flask~=2.2.0", "flask>=2.3.3"),
                ("flask==2.2.*", "flask>=2.3.3"),
                ("protobuf<5", "protobuf>=6.31.1"),
            ],
        )

    def test_requirements_that_reach_a_floor_are_not_reported(self):
        self.assertEqual(
            stub_generator.too_old_requirements(
                [
                    "flask~=2.2",
                    "flask>=2",
                    "flask!=2.3.3",
                    "flask==2.3.3",
                    "yfinance==0.1",
                ],
                BASE_WORKFLOW_REQUIREMENTS,
            ),
            [],
        )

    def test_an_agent_may_pin_any_flask_now_the_proxy_has_its_own(self):
        self.assertEqual(stub_generator.too_old_requirements(["flask==1.0"]), [])

    def test_a_repeated_package_is_still_written_line_for_line(self):
        # Combining the bounds is only for the comparison; requirements.txt
        # keeps exactly what the app asked for.
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            yaml_path = project / "ExampleAgent.yaml"
            yaml_path.write_text(yaml.safe_dump({"agent": {"name": "ExampleAgent"}}))
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                generate_docker(
                    str(yaml_path),
                    str(agent_file),
                    output_dir=output_dir,
                    requirements=["protobuf>=7", "Protobuf>=7.1"],
                )
            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements[-2:], ["protobuf>=7", "Protobuf>=7.1"])

    def test_the_workflow_context_decides_the_same_way(self):
        overrides, _ = self._context(["protobuf>=6.32"], workflow=True)
        self.assertEqual(overrides, self._context(["protobuf>=6.32"])[0])

    def test_override_entries_are_quoted_for_the_shell(self):
        # An unquoted `protobuf>=7` would be a redirect, not an argument.
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            yaml_path = project / "ExampleAgent.yaml"
            yaml_path.write_text(yaml.safe_dump({"agent": {"name": "ExampleAgent"}}))
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                generate_docker(
                    str(yaml_path),
                    str(agent_file),
                    output_dir=output_dir,
                    requirements=["protobuf>=6.32"],
                )
            dockerfile = _read_dockerfile(output_dir)

        self.assertIn("'protobuf>=6.31.1,>=6.32'", dockerfile)

    def test_both_dockerfiles_install_with_the_overrides_and_report(self):
        for workflow in (False, True):
            with self.subTest(workflow=workflow):
                with tempfile.TemporaryDirectory() as tmpdir:
                    project = Path(tmpdir)
                    output_dir = os.path.join(tmpdir, "out")
                    with redirect_stdout(io.StringIO()):
                        if workflow:
                            wf = _write(project / "workflow.py", "print('ok')\n")
                            generate_workflow_docker(str(wf), [], output_dir=output_dir)
                        else:
                            yaml_path = project / "ExampleAgent.yaml"
                            yaml_path.write_text(
                                yaml.safe_dump({"agent": {"name": "ExampleAgent"}})
                            )
                            agent = _write(project / "agent.py", "print('ok')\n")
                            generate_docker(
                                str(yaml_path), str(agent), output_dir=output_dir
                            )
                    dockerfile = _read_dockerfile(output_dir)

                install = dockerfile.split("RUN uv pip check")[0]
                self.assertIn("--overrides /tmp/overrides.txt", install)
                self.assertIn("uv pip check --system", dockerfile)
                self.assertIn(str(PROTOBUF_FLOOR), dockerfile.split("NOTE:")[1])


if __name__ == "__main__":
    unittest.main()


class GenerateStubTests(unittest.TestCase):
    """The stub is generated from the declaration the schema checked."""

    def _generate(self, text, env=None):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "hello.yaml"
            yaml_path.write_text(text)
            output_path = Path(tmpdir) / "stubs" / "hello.py"
            with (
                unittest.mock.patch.dict(os.environ, env or {}),
                redirect_stdout(io.StringIO()),
            ):
                source = stub_generator.generate_stub(str(yaml_path), str(output_path))
        compile(source, "hello.py", "exec")
        return source

    def test_a_blank_list_or_type_is_generated_as_absent(self):
        for text in (
            "agent:\n  name: Hello\n  functions:\n",
            "agent:\n  name: Hello\n  functions:\n    - name: hello\n      arguments:\n",
            "agent:\n  name: Hello\n  functions:\n    - name: hello\n"
            "      arguments:\n        - name: a\n          type:\n",
        ):
            with self.subTest(text=text):
                self.assertIn("class Hello(object):", self._generate(text))

    def test_env_references_are_expanded_into_the_stub(self):
        source = self._generate(
            "agent:\n  name: Hello\n  functions:\n    - name: ${STUB_FN_NAME}\n",
            env={"STUB_FN_NAME": "hello"},
        )

        self.assertIn("def hello(self)", source)

    def test_a_type_built_from_builtins_is_written_as_its_annotation(self):
        source = self._generate(
            "agent:\n  name: Hello\n  functions:\n    - name: hello\n"
            "      arguments:\n        - name: a\n          type: dict[str, int] | None\n"
        )

        self.assertIn("def hello(self, a: dict[str, int] | None)", source)
