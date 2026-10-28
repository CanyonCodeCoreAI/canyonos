# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The project's Kubernetes objects, rendered in the core image, and the in-cluster
build's other steps: receiving the upload, building on a remote BuildKit, applying."""

import io
import json
import os
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.kubernetes import commands
from canyonos_core.kubernetes import manifests as kubernetes_manifests
from canyonos_core.kubernetes.receiver import RECEIVED_MARKER, receive_upload, unpack
from canyonos_core.schema._checks import _Collector
from canyonos_core.schema.kubernetes_block import parse_kubernetes

DIGEST = "localhost:5001/canyonos-helloagent@sha256:" + "a" * 64
WORKFLOW_DIGEST = "localhost:5001/canyonos-workflow@sha256:" + "b" * 64


def config(**k8s):
    return {
        "agents": [
            {"name": "HelloAgent", "replicas": 2,
             "entrypoint": "agents/hello_agent.py",
             "functions": [{"name": "hello", "arguments": [{"name": "name"}]}]},
            {"name": "Workflow", "resources": {"cpu": 2, "memory": 1024},
             "entrypoint": "agents/workflow.py",
             "functions": [{"name": "main", "arguments": [{"name": "query"}]}]},
        ],
        "endpoint": {"agent": "Workflow", "method": "main"},
        "poll_interval": 5,
        "kubernetes": {"namespace": "acme", "registry": "localhost:5001", **k8s},
    }  # fmt: skip


def rendered(cfg=None, **kwargs):
    options = {
        "project_name": "Demo_Project",
        "project_id": "4eeed6f3-1c2b-4c1d-9d8e-0a1b2c3d4e5f",
        "config_files": {"global_controller.yaml": "agents: []\n"},
        "images": {"HelloAgent": DIGEST, "Workflow": WORKFLOW_DIGEST},
        "controller_image": "localhost:5001/canyonos-core@sha256:" + "c" * 64,
        "env_secret": "demo-env",
        **kwargs,
    }
    cfg = cfg or config()
    collector = _Collector("global_controller.yaml")
    spec = parse_kubernetes(collector, cfg)
    assert not collector.violations, collector.violations
    objects, warnings = kubernetes_manifests.render(cfg, spec, **options)
    return {(o["kind"], o["metadata"]["name"]): o for o in objects}, warnings


class RenderTests(unittest.TestCase):
    def test_a_project_becomes_a_config_map_a_canyon_project_and_agents(self):
        objects, warnings = rendered()
        self.assertEqual(
            set(objects),
            {
                ("ConfigMap", "demo-project-config"),
                ("CanyonProject", "demo-project"),
                ("CanyonAgent", "helloagent"),
                ("CanyonAgent", "workflow"),
            },
        )
        project = objects[("CanyonProject", "demo-project")]["spec"]
        self.assertEqual(project["displayName"], "Demo_Project")
        self.assertEqual(project["envSecretRef"], "demo-env")
        self.assertEqual(
            objects[("CanyonAgent", "helloagent")]["spec"]["image"], DIGEST
        )
        self.assertEqual(objects[("CanyonAgent", "helloagent")]["spec"]["replicas"], 2)
        self.assertEqual(warnings, [])

    def test_the_ec2_section_is_ignored_with_a_warning(self):
        cfg = config()
        cfg["provider"] = "EC2"
        cfg["ec2"] = {"region": "us-east-1", "machine_type": {"m5.large": 2}}

        _, warnings = rendered(cfg)

        self.assertEqual(
            warnings,
            ["the ec2: block only applies to EC2 and is ignored on Kubernetes"],
        )

    def test_an_autoscaled_agent_keeps_its_live_count(self):
        # Set, not left out: server-side apply would delete a field it owns and left
        # out, and the CRD default (1) would reset the agent.
        objects, _ = rendered(live_replicas={"helloagent": 5})
        self.assertEqual(objects[("CanyonAgent", "helloagent")]["spec"]["replicas"], 5)
        self.assertEqual(objects[("CanyonAgent", "workflow")]["spec"]["replicas"], 1)

    def test_a_database_runs_its_stock_image(self):
        cfg = config(databases={"StateDB": {"run_as_user": 70, "fs_group": 70}})
        cfg["agents"].append(
            {"name": "StateDB", "type": "database", "image": "postgres:16-alpine",
             "volume_path": "/var/lib/postgresql/data"}
        )  # fmt: skip
        spec = rendered(cfg)[0][("CanyonAgent", "statedb")]["spec"]
        self.assertEqual(spec["database"]["runAsUser"], 70)
        self.assertEqual(spec["replicas"], 1)


class FakeApi:
    namespace = "acme"

    def __init__(self, existing):
        """`existing`: {CanyonAgent name: its live spec.replicas}."""
        self.existing, self.applied, self.deleted = existing, [], []
        self.objects = {}

    def canyon_agents(self, project):
        return [
            {"metadata": {"name": name}, "spec": {"replicas": replicas}}
            for name, replicas in self.existing.items()
        ]

    def apply(self, obj, field_manager):
        self.applied.append(
            (obj["kind"], obj["metadata"]["name"], obj["metadata"]["namespace"])
        )
        self.objects[obj["kind"], obj["metadata"]["name"]] = obj

    def delete_canyon_agent(self, name):
        self.deleted.append(name)


class ApplyProjectTests(unittest.TestCase):
    def _apply(self, existing, scaling=False):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config(namespace="written-elsewhere")
            cfg["project_id"] = "4eeed6f3-1c2b-4c1d-9d8e-0a1b2c3d4e5f"
            Path(tmp, "global_controller.yaml").write_text(json.dumps(cfg))
            if scaling:
                Path(tmp, "scaling.yaml").write_text("policies: []\n")
            Path(tmp, "images.json").write_text(
                json.dumps(
                    {"images": {"HelloAgent": DIGEST, "Workflow": WORKFLOW_DIGEST}}
                )
            )
            api = FakeApi(existing)
            args = SimpleNamespace(
                config=os.path.join(tmp, "global_controller.yaml"),
                images=os.path.join(tmp, "images.json"),
                project="Demo_Project",
                env_secret="demo-env",
            )
            with (
                patch(
                    "canyonos_core.kubernetes.api.KubernetesApi.from_environment",
                    return_value=api,
                ),
                patch.dict(
                    os.environ, {"CANYONOS_CORE_IMAGE": "core@sha256:" + "c" * 64}
                ),
            ):
                commands._cmd_apply_project(args)
        return api

    def test_the_build_applies_the_project_here_and_removes_dropped_services(self):
        api = self._apply({"helloagent": 2, "oldagent": 1})
        self.assertEqual({namespace for _, _, namespace in api.applied}, {"acme"})
        self.assertIn(("CanyonAgent", "workflow", "acme"), api.applied)
        self.assertEqual(api.deleted, ["oldagent"])

    def replicas(self, api, name):
        return api.objects["CanyonAgent", name]["spec"]["replicas"]

    def test_a_redeploy_with_scaling_keeps_the_live_counts(self):
        # HelloAgent is configured with 2 and runs 5; Workflow is new.
        api = self._apply({"helloagent": 5}, scaling=True)
        self.assertEqual(self.replicas(api, "helloagent"), 5)
        self.assertEqual(self.replicas(api, "workflow"), 1)

    def test_without_scaling_the_config_sets_the_counts(self):
        api = self._apply({"helloagent": 5})
        self.assertEqual(self.replicas(api, "helloagent"), 2)


class RemoteBakeTests(unittest.TestCase):
    TARGETS = [
        {
            "name": "helloagent",
            "service": "HelloAgent",
            "context": ".",
            "image_name": "canyonos-helloagent",
        }
    ]

    def test_images_come_back_by_digest_under_the_pull_name(self):
        def run(argv, **kwargs):
            if argv[:3] == ["docker", "buildx", "bake"]:
                metadata = argv[argv.index("--metadata-file") + 1]
                Path(metadata).write_text(
                    json.dumps(
                        {"helloagent": {"containerimage.digest": "sha256:" + "d" * 64}}
                    )
                )
                self.assertEqual(kwargs["env"]["BUILDX_NO_DEFAULT_ATTESTATIONS"], "1")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("canyonos_core.kubernetes.commands.subprocess.run", side_effect=run),
        ):
            images = commands._bake_remote(
                self.TARGETS,
                tmp,
                "linux/amd64",
                "tcp://buildkitd:1234",
                "kind-registry:5000",
                "localhost:5001",
                "t1",
            )
            bake = json.loads(
                Path(tmp, "docker_container", "docker-bake.json").read_text()
            )

        self.assertEqual(
            images,
            {"HelloAgent": "localhost:5001/canyonos-helloagent@sha256:" + "d" * 64},
        )
        target = bake["target"]["helloagent"]
        self.assertEqual(target["tags"], ["kind-registry:5000/canyonos-helloagent:t1"])
        self.assertEqual(target["output"], ["type=registry"])


class CliBuildRemoteTests(unittest.TestCase):
    """`canyonos_core build`, which the in-cluster build Job runs: build on the cluster's
    BuildKit, push from there, and hand back each image pinned by digest."""

    TARGETS = [
        {
            "name": "helloagent",
            "service": "HelloAgent",
            "context": "ctx",
            "image_name": "canyonos-demo-helloagent",
        }
    ]

    def _bake(self, digest, builder_known=True):
        """A stand-in for `docker buildx`: writes bake's metadata file as BuildKit would."""
        calls = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[:3] == ["docker", "buildx", "inspect"]:
                return SimpleNamespace(returncode=0 if builder_known else 1)
            if argv[:3] == ["docker", "buildx", "bake"]:
                metadata = argv[argv.index("--metadata-file") + 1]
                entry = {"containerimage.digest": digest} if digest else {}
                Path(metadata).write_text(json.dumps({"helloagent": entry}))
            return SimpleNamespace(returncode=0)

        return run, calls

    def test_the_remote_builder_is_registered_once(self):
        for known, created in ((True, False), (False, True)):
            with self.subTest(known=known):
                run, calls = self._bake("sha256:b", builder_known=known)
                with (
                    tempfile.TemporaryDirectory() as tmp,
                    patch(
                        "canyonos_core.kubernetes.commands.subprocess.run",
                        side_effect=run,
                    ),
                ):
                    commands._bake_remote(
                        self.TARGETS, tmp, "linux/amd64", "tcp://b:1234", "r", "r", "t"
                    )
                self.assertEqual(
                    any(
                        argv[:3] == ["docker", "buildx", "create"] for argv, _ in calls
                    ),
                    created,
                )

    def test_a_build_without_a_digest_fails(self):
        run, _ = self._bake(None)
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("canyonos_core.kubernetes.commands.subprocess.run", side_effect=run),
        ):
            with self.assertRaisesRegex(RuntimeError, "no digest for HelloAgent"):
                commands._bake_remote(
                    self.TARGETS, tmp, "linux/amd64", "a", "r", "r", "t"
                )

    def test_build_writes_the_references_for_the_nodes_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "images.json")
            args = SimpleNamespace(
                config="c.yaml",
                builder="tcp://buildkitd:1234",
                registry="localhost:5001",
                push_registry=None,
                tag="t",
                output_json=out,
            )
            with (
                patch.dict(os.environ),
                patch(
                    "canyonos_core.kubernetes.commands._checked_config",
                    return_value=(None, {}),
                ),
                patch(
                    "canyonos_core.kubernetes.commands._generate_build_contexts",
                    return_value=self.TARGETS,
                ),
                patch(
                    "canyonos_core.stub_generator.this_machine_platform",
                    return_value="linux/arm64",
                ),
                patch(
                    "canyonos_core.kubernetes.commands._bake_remote",
                    return_value={"HelloAgent": "r@sha256:x"},
                ) as bake,
            ):
                os.environ.pop("CANYONOS_DOCKER_PLATFORM", None)
                commands._cmd_build(args)
            self.assertEqual(
                json.loads(Path(out).read_text())["images"],
                {"HelloAgent": "r@sha256:x"},
            )
        platform, address, push_registry, pull_registry = bake.call_args.args[2:6]
        self.assertEqual(
            (platform, address, push_registry, pull_registry),
            ("linux/arm64", "tcp://buildkitd:1234", "localhost:5001", "localhost:5001"),
        )


def _archive(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class ReceiveTests(unittest.TestCase):
    def test_only_the_pods_own_localhost_can_upload(self):
        # kubectl port-forward connects to the pod's localhost; other pods cannot reach it.
        with (
            tempfile.TemporaryDirectory() as dest,
            patch("canyonos_core.kubernetes.receiver.HTTPServer") as server,
            self.assertLogs("canyonos_core.kubernetes.receiver", "ERROR"),
        ):
            self.assertFalse(receive_upload(dest, 18766, 0))
        self.assertEqual(server.call_args.args[0], ("127.0.0.1", 18766))

    def test_an_upload_is_unpacked_and_marked_received(self):
        with tempfile.TemporaryDirectory() as dest:
            result = {}
            thread = threading.Thread(
                target=lambda: result.update(ok=receive_upload(dest, 18765, 10))
            )
            thread.start()
            time.sleep(0.5)
            request = urllib.request.Request(
                "http://127.0.0.1:18765/",
                data=_archive({"config/global_controller.yaml": "agents: []"}),
                method="PUT",
            )
            self.assertEqual(urllib.request.urlopen(request, timeout=5).status, 200)
            thread.join(5)

            self.assertTrue(result["ok"])
            self.assertTrue(Path(dest, "config", "global_controller.yaml").is_file())
            self.assertTrue(Path(dest, RECEIVED_MARKER).is_file())

    def test_nothing_lands_outside_the_destination(self):
        with tempfile.TemporaryDirectory() as dest:
            with self.assertRaises(tarfile.TarError):
                unpack(_archive({"../escaped.txt": "x"}), dest)

    def test_rejected_uploads_do_not_use_up_the_wait(self):
        with tempfile.TemporaryDirectory() as dest:
            result = {}
            thread = threading.Thread(
                target=lambda: result.update(ok=receive_upload(dest, 18767, 3))
            )
            thread.start()
            time.sleep(0.5)
            for _ in range(5):
                empty = urllib.request.Request(
                    "http://127.0.0.1:18767/", data=b"", method="PUT"
                )
                with self.assertRaises(urllib.error.HTTPError) as rejected:
                    urllib.request.urlopen(empty, timeout=5)
                self.assertEqual(rejected.exception.code, 400)
            upload = urllib.request.Request(
                "http://127.0.0.1:18767/",
                data=_archive({"config/global_controller.yaml": "agents: []"}),
                method="PUT",
            )
            self.assertEqual(urllib.request.urlopen(upload, timeout=5).status, 200)
            thread.join(5)

            self.assertTrue(result["ok"])

    def test_no_upload_in_time_fails(self):
        with tempfile.TemporaryDirectory() as dest:
            self.assertFalse(receive_upload(dest, 18766, 1))


if __name__ == "__main__":
    unittest.main()
