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


class CliDeployTests(unittest.TestCase):
    def _fake_controller_module(self, controller):
        module = types.ModuleType("canyonos_core.controller.global_controller")
        module.GlobalController = lambda _config_path: controller
        return module

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.cli._preflight_ec2_deploy")
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
        config = {"agents": [{"name": "LocalAgent", "provider": "local"}]}

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli._load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli.validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            cli.cmd_deploy(args)

        preflight.assert_not_called()
        ensure_grpc.assert_called_once_with(os.getcwd())
        controller._wait_for_healthy.assert_called_once_with()
        controller.run.assert_called_once_with()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.cli._preflight_ec2_deploy")
    def test_deploy_runs_ec2_preflight_for_ec2_config(
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
        config = {"agents": [{"name": "Ec2Agent", "provider": "EC2"}]}

        with (
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli._load_config", return_value=config),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli.validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            cli.cmd_deploy(args)

        ensure_grpc.assert_called_once_with(os.getcwd())
        preflight.assert_called_once_with(config, os.getcwd())
        controller.run.assert_called_once_with()

    @patch("atexit.register")
    @patch("signal.signal")
    @patch("canyonos_core.cli._run_build")
    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.cli._preflight_ec2_deploy")
    def test_deploy_uses_car_when_present(
        self, preflight, ensure_grpc, _run_build, _signal_patch, _atexit_patch
    ):
        controller = MagicMock()
        controller_module = self._fake_controller_module(controller)
        args = SimpleNamespace(config=".car/config/global_controller.yaml")

        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch("canyonos_core.cli.os.path.isfile", return_value=True),
            patch("canyonos_core.cli._load_config", return_value={"agents": []}),
            patch("canyonos_core.cli.resolve_env_file", return_value=None),
            patch("canyonos_core.cli.validate_or_exit"),
            patch.dict(
                sys.modules,
                {"canyonos_core.controller.global_controller": controller_module},
            ),
        ):
            Path(tmpdir, ".car").mkdir()
            cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                cli.cmd_deploy(args)
            finally:
                os.chdir(cwd)

        ensure_grpc.assert_called_once_with(
            os.path.join(os.path.realpath(tmpdir), ".car")
        )
        preflight.assert_not_called()

    @patch("canyonos_core.cli._ensure_grpc_stubs_importable")
    @patch("canyonos_core.cli._require_docker_for_ec2")
    def test_preflight_does_not_require_ssh_fields(self, require_docker, ensure_grpc):
        config = {
            "ec2": {
                "ami_id": "ami-123",
                "subnet_id": "subnet-123",
                "security_group_ids": ["sg-123"],
                "region": "us-east-1",
            }
        }

        cli._preflight_ec2_deploy(config, os.getcwd())

        require_docker.assert_called_once_with("deploy")
        ensure_grpc.assert_called_once_with(os.getcwd())

    def test_deploy_rejects_a_bad_config_before_it_builds(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {"agents": [{"name": "ExampleAgent", "entrypoint": "/abs.py"}]}
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
                            cli.cmd_deploy(SimpleNamespace(config=str(config_path)))
                finally:
                    os.chdir(cwd)

        self.assertEqual(raised.exception.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        self.assertIn("agents[0].entrypoint", log.output[0])
        self.assertNotIn("\n", log.output[0])

    def test_load_config_accepts_gpu_zero_but_not_negative_resources(self):
        """The CLI's resource picker writes `gpu: 0` for agents without a GPU."""

        def load(resources):
            with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "A",
                                "entrypoint": "agents/a.py",
                                "resources": resources,
                            }
                        ]
                    },
                    f,
                )
            try:
                return cli._load_config(f.name)
            finally:
                os.unlink(f.name)

        config = load({"cpu": 1, "memory": 256, "gpu": 0})
        self.assertEqual(config["agents"][0]["resources"]["gpu"], 0)

        with self.assertRaisesRegex(RuntimeError, "`gpu` must be 0 or more"):
            load({"gpu": -1})
        with self.assertRaisesRegex(RuntimeError, "`cpu` must be a positive number"):
            load({"cpu": 0})


class CliBuildTests(unittest.TestCase):
    def _run_build(
        self, project_dir, agent_yaml_paths, buildx_available, platform="linux/amd64"
    ):
        """Run _run_build against project_dir with docker/subprocess calls mocked.

        Returns (docker_calls, generate_docker_mock, generate_workflow_docker_mock).
        """
        artifact_root = (
            project_dir / ".car" if (project_dir / ".car").is_dir() else project_dir
        )
        config_path = artifact_root / "config" / "global_controller.yaml"
        docker_calls = []

        def fake_run(cmd, check):
            docker_calls.append(cmd)
            return SimpleNamespace(returncode=0)

        def fake_glob(pattern):
            if pattern.endswith("*.proto"):
                return ["proto/a.proto"]
            if agent_yaml_paths:
                self.assertEqual(
                    os.path.realpath(Path(pattern).parent),
                    os.path.realpath(Path(agent_yaml_paths[0]).parent),
                )
            return agent_yaml_paths

        def fake_generate_stub(yaml_path, _output_path):
            with open(yaml_path) as f:
                self.assertIn("agent", yaml.safe_load(f))

        with (
            patch(
                "canyonos_core.cli._get_package_dir",
                return_value=str(project_dir / "package"),
            ),
            patch("canyonos_core.cli.glob.glob", side_effect=fake_glob),
            patch(
                "canyonos_core.stub_generator.generate_stub",
                side_effect=fake_generate_stub,
            ),
            patch("canyonos_core.stub_generator.generate_docker") as generate_docker,
            patch(
                "canyonos_core.stub_generator.generate_workflow_docker"
            ) as generate_workflow_docker,
            patch("canyonos_core.cli.subprocess.run", side_effect=fake_run),
            patch("canyonos_core.cli._docker_available", return_value=buildx_available),
            patch("canyonos_core.cli._docker_platform", return_value=platform),
        ):
            cwd = os.getcwd()
            os.chdir(project_dir)
            try:
                cli._run_build(str(config_path))
            finally:
                os.chdir(cwd)

        return docker_calls, generate_docker, generate_workflow_docker

    def _write_agent_and_workflow_config(self, project_dir):
        """Scaffold a project with one agent + one workflow entry; returns the agent YAML path."""
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        (project_dir / "workflows").mkdir()
        (project_dir / "docker").mkdir()
        (project_dir / "docker" / "global-controller.Dockerfile").write_text(
            "FROM scratch\n"
        )
        (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "workflows" / "example_workflow.py").write_text("print('ok')\n")
        agent_yaml = project_dir / "agents" / "example_agent.yaml"
        agent_yaml.write_text("agent:\n  name: ExampleAgent\n")
        config_path = project_dir / "config" / "global_controller.yaml"
        config_path.write_text(
            yaml.safe_dump(
                {
                    "agents": [
                        {
                            "name": "ExampleAgent",
                            "entrypoint": "agents/example_agent.py",
                            "provider": "local",
                        },
                        {
                            "name": "Workflow",
                            "type": "workflow",
                            "workflow_file": "workflows/example_workflow.py",
                            "provider": "local",
                        },
                    ]
                }
            )
        )
        return agent_yaml

    def test_build_stops_on_a_workflow_requirement_below_the_supported_floor(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            agent_yaml = self._write_agent_and_workflow_config(project_dir)
            config_path = project_dir / "config" / "global_controller.yaml"
            config = yaml.safe_load(config_path.read_text())
            config["agents"][0]["requirements"] = ["flask==1.9"]
            config["agents"][1]["requirements"] = ["flask==1.9"]
            config_path.write_text(yaml.safe_dump(config))

            with (
                self.assertRaises(SystemExit),
                self.assertLogs("canyonos_core", level="ERROR") as logs,
            ):
                self._run_build(project_dir, [str(agent_yaml)], buildx_available=True)

        self.assertEqual(
            logs.output,
            [
                "ERROR:canyonos_core:Workflow currently requires flask==1.9, "
                "but CanyonOS only supports flask>=2.3.3"
            ],
        )

    def test_build_warns_on_a_requirement_above_the_tested_major_and_continues(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            agent_yaml = self._write_agent_and_workflow_config(project_dir)
            config_path = project_dir / "config" / "global_controller.yaml"
            config = yaml.safe_load(config_path.read_text())
            config["agents"][0]["requirements"] = ["protobuf>=7"]
            config_path.write_text(yaml.safe_dump(config))

            with self.assertLogs("canyonos_core", level="WARNING") as logs:
                _, generate_docker, _ = self._run_build(
                    project_dir, [str(agent_yaml)], buildx_available=True
                )

        self.assertIn(
            "WARNING:canyonos_core:ExampleAgent currently requires protobuf>=7, "
            "but CanyonOS has only tested protobuf<7; it may not work",
            logs.output,
        )
        generate_docker.assert_called_once()

    def test_build_falls_back_to_sequential_docker_build_without_buildx(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            agent_yaml = self._write_agent_and_workflow_config(project_dir)

            docker_calls, _, _ = self._run_build(
                project_dir, [str(agent_yaml)], buildx_available=False
            )

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

    def test_build_uses_buildx_bake_when_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            agent_yaml = self._write_agent_and_workflow_config(project_dir)

            docker_calls, _, _ = self._run_build(
                project_dir, [str(agent_yaml)], buildx_available=True
            )

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
            os.path.realpath(targets["workflow"]["context"]),
            os.path.realpath(project_dir / "docker_container" / "Workflow"),
        )
        self.assertEqual(targets["workflow"]["tags"], ["canyonos-workflow"])

    def test_build_uses_car_when_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            artifact_root = project_dir / ".car"
            source_root = artifact_root / "app"
            source_root.mkdir(parents=True)
            source_yaml = self._write_agent_and_workflow_config(source_root)
            source_root.joinpath("config").rename(artifact_root / "config")
            agent_yaml = artifact_root / "config" / source_yaml.name
            source_yaml.rename(agent_yaml)

            manifest = artifact_root / "config" / "global_controller.yaml"
            _, generate_docker, generate_workflow_docker = self._run_build(
                project_dir, [str(manifest), str(agent_yaml)], buildx_available=True
            )

        for call in (generate_docker, generate_workflow_docker):
            self.assertEqual(
                os.path.realpath(call.call_args.kwargs["project_dir"]),
                os.path.realpath(source_root),
            )
        self.assertEqual(
            os.path.realpath(generate_docker.call_args.kwargs["output_dir"]),
            os.path.realpath(artifact_root / "docker_container" / "ExampleAgent"),
        )

    def test_build_with_no_agents_builds_nothing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(yaml.safe_dump({"agents": []}))

            docker_calls, _, _ = self._run_build(project_dir, [], buildx_available=True)

        self.assertFalse(any(call[0] == "docker" for call in docker_calls))

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
                            {"name": "NoEntrypointAgent", "provider": "local"},
                        ]
                    }
                )
            )

            # The schema gate reports it before the build starts, as one line.
            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit) as raised:
                    self._run_build(project_dir, [], buildx_available=True)

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("agents[0].entrypoint: is required but missing", log.output[0])

    def _write_requirements_config(self, project_dir):
        """Scaffold one plain agent, one agent with `requirements`, one workflow with `requirements`."""
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        (project_dir / "workflows").mkdir()
        (project_dir / "docker").mkdir()
        (project_dir / "docker" / "global-controller.Dockerfile").write_text(
            "FROM scratch\n"
        )
        (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "agents" / "vllm_agent.py").write_text("print('ok')\n")
        (project_dir / "workflows" / "example_workflow.py").write_text("print('ok')\n")

        example_yaml = project_dir / "agents" / "example_agent.yaml"
        example_yaml.write_text("agent:\n  name: ExampleAgent\n")
        vllm_yaml = project_dir / "agents" / "vllm_agent.yaml"
        vllm_yaml.write_text("agent:\n  name: VllmAgent\n")

        config_path = project_dir / "config" / "global_controller.yaml"
        config_path.write_text(
            yaml.safe_dump(
                {
                    "agents": [
                        {
                            "name": "ExampleAgent",
                            "entrypoint": "agents/example_agent.py",
                            "provider": "local",
                        },
                        {
                            "name": "VllmAgent",
                            "entrypoint": "agents/vllm_agent.py",
                            "provider": "local",
                            "requirements": ["yfinance"],
                        },
                        {
                            "name": "Workflow",
                            "type": "workflow",
                            "workflow_file": "workflows/example_workflow.py",
                            "provider": "local",
                            "requirements": ["sqlalchemy-utils"],
                        },
                    ]
                }
            )
        )
        return [str(example_yaml), str(vllm_yaml)]

    def test_build_passes_per_agent_requirements_to_generators(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            agent_yamls = self._write_requirements_config(project_dir)

            _, generate_docker, generate_workflow_docker = self._run_build(
                project_dir, agent_yamls, buildx_available=True
            )

        requirements_by_agent = {
            os.path.basename(call.kwargs["output_dir"]): call.kwargs["requirements"]
            for call in generate_docker.call_args_list
        }
        self.assertEqual(requirements_by_agent["ExampleAgent"], [])
        self.assertEqual(requirements_by_agent["VllmAgent"], ["yfinance"])

        self.assertEqual(
            generate_workflow_docker.call_args.kwargs["requirements"],
            ["sqlalchemy-utils"],
        )

    def test_build_uses_the_expanded_values_the_schema_validated(self):
        # The schema checks `${AGENT_FILE}` in its expanded form; the build used
        # to re-read the raw YAML and hand the literal to the generators, which
        # then failed on a file called `${AGENT_FILE}`.
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
            example_yaml = project_dir / "agents" / "example_agent.yaml"
            example_yaml.write_text("agent:\n  name: ExampleAgent\n")
            (project_dir / "config" / "global_controller.yaml").write_text(
                "agents:\n"
                "  - name: ExampleAgent\n"
                "    entrypoint: ${CANYONOS_TEST_AGENT_FILE}\n"
                "    requirements: ['${CANYONOS_TEST_EXTRA}']\n"
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
                patch("canyonos_core.cli._docker_available", return_value=False),
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
            example_yaml = project_dir / "agents" / "example_agent.yaml"
            example_yaml.write_text("agent:\n  name: ExampleAgent\n")
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "agents/example_agent.py",
                                "provider": "local",
                                "requirements": "boto3",
                            },
                        ]
                    }
                )
            )

            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit):
                    self._run_build(
                        project_dir, [str(example_yaml)], buildx_available=True
                    )

        self.assertIn("agents[0].requirements", log.output[0])
        self.assertIn("expected a list of strings", log.output[0])

    def test_build_rejects_a_dependency_pin_the_platform_cannot_meet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / "config").mkdir()
            (project_dir / "agents").mkdir()
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
            (project_dir / "agents" / "other_agent.py").write_text("print('ok')\n")
            example_yaml = project_dir / "agents" / "example_agent.yaml"
            example_yaml.write_text("agent:\n  name: ExampleAgent\n")
            other_yaml = project_dir / "agents" / "other_agent.yaml"
            other_yaml.write_text("agent:\n  name: OtherAgent\n")
            config_path = project_dir / "config" / "global_controller.yaml"
            config_path.write_text(
                yaml.safe_dump(
                    {
                        "agents": [
                            {
                                "name": "ExampleAgent",
                                "entrypoint": "agents/example_agent.py",
                                "requirements": ["protobuf<5"],
                            },
                            {
                                "name": "OtherAgent",
                                "entrypoint": "agents/other_agent.py",
                                "requirements": ["grpcio<1.0"],
                            },
                        ]
                    }
                )
            )

            with self.assertLogs("canyonos_core", level="ERROR") as log:
                with self.assertRaises(SystemExit):
                    self._run_build(
                        project_dir,
                        [str(example_yaml), str(other_yaml)],
                        buildx_available=True,
                    )

        # Both services are reported, so two bad pins take one run to find.
        self.assertIn("ExampleAgent", log.output[0])
        self.assertIn("protobuf<5", log.output[0])
        self.assertIn("OtherAgent", log.output[1])


class BuildStopsBeforeGeneratingAnythingTests(unittest.TestCase):
    """A rejected config must cost nothing: no stub, no protoc, no Docker."""

    def _scaffold(self, project_dir, manifest, declaration, write_source=True):
        (project_dir / "config").mkdir()
        (project_dir / "agents").mkdir()
        if write_source:
            (project_dir / "agents" / "example_agent.py").write_text("print('ok')\n")
        (project_dir / "agents" / "example_agent.yaml").write_text(
            yaml.safe_dump(declaration)
        )
        (project_dir / "config" / "global_controller.yaml").write_text(
            yaml.safe_dump(manifest)
        )
        return project_dir / "config" / "global_controller.yaml"

    def _build(self, manifest, declaration, write_source=True):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            config_path = self._scaffold(
                project_dir, manifest, declaration, write_source
            )

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
                        "replicas": "2",
                    }
                ]
            },
            {"agent": {"name": "ExampleAgent"}},
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()

    def test_an_invalid_declaration_stops_the_build(self):
        exit_error, generate_stub, subprocess_run = self._build(
            {
                "agents": [
                    {"name": "ExampleAgent", "entrypoint": "agents/example_agent.py"}
                ]
            },
            {
                "agent": {
                    "name": "ExampleAgent",
                    "functions": [
                        {"name": "hello", "arguments": [{"name": "v", "type": "List"}]}
                    ],
                }
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
                    {"name": "ExampleAgent", "entrypoint": "agents/example_agent.py"}
                ]
            },
            {"agent": {"name": "ExampleAgent"}},
            write_source=False,
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        self.assertIn("agents[0].entrypoint", self.log.output[0])
        self.assertIn("example_agent.py does not exist", self.log.output[0])
        self.assertNotIn("\n", self.log.output[0])

    def test_a_workflow_file_with_nothing_behind_it_stops_the_build(self):
        exit_error, generate_stub, subprocess_run = self._build(
            {
                "agents": [
                    {
                        "name": "Workflow",
                        "type": "workflow",
                        "workflow_file": "workflows/example_workflow.py",
                    }
                ]
            },
            {"agent": {"name": "ExampleAgent"}},
        )

        self.assertEqual(exit_error.code, 1)
        generate_stub.assert_not_called()
        subprocess_run.assert_not_called()
        self.assertIn("agents[0].workflow_file", self.log.output[0])
        self.assertIn("example_workflow.py does not exist", self.log.output[0])

    def test_a_missing_source_root_stops_the_build_once(self):
        # Under the .car layout the app's code lives in .car/app; without it
        # the build found nothing to do and said "No Docker images to build."
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            artifact_root = project_dir / ".car"
            (artifact_root / "config").mkdir(parents=True)
            (artifact_root / "config" / "example_agent.yaml").write_text(
                yaml.safe_dump({"agent": {"name": "ExampleAgent"}})
            )
            config_path = artifact_root / "config" / "global_controller.yaml"
            config_path.write_text(
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
        self.assertIn(os.path.join(".car", "app"), log.output[0])


class CliCleanTests(unittest.TestCase):
    def test_clean_uses_car_when_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            (project_dir / ".car" / "stubs").mkdir(parents=True)
            (project_dir / "stubs").mkdir()
            cwd = os.getcwd()
            os.chdir(project_dir)
            try:
                cli.cmd_clean(SimpleNamespace())
            finally:
                os.chdir(cwd)

            self.assertFalse((project_dir / ".car" / "stubs").exists())
            self.assertTrue((project_dir / "stubs").exists())


if __name__ == "__main__":
    unittest.main()


class ValidateOrExitTests(unittest.TestCase):
    def test_the_manifest_is_parsed_once(self):
        from canyonos_core import schema
        from canyonos_core.cli import validate_or_exit

        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = os.path.join(tmpdir, "global_controller.yaml")
            with open(manifest_path, "w") as f:
                f.write(
                    "agents:\n  - name: Workflow\n    type: workflow\n"
                    "    workflow_file: workflow.py\n"
                )
            with patch.object(
                schema, "load_manifest", wraps=schema.load_manifest
            ) as load_manifest:
                manifest = validate_or_exit(manifest_path, tmpdir)

        self.assertEqual(load_manifest.call_count, 1)
        self.assertEqual(manifest.agents[0].name, "Workflow")
