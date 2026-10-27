# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import ast
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core import cli

ENDPOINT = {"agent": "ExampleAgent", "method": "work"}


class CliDeployTests(unittest.TestCase):
    def _fake_controller_module(self, controller):
        module = types.ModuleType("canyonos_core.controller.global_controller")
        module.GlobalController = lambda _config_path: controller
        return module

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.reconciler.providers.EC2._provider.preflight")
    def test_deploy_skips_ec2_preflight_for_local_config(
        self,
        preflight,
        ensure_grpc,
        _run_build,
        _signal_patch,
        _atexit_patch,
    ):
        controller = MagicMock()
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config="config/global_controller.yaml")
        config = {"agents": [{"name": "LocalAgent"}]}

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli.load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli._validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            cli._cmd_deploy(args)

        preflight.assert_not_called()
        ensure_grpc.assert_called_once_with(os.getcwd())
        controller._wait_for_healthy.assert_called_once_with()
        controller.run.assert_called_once_with()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.reconciler.providers.EC2._provider.preflight")
    @patch("canyonos_core.reconciler.providers.Local._provider.preflight")
    def test_deploy_runs_only_the_deployments_providers_preflight(
        self,
        local_preflight,
        ec2_preflight,
        ensure_grpc,
        _run_build,
        _signal_patch,
        _atexit_patch,
    ):
        controller = MagicMock()
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config="config/global_controller.yaml")
        config = {
            "provider": "EC2",
            "agents": [{"name": "Ec2Agent"}, {"name": "Ec2Worker"}],
        }

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli.load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli._validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            cli._cmd_deploy(args)

        ensure_grpc.assert_called_once_with(os.getcwd())
        ec2_preflight.assert_called_once_with()
        local_preflight.assert_not_called()
        controller.run.assert_called_once_with()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.reconciler.providers.EC2._provider.preflight")
    @patch("canyonos_core.reconciler.providers.Local._provider.preflight")
    def test_deploy_treats_a_missing_provider_as_local(
        self,
        local_preflight,
        ec2_preflight,
        _ensure_grpc,
        _run_build,
        _signal_patch,
        _atexit_patch,
    ):
        controller = MagicMock()
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config="config/global_controller.yaml")
        config = {"agents": [{"name": "Agent"}, {"name": "Other"}]}

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli.load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli._validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            cli._cmd_deploy(args)

        local_preflight.assert_called_once_with()
        ec2_preflight.assert_not_called()
        controller.run.assert_called_once_with()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    def test_deploy_exits_with_one_critical_line_when_replicas_never_become_healthy(
        self,
        _ensure_grpc,
        _run_build,
        _signal_patch,
        _atexit_patch,
    ):
        controller = MagicMock()
        controller._wait_for_healthy.side_effect = RuntimeError(
            "Agent replica(s) failed to become healthy within 4s: Broken 0/1"
        )
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config="config/global_controller.yaml")
        config = {"agents": [{"name": "Broken"}]}

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli.load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli._validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
            self.assertLogs("canyonos_core", level="CRITICAL") as logs,
            self.assertRaises(SystemExit) as exit_info,
        ):
            cli._cmd_deploy(args)

        self.assertEqual(exit_info.exception.code, 1)
        self.assertIn("Broken 0/1", "\n".join(logs.output))
        controller.run.assert_not_called()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    def test_deploy_uses_canyon_when_present(
        self, ensure_grpc, _run_build, _signal_patch, _atexit_patch
    ):
        controller = MagicMock()
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config=".canyon/config/global_controller.yaml")

        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli.load_config", return_value={"agents": []}),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli._validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            Path(tmpdir, ".canyon").mkdir()
            cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                cli._cmd_deploy(args)
            finally:
                os.chdir(cwd)

        ensure_grpc.assert_called_once_with(
            os.path.join(os.path.realpath(tmpdir), ".canyon")
        )

    def test_deploy_rejects_a_bad_config_before_it_builds(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "/abs.py",
                                "functions": [{"name": "work"}],
                            }
                        ]
                    }
                )
            )

            with (
                patch("canyonos_core.stub_generator.generate_stub") as generate_stub,
                patch("canyonos_core.cli.subprocess.run") as subprocess_run,
            ):
                cwd = os.getcwd()
                os.chdir(project_dir)
                try:
                    with self.assertLogs("canyonos_core", level="ERROR") as log:
                        with self.assertRaises(SystemExit) as raised:
                            cli._cmd_deploy(SimpleNamespace(config=str(config_path)))
                finally:
                    os.chdir(cwd)

        self.assertEqual(raised.exception.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        self.assertIn("agents[0].entrypoint", log.output[0])
        self.assertNotIn("\n", log.output[0])


class CliBuildTests(unittest.TestCase):
    def _run_build(self, project_dir, buildx_available, platform="linux/amd64"):
        """Run _run_build against project_dir with docker/subprocess calls mocked.

        Returns (docker_calls, generate_docker_mock).
        """
        artifact_root = (
            project_dir / ".canyon"
            if (project_dir / ".canyon").is_dir()
            else project_dir
        )
        config_path = artifact_root / "config" / "global_controller.yaml"
        docker_calls = []

        def fake_run(cmd, **kwargs):
            docker_calls.append(cmd)
            return SimpleNamespace(returncode=0)

        def fake_popen(cmd, **_kwargs):
            docker_calls.append(cmd)
            return SimpleNamespace(
                wait=lambda: 0, communicate=lambda: ("", ""), returncode=0
            )

        with (
            patch(
                "canyonos_core.cli._get_package_dir",
                return_value=str(project_dir / "package"),
            ),
            patch("canyonos_core.cli.glob.glob", return_value=["proto/a.proto"]),
            patch("canyonos_core.stub_generator.generate_docker") as generate_docker,
            patch("canyonos_core.cli.subprocess.run", side_effect=fake_run),
            patch("canyonos_core.cli.subprocess.Popen", side_effect=fake_popen),
            patch("canyonos_core.cli.docker_available", return_value=buildx_available),
            patch(
                "canyonos_core.stub_generator.target_docker_platform",
                return_value=platform,
            ),
        ):
            cwd = os.getcwd()
            os.chdir(project_dir)
            try:
                cli._run_build(str(config_path))([])
            finally:
                os.chdir(cwd)

        return docker_calls, generate_docker

    def _write_two_agent_config(self, project_dir):
        """Scaffold a project with two agents."""
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        (project_dir / "docker").mkdir()
        (project_dir / "docker" / "global-controller.Dockerfile").write_text(
            "FROM scratch\n"
        )
        (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "agents" / "second_agent.py").write_text("print('ok')\n")
        config_path = project_dir / "config" / "global_controller.yaml"
        config_path.write_text(
            yaml.safe_dump(
                {
                    "agents": [
                        {
                            "name": "ExampleAgent",
                            "entrypoint": "agents/example_agent.py",
                            "functions": [{"name": "work"}],
                        },
                        {
                            "name": "SecondAgent",
                            "entrypoint": "agents/second_agent.py",
                            "functions": [{"name": "main"}],
                        },
                    ],
                    "endpoint": ENDPOINT,
                }
            )
        )

    def test_build_warns_on_a_requirement_above_the_tested_major_and_continues(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            self._write_two_agent_config(project_dir)
            config_path = project_dir / "config" / "global_controller.yaml"
            config = yaml.safe_load(config_path.read_text())
            config["agents"][0]["requirements"] = ["protobuf>=7"]
            config_path.write_text(yaml.safe_dump(config))

            with self.assertLogs("canyonos_core", level="WARNING") as logs:
                _, generate_docker = self._run_build(project_dir, buildx_available=True)

        self.assertIn(
            "WARNING:canyonos_core:ExampleAgent currently requires protobuf>=7, "
            "but CanyonOS has only tested protobuf<7; it may not work",
            logs.output,
        )
        self.assertEqual(generate_docker.call_count, 2)

    def test_build_falls_back_to_sequential_docker_build_without_buildx(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            self._write_two_agent_config(project_dir)

            docker_calls, _ = self._run_build(project_dir, buildx_available=False)

        flattened = [" ".join(call) for call in docker_calls]
        self.assertFalse(
            any("global-controller.Dockerfile" in call for call in flattened)
        )
        self.assertEqual(
            sum(call[:2] == ["docker", "build"] for call in docker_calls), 2
        )
        self.assertFalse(
            any(call[:3] == ["docker", "buildx", "bake"] for call in docker_calls)
        )

    def test_build_writes_one_stub_per_agent_at_its_entrypoint(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            self._write_two_agent_config(project_dir)
            (project_dir / "agents" / "sub").mkdir()
            (project_dir / "agents" / "sub" / "nested_agent.py").write_text(
                "print('ok')\n"
            )
            config_path = project_dir / "config" / "global_controller.yaml"
            config = yaml.safe_load(config_path.read_text())
            config["agents"] += [
                {
                    "name": "NestedAgent",
                    "entrypoint": "agents/sub/nested_agent.py",
                    "functions": [
                        {
                            "name": "lookup",
                            "arguments": [{"name": "key", "type": "str"}],
                        }
                    ],
                },
                {"name": "postgres", "type": "database", "image": "postgres:16"},
            ]
            config_path.write_text(yaml.safe_dump(config))

            self._run_build(project_dir, buildx_available=True)

            stubs_dir = project_dir / "stubs"
            stubs = {
                path.relative_to(stubs_dir).as_posix(): ast.parse(path.read_text())
                for path in stubs_dir.rglob("*.py")
            }

        methods = {
            path: [
                f"{cls.name}.{fn.name}({', '.join(a.arg for a in fn.args.args)})"
                for cls in tree.body
                if isinstance(cls, ast.ClassDef)
                for fn in cls.body
                if isinstance(fn, ast.FunctionDef) and fn.name != "__init__"
            ]
            for path, tree in stubs.items()
        }
        self.assertEqual(
            methods,
            {
                "agents/example_agent.py": ["ExampleAgent.work(self)"],
                "agents/sub/nested_agent.py": ["NestedAgent.lookup(self, key)"],
                "agents/second_agent.py": ["SecondAgent.main(self)"],
            },
        )

    def test_build_uses_buildx_bake_when_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            self._write_two_agent_config(project_dir)

            docker_calls, _ = self._run_build(project_dir, buildx_available=True)

            bake_file = project_dir / "docker_container" / "docker-bake.json"
            self.assertTrue(bake_file.is_file())
            with open(bake_file) as f:
                bake_config = json.load(f)

        self.assertEqual(
            sum(call[:2] == ["docker", "build"] for call in docker_calls), 0
        )
        bake_calls = [
            call for call in docker_calls if call[:3] == ["docker", "buildx", "bake"]
        ]
        self.assertEqual(len(bake_calls), 1)
        self.assertIn("--file", bake_calls[0])
        self.assertEqual(
            os.path.realpath(bake_calls[0][bake_calls[0].index("--file") + 1]),
            os.path.realpath(bake_file),
        )

        targets = bake_config["target"]
        self.assertEqual(len(targets), 2)
        self.assertEqual(
            os.path.realpath(targets["exampleagent"]["context"]),
            os.path.realpath(project_dir / "docker_container" / "ExampleAgent"),
        )
        self.assertTrue(os.path.isabs(targets["exampleagent"]["context"]))
        self.assertEqual(targets["exampleagent"]["tags"], ["canyonos-exampleagent"])
        self.assertEqual(targets["exampleagent"]["platforms"], ["linux/amd64"])
        self.assertEqual(targets["exampleagent"]["output"], ["type=docker"])
        self.assertEqual(
            os.path.realpath(targets["secondagent"]["context"]),
            os.path.realpath(project_dir / "docker_container" / "SecondAgent"),
        )
        self.assertEqual(targets["secondagent"]["tags"], ["canyonos-secondagent"])

    def test_build_uses_canyon_when_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            artifact_root = project_dir / ".canyon"
            source_root = artifact_root / "app"
            source_root.mkdir(parents=True)
            self._write_two_agent_config(source_root)
            source_root.joinpath("config").rename(artifact_root / "config")

            _, generate_docker = self._run_build(project_dir, buildx_available=True)

        for call in generate_docker.call_args_list:
            self.assertEqual(
                os.path.realpath(call.kwargs["project_dir"]),
                os.path.realpath(source_root),
            )
        self.assertEqual(
            os.path.realpath(generate_docker.call_args_list[0].kwargs["output_dir"]),
            os.path.realpath(artifact_root / "docker_container" / "ExampleAgent"),
        )

    def test_build_fails_when_stub_cannot_be_generated(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {"name": "NoEntrypointAgent"},
                        ]
                    }
                )
            )

            # The schema gate reports it before the build starts, as one line.
            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit) as raised:
                    self._run_build(project_dir, buildx_available=True)

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("agents[0].entrypoint: is required but missing", log.output[0])

    def _write_requirements_config(self, project_dir):
        """Scaffold one plain agent and two agents with `requirements`."""
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        (project_dir / "docker").mkdir()
        (project_dir / "docker" / "global-controller.Dockerfile").write_text(
            "FROM scratch\n"
        )
        (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "agents" / "vllm_agent.py").write_text("print('ok')\n")
        (project_dir / "agents" / "second_agent.py").write_text("print('ok')\n")

        config_path = project_dir / "config" / "global_controller.yaml"
        config_path.write_text(
            yaml.safe_dump(
                {
                    "agents": [
                        {
                            "name": "ExampleAgent",
                            "entrypoint": "agents/example_agent.py",
                            "functions": [{"name": "work"}],
                        },
                        {
                            "name": "VllmAgent",
                            "entrypoint": "agents/vllm_agent.py",
                            "functions": [{"name": "work"}],
                            "requirements": ["yfinance"],
                        },
                        {
                            "name": "SecondAgent",
                            "entrypoint": "agents/second_agent.py",
                            "functions": [{"name": "main"}],
                            "requirements": ["humanize"],
                        },
                    ],
                    "endpoint": ENDPOINT,
                }
            )
        )

    def test_build_passes_per_agent_requirements_to_generators(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            self._write_requirements_config(project_dir)

            _, generate_docker = self._run_build(project_dir, buildx_available=True)

        requirements_by_agent = {
            os.path.basename(call.kwargs["output_dir"]): call.kwargs["requirements"]
            for call in generate_docker.call_args_list
        }
        self.assertEqual(requirements_by_agent["ExampleAgent"], [])
        self.assertEqual(requirements_by_agent["VllmAgent"], ["yfinance"])
        self.assertEqual(requirements_by_agent["SecondAgent"], ["humanize"])

    def test_build_uses_the_expanded_values_the_schema_validated(self):
        # The schema checks `${AGENT_FILE}` in its expanded form; the build used
        # to re-read the raw YAML and hand the literal to the generators, which
        # then failed on a file called `${AGENT_FILE}`.
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
            (project_dir / "config" / "global_controller.yaml").write_text(
                "agents:\n"
                "  - name: ExampleAgent\n"
                "    entrypoint: ${CANYONOS_TEST_AGENT_FILE}\n"
                "    requirements: ['${CANYONOS_TEST_EXTRA}']\n"
                "    functions: [{name: work}]\n"
                "endpoint: {agent: ExampleAgent, method: work}\n"
            )

            with (
                patch.dict(
                    os.environ,
                    {
                        "CANYONOS_TEST_AGENT_FILE": "agents/example_agent.py",
                        "CANYONOS_TEST_EXTRA": "yfinance",
                    },
                ),
                patch(
                    "canyonos_core.cli._get_package_dir",
                    return_value=str(project_dir / "package"),
                ),
                patch("canyonos_core.stub_generator.generate_stub") as generate_stub,
                patch(
                    "canyonos_core.stub_generator.generate_docker"
                ) as generate_docker,
                patch("canyonos_core.cli.subprocess.run"),
                patch(
                    "canyonos_core.stub_generator.target_docker_platform",
                    return_value="linux/amd64",
                ),
                patch("canyonos_core.cli.docker_available", return_value=False),
            ):
                cwd = os.getcwd()
                os.chdir(project_dir)
                try:
                    cli._run_build(
                        str(project_dir / "config" / "global_controller.yaml")
                    )
                finally:
                    os.chdir(cwd)

        (stub_call,) = generate_stub.call_args_list
        self.assertTrue(
            stub_call.args[1].endswith(os.path.join("agents", "example_agent.py"))
        )
        docker_call = generate_docker.call_args
        self.assertEqual(
            os.path.realpath(docker_call.args[1]),
            os.path.realpath(project_dir / "agents" / "example_agent.py"),
        )
        self.assertEqual(docker_call.kwargs["requirements"], ["yfinance"])

    def test_build_rejects_non_list_requirements(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "agents/example_agent.py",
                                "functions": [{"name": "work"}],
                                "requirements": "boto3",
                            },
                        ]
                    }
                )
            )

            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit):
                    self._run_build(project_dir, buildx_available=True)

        self.assertIn("agents[0].requirements", log.output[0])
        self.assertIn("expected a list of strings", log.output[0])

    def test_build_rejects_a_dependency_pin_the_platform_cannot_meet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
            (project_dir / "agents" / "other_agent.py").write_text("print('ok')\n")
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "agents/example_agent.py",
                                "functions": [{"name": "work"}],
                                "requirements": ["protobuf<5"],
                            },
                            {
                                "name": "OtherAgent",
                                "entrypoint": "agents/other_agent.py",
                                "functions": [{"name": "work"}],
                                "requirements": ["grpcio<1.0"],
                            },
                        ],
                        "endpoint": ENDPOINT,
                    }
                )
            )

            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit):
                    self._run_build(project_dir, buildx_available=True)

        # Both services are reported, so two bad pins take one run to find.
        self.assertIn("ExampleAgent", log.output[0])
        self.assertIn("protobuf<5", log.output[0])
        self.assertIn("OtherAgent", log.output[1])


class BuildStopsBeforeGeneratingAnythingTests(unittest.TestCase):
    """A rejected config must cost nothing: no stub, no protoc, no Docker."""

    def _scaffold(self, project_dir, manifest, write_source=True):
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        if write_source:
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "config" / "global_controller.yaml").write_text(
            yaml.safe_dump(manifest)
        )
        return project_dir / "config" / "global_controller.yaml"

    def _build(self, manifest, write_source=True):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            config_path = self._scaffold(project_dir, manifest, write_source)

            with (
                patch("canyonos_core.stub_generator.generate_stub") as generate_stub,
                patch("canyonos_core.cli.subprocess.run") as subprocess_run,
            ):
                cwd = os.getcwd()
                os.chdir(project_dir)
                try:
                    with self.assertLogs("canyonos_core", level="ERROR") as self.log:
                        with self.assertRaises(SystemExit) as raised:
                            cli._run_build(str(config_path))
                finally:
                    os.chdir(cwd)

        return raised.exception, generate_stub, subprocess_run

    def test_an_invalid_manifest_stops_the_build(self):
        exit_error, generate_stub, subprocess_run = self._build(
            {
                "agents": [
                    {
                        "name": "ExampleAgent",
                        "entrypoint": "agents/example_agent.py",
                        "functions": [{"name": "work"}],
                        "replicas": "2",
                    }
                ]
            },
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()

    def test_an_invalid_function_stops_the_build(self):
        exit_error, generate_stub, subprocess_run = self._build(
            {
                "agents": [
                    {
                        "name": "ExampleAgent",
                        "entrypoint": "agents/example_agent.py",
                        "functions": [
                            {
                                "name": "hello",
                                "arguments": [{"name": "v", "type": "List"}],
                            }
                        ],
                    }
                ]
            },
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()

    def test_an_entrypoint_with_no_file_behind_it_stops_the_build(self):
        # This used to log "Agent file not found", skip the service and let the
        # deploy exit 0 without it.
        exit_error, generate_stub, subprocess_run = self._build(
            {
                "agents": [
                    {
                        "name": "ExampleAgent",
                        "entrypoint": "agents/example_agent.py",
                        "functions": [{"name": "work"}],
                    }
                ],
                "endpoint": ENDPOINT,
            },
            write_source=False,
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        self.assertIn("agents[0].entrypoint", self.log.output[0])
        self.assertIn("example_agent.py does not exist", self.log.output[0])
        self.assertNotIn("\n", self.log.output[0])

    def test_a_missing_source_root_stops_the_build_once(self):
        # Under the .canyon layout the app's code lives in .canyon/app; without it
        # the build found nothing to do and said "No Docker images to build."
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            artifact_root = project_dir / ".canyon"
            (artifact_root / "config").mkdir(parents=True)
            config_path = artifact_root / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "agents/example_agent.py",
                                "functions": [{"name": "work"}],
                            }
                        ],
                        "endpoint": ENDPOINT,
                    }
                )
            )

            with (
                patch("canyonos_core.stub_generator.generate_stub") as generate_stub,
                patch("canyonos_core.cli.subprocess.run") as subprocess_run,
            ):
                cwd = os.getcwd()
                os.chdir(project_dir)
                try:
                    with self.assertLogs("canyonos_core", level="ERROR") as log:
                        with self.assertRaises(SystemExit) as raised:
                            cli._run_build(str(config_path))
                finally:
                    os.chdir(cwd)

        self.assertEqual(raised.exception.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        # One violation naming the directory, not one per service.
        self.assertEqual(len(log.output), 2)
        self.assertIn("agents: the project source directory", log.output[0])
        self.assertIn(os.path.join(".canyon", "app"), log.output[0])


class CliCleanTests(unittest.TestCase):
    def test_clean_uses_canyon_when_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / ".canyon" / "stubs").mkdir(parents=True)
            (project_dir / "stubs").mkdir()
            cwd = os.getcwd()
            os.chdir(project_dir)
            try:
                cli._cmd_clean(SimpleNamespace())
            finally:
                os.chdir(cwd)

            self.assertFalse((project_dir / ".canyon" / "stubs").exists())
            self.assertTrue((project_dir / "stubs").exists())


if __name__ == "__main__":
    unittest.main()


class ValidateOrExitTests(unittest.TestCase):
    def test_the_manifest_is_parsed_once(self):
        from canyonos_core import schema
        from canyonos_core.cli import _validate_or_exit

        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = os.path.join(tmpdir, "global_controller.yaml")
            with open(manifest_path, "w") as f:
                f.write(
                    "agents:\n  - name: StateDB\n    type: database\n"
                    "    image: postgres:16-alpine\n"
                    "  - name: ExampleAgent\n    entrypoint: agents/example_agent.py\n"
                    "    functions: [{name: work}]\n"
                    "endpoint: {agent: ExampleAgent, method: work}\n"
                )
            with patch.object(
                schema, "load_manifest", wraps=schema.load_manifest
            ) as load_manifest:
                manifest = _validate_or_exit(manifest_path)

        self.assertEqual(load_manifest.call_count, 1)
        self.assertEqual(manifest.agents[0].name, "StateDB")
