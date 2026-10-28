# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import io
import os
import sys
import tempfile
import types
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

from packaging.requirements import Requirement

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core import stub_generator
from canyonos_core.schema import load_manifest
from canyonos_core.stub_generator import (
    BASE_AGENT_REQUIREMENTS,
    PROTOBUF_FLOOR,
    TESTED_MAJOR_VERSIONS,
    UV_IMAGE,
    _stub_destination,
    _sweep_project_files,
    generate_docker,
)


def _read_requirements(output_dir):
    return (Path(output_dir) / "requirements.txt").read_text().splitlines()


def _read_dockerfile(output_dir):
    return (Path(output_dir) / "Dockerfile").read_text()


class GenerateDockerRequirementsTests(unittest.TestCase):
    def _write_agent_file(self, tmpdir):
        agent_file = Path(tmpdir) / "agent.py"
        agent_file.write_text("print('ok')\n")
        return str(agent_file)

    def test_base_only_when_requirements_omitted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agent_file = self._write_agent_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_docker("ExampleAgent", agent_file, output_dir=output_dir)

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
            agent_file = self._write_agent_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                "ExampleAgent",
                agent_file,
                output_dir=output_dir,
                requirements=["yfinance"],
            )

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_AGENT_REQUIREMENTS + ["yfinance"])

    def test_log_entry_is_copied_into_the_agent_context(self):
        """local_controller.py unconditionally imports log_entry -- if the
        generator's source path for it is wrong, the file is silently skipped
        (a warning, not an error) and the container fails at import time on
        every deploy, not just when logs_enabled is set."""
        with tempfile.TemporaryDirectory() as tmpdir:
            agent_file = self._write_agent_file(tmpdir)
            output_dir = os.path.join(tmpdir, "out")

            generate_docker("ExampleAgent", agent_file, output_dir=output_dir)

            self.assertTrue(
                os.path.isfile(os.path.join(output_dir, "log_entry.py")),
                "log_entry.py was not copied into the agent's Docker context",
            )
            self.assertTrue(os.path.isfile(os.path.join(output_dir, "log_handler.py")))


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
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                "ExampleAgent",
                str(agent_file),
                output_dir=output_dir,
                project_dir=str(project),
            )

            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements, BASE_AGENT_REQUIREMENTS)

    def test_agent_context_receives_the_swept_project(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            agent_file = _write(project / "agent.py", "print('ok')\n")
            _write(project / "data" / "handbook.pdf", "%PDF-1.4")
            output_dir = os.path.join(tmpdir, "out")

            generate_docker(
                "ExampleAgent",
                str(agent_file),
                output_dir=output_dir,
                project_dir=str(project),
            )

            copied = Path(output_dir) / "data" / "handbook.pdf"

            self.assertEqual(copied.read_text(), "%PDF-1.4")

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
        self.assertNotIn(".env", output)
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
            agent_file = _write(project / "agent.py", "print('ok')\n")
            # Not docker_container/, so nothing but exclude_dir keeps this out.
            output_dir = project / "build_context"

            generate_docker(
                "ExampleAgent",
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


class GenerateDockerStubPlacementTests(unittest.TestCase):
    def test_stub_lands_both_flat_and_at_its_entrypoint_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agent_file = Path(tmpdir) / "caller_agent.py"
            agent_file.write_text("from agents.split_agent import SplitAgent\n")

            stub_file = Path(tmpdir) / "stubs" / "split_agent.py"
            stub_file.parent.mkdir()
            stub_file.write_text("class SplitAgent:\n    pass\n")

            output_dir = os.path.join(tmpdir, "out")
            generate_docker(
                "CallerAgent",
                str(agent_file),
                output_dir=output_dir,
                stub_files=[str(stub_file)],
                stub_entrypoints={"split_agent.py": "agents/split_agent.py"},
            )

            nested_path = Path(output_dir) / "agents" / "split_agent.py"
            flat_path = Path(output_dir) / "split_agent.py"
            self.assertIn("class SplitAgent", nested_path.read_text())
            self.assertIn("class SplitAgent", flat_path.read_text())


class PlatformPinTests(unittest.TestCase):
    """Only protobuf is forced, intersected with whatever bound the app declares."""

    def _context(self, requirements):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            output_dir = os.path.join(tmpdir, "out")
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                agent_file = _write(project / "agent.py", "print('ok')\n")
                generate_docker(
                    "ExampleAgent",
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

    def test_base_requirements_carry_no_upper_bound(self):
        for requirement in BASE_AGENT_REQUIREMENTS:
            with self.subTest(requirement=requirement):
                self.assertNotIn("<", requirement)

    def test_every_base_package_has_a_tested_major_version(self):
        names = {Requirement(r).name for r in BASE_AGENT_REQUIREMENTS}
        self.assertEqual(names, set(TESTED_MAJOR_VERSIONS))

    def _dockerfile(self, requirements=None):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                agent = _write(project / "agent.py", "print('ok')\n")
                generate_docker(
                    "ExampleAgent",
                    str(agent),
                    output_dir=output_dir,
                    requirements=requirements,
                )
            return _read_dockerfile(output_dir)

    def test_the_gateway_gets_its_own_venv_before_the_app_install(self):
        dockerfile = self._dockerfile()
        app_install = dockerfile.index("uv pip install --system")
        gateway_install = dockerfile.index(
            "uv venv --python 3.12 /opt/canyonos-gateway"
        )
        self.assertLess(gateway_install, app_install)
        gateway_stage = dockerfile[gateway_install:app_install]
        for pin in stub_generator.GATEWAY_REQUIREMENTS:
            self.assertIn(pin, gateway_stage)
        self.assertIn(
            'if python -c "import boto3" 2>/dev/null; then uv pip install '
            f"--python /opt/canyonos-gateway/bin/python {stub_generator.GATEWAY_BEDROCK_REQUIREMENT}; fi",
            dockerfile[app_install:],
        )

    def test_the_image_compiles_bytecode_for_every_install(self):
        dockerfile = self._dockerfile()
        self.assertLess(
            dockerfile.index("ENV UV_COMPILE_BYTECODE=1"),
            dockerfile.index("uv pip install --system"),
        )

    def test_the_image_leaves_the_python_install_unpatched(self):
        self.assertNotIn("RUN python", self._dockerfile())

    def test_installs_are_held_below_the_tested_majors(self):
        dockerfile = self._dockerfile()
        self.assertIn(
            "printf '%s\\n' 'grpcio<2' 'protobuf<7' 'redis<9' > /tmp/tested.txt",
            dockerfile,
        )
        self.assertIn(
            "uv pip install --system -r requirements.txt "
            "--overrides /tmp/overrides.txt -c /tmp/tested.txt",
            dockerfile,
        )

    def test_a_package_the_app_asks_newer_for_is_left_uncapped(self):
        dockerfile = self._dockerfile(requirements=["protobuf>=7"])
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
                    "grpcio>=2",
                ]
            ),
            [
                ("protobuf>=7", "protobuf<7"),
                ("protobuf==7.1", "protobuf<7"),
                ("protobuf==7.*", "protobuf<7"),
                ("protobuf~=7.0", "protobuf<7"),
                ("grpcio>=2", "grpcio<2"),
            ],
        )

    def test_requirements_that_still_allow_a_tested_version_are_not_reported(self):
        self.assertEqual(
            stub_generator.too_new_requirements(
                ["protobuf>6.9", "protobuf>=6,<8", "redis", "yfinance>=9"]
            ),
            [],
        )

    def test_an_agent_flask_pin_is_not_a_base_package_to_warn_about(self):
        self.assertEqual(stub_generator.too_new_requirements(["flask>=4"]), [])

    def test_agents_no_longer_carry_the_gateways_packages(self):
        for name in ("flask", "requests", "boto3"):
            with self.subTest(name=name):
                self.assertFalse(
                    any(Requirement(r).name == name for r in BASE_AGENT_REQUIREMENTS)
                )

    def test_requirements_below_a_floor_are_reported(self):
        self.assertEqual(
            stub_generator.too_old_requirements(
                [
                    "protobuf==6.30",
                    "protobuf<6.31",
                    "protobuf~=6.30.0",
                    "protobuf==6.30.*",
                    "protobuf<5",
                ]
            ),
            [
                ("protobuf==6.30", "protobuf>=6.31.1"),
                ("protobuf<6.31", "protobuf>=6.31.1"),
                ("protobuf~=6.30.0", "protobuf>=6.31.1"),
                ("protobuf==6.30.*", "protobuf>=6.31.1"),
                ("protobuf<5", "protobuf>=6.31.1"),
            ],
        )

    def test_requirements_that_reach_a_floor_are_not_reported(self):
        self.assertEqual(
            stub_generator.too_old_requirements(
                [
                    "protobuf~=6.30",
                    "protobuf>=6",
                    "protobuf!=6.31.1",
                    "protobuf==6.31.1",
                    "yfinance==0.1",
                ]
            ),
            [],
        )

    def test_an_agent_may_pin_any_flask_now_the_gateway_has_its_own(self):
        self.assertEqual(stub_generator.too_old_requirements(["flask==1.0"]), [])

    def test_a_repeated_package_is_still_written_line_for_line(self):
        # Combining the bounds is only for the comparison; requirements.txt
        # keeps exactly what the app asked for.
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                generate_docker(
                    "ExampleAgent",
                    str(agent_file),
                    output_dir=output_dir,
                    requirements=["protobuf>=7", "Protobuf>=7.1"],
                )
            requirements = _read_requirements(output_dir)

        self.assertEqual(requirements[-2:], ["protobuf>=7", "Protobuf>=7.1"])

    def test_override_entries_are_quoted_for_the_shell(self):
        # An unquoted `protobuf>=7` would be a redirect, not an argument.
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            agent_file = _write(project / "agent.py", "print('ok')\n")
            output_dir = os.path.join(tmpdir, "out")
            with redirect_stdout(io.StringIO()):
                generate_docker(
                    "ExampleAgent",
                    str(agent_file),
                    output_dir=output_dir,
                    requirements=["protobuf>=6.32"],
                )
            dockerfile = _read_dockerfile(output_dir)

        self.assertIn("'protobuf>=6.31.1,>=6.32'", dockerfile)

    def test_the_dockerfile_installs_with_the_overrides_and_reports(self):
        dockerfile = self._dockerfile()

        install = dockerfile.split("uv pip check")[0]
        self.assertIn("--overrides /tmp/overrides.txt", install)
        self.assertIn("uv pip check --system", dockerfile)
        self.assertIn(str(PROTOBUF_FLOOR), dockerfile.split("NOTE:")[1])

    def test_uv_is_mounted_into_its_build_steps_not_copied_into_the_image(self):
        dockerfile = self._dockerfile()

        self.assertNotIn("COPY --from", dockerfile)
        for step in dockerfile.split("\nRUN ")[1:]:
            self.assertIn(f"--mount=from={UV_IMAGE},source=/uv,target=/bin/uv", step)


if __name__ == "__main__":
    unittest.main()


class GenerateStubTests(unittest.TestCase):
    """The stub is generated from the `functions` the schema checked."""

    def _generate(self, functions, env=None):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / "global_controller.yaml"
            manifest_path.write_text(
                "agents:\n  - name: Hello\n    entrypoint: hello.py\n    functions:\n"
                + functions
                + "endpoint: {agent: Hello, method: hello}\n"
            )
            output_path = Path(tmpdir) / "stubs" / "hello.py"
            with (
                unittest.mock.patch.dict(os.environ, env or {}),
                redirect_stdout(io.StringIO()),
            ):
                (agent,) = load_manifest(str(manifest_path)).agents
                source = stub_generator.generate_stub(agent, str(output_path))
        compile(source, "hello.py", "exec")
        return source

    def test_a_blank_list_or_type_is_generated_as_absent(self):
        for text in (
            "      - name: hello\n        arguments:\n",
            "      - name: hello\n        arguments:\n          - name: a\n            type:\n",
        ):
            with self.subTest(text=text):
                self.assertIn("class Hello(object):", self._generate(text))

    def test_env_references_are_expanded_into_the_stub(self):
        source = self._generate(
            "      - name: ${STUB_FN_NAME}\n",
            env={"STUB_FN_NAME": "hello"},
        )

        self.assertIn("def hello(self)", source)

    def test_a_type_built_from_builtins_is_written_as_its_annotation(self):
        source = self._generate(
            "      - name: hello\n        arguments:\n"
            "          - name: a\n            type: dict[str, int] | None\n"
        )

        self.assertIn("def hello(self, a: dict[str, int] | None)", source)

    def test_a_call_names_the_agent_the_method_and_the_declared_arguments(self):
        source = self._generate(
            "      - name: hello\n        arguments:\n"
            "          - name: who\n          - name: earlier\n"
        )

        class FakeFuture:
            id = "upstream-id"

            def __init__(self, **kwargs):
                self.kwargs = kwargs

        future_module = types.ModuleType("future")
        future_module.Future = FakeFuture
        namespace = {}
        with unittest.mock.patch.dict(sys.modules, {"future": future_module}):
            exec(compile(source, "hello.py", "exec"), namespace)
        sent = namespace["Hello"]().hello("world", FakeFuture()).kwargs

        self.assertEqual(sent["agent_name"], "Hello")
        self.assertEqual(sent["method"], "hello")
        self.assertEqual(sent["args"]["who"], "world")
        self.assertIsInstance(sent["args"]["earlier"], FakeFuture)


class TargetDockerPlatformTests(unittest.TestCase):
    """An explicit platform wins; otherwise images are built for the platform the
    provider's machines run, or for this Docker daemon's when every replica runs here."""

    def _platform(self, provider, explicit=None):
        daemon = unittest.mock.Mock(returncode=0, stdout="linux/arm64\n", stderr="")
        with (
            unittest.mock.patch(
                "canyonos_core.stub_generator.subprocess.run", return_value=daemon
            ) as run,
            unittest.mock.patch.dict(os.environ),
        ):
            os.environ.pop("CANYONOS_DOCKER_PLATFORM", None)
            if explicit:
                os.environ["CANYONOS_DOCKER_PLATFORM"] = explicit
            return stub_generator.target_docker_platform(provider), run

    def test_an_explicit_platform_wins_over_the_daemons(self):
        platform, run = self._platform("local", explicit="linux/amd64")
        self.assertEqual(platform, "linux/amd64")
        run.assert_not_called()

    def test_replicas_on_this_machine_build_for_the_daemons_platform(self):
        platform, run = self._platform("local")
        self.assertEqual(platform, "linux/arm64")
        run.assert_called_once()

    def test_ec2_builds_for_its_machines_platform(self):
        platform, run = self._platform("EC2")
        self.assertEqual(platform, "linux/amd64")
        run.assert_not_called()

    def test_a_daemon_that_cannot_answer_fails_with_dockers_message(self):
        refused = unittest.mock.Mock(
            returncode=1, stdout="", stderr="Cannot connect to the Docker daemon"
        )
        with (
            unittest.mock.patch(
                "canyonos_core.stub_generator.subprocess.run", return_value=refused
            ),
            unittest.mock.patch.dict(os.environ),
        ):
            os.environ.pop("CANYONOS_DOCKER_PLATFORM", None)
            with self.assertRaisesRegex(RuntimeError, "Cannot connect to the Docker"):
                stub_generator.target_docker_platform("local")
