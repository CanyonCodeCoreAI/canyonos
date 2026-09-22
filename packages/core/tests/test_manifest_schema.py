"""The manifest schema decides what `global_controller.yaml` may say.

Before it existed, an unknown key was ignored, `replicas: "2"` blew up inside
the instance manager once containers were already being launched, and a
workflow with no `workflow_file` was warned about and then skipped while the
deploy reported success. Every test here is one of those turned into a
rejection with a file, a line and a field.
"""

import glob
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.schema import (
    AgentService,
    DatabaseService,
    SchemaError,
    WorkflowService,
    load_manifest,
    render_violation,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def _agent(**overrides):
    entry = {"name": "ExampleAgent", "entrypoint": "agents/example_agent.py"}
    entry.update(overrides)
    return entry


class _ManifestCase(unittest.TestCase):
    def load(self, config, filename="global_controller.yaml"):
        """Write a manifest to a scratch project and load it."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, filename)
            with open(path, "w") as f:
                yaml.safe_dump(config, f, sort_keys=False)
            return load_manifest(path)

    def violations(self, config):
        with self.assertRaises(SchemaError) as raised:
            self.load(config)
        return raised.exception.violations

    def one(self, config):
        violations = self.violations(config)
        self.assertEqual(len(violations), 1, [render_violation(v) for v in violations])
        return violations[0]

    def fields(self, config):
        return [violation.field for violation in self.violations(config)]


class ExampleManifestTests(unittest.TestCase):
    """Every manifest shipped in examples/ has to satisfy the schema it documents."""

    def test_every_example_manifest_loads(self):
        manifests = sorted(
            glob.glob(str(REPO_ROOT / "examples/*/config/global_controller*.yaml"))
        )
        self.assertTrue(manifests, "no example manifests found")
        for path in manifests:
            with self.subTest(manifest=os.path.relpath(path, REPO_ROOT)):
                manifest = load_manifest(path)
                self.assertTrue(manifest.agents)


class UnknownKeyTests(_ManifestCase):
    def test_an_unknown_top_level_key_is_rejected_with_a_line(self):
        violation = self.one({"agents": [_agent()], "registry": {"url": "example"}})

        self.assertEqual(violation.field, "registry")
        self.assertIn("unknown key 'registry'", violation.message)
        self.assertGreater(violation.line, 0)
        self.assertTrue(violation.path.endswith("global_controller.yaml"))

    def test_a_near_miss_is_offered_the_key_it_meant(self):
        violation = self.one({"agents": [_agent(replias=2)]})

        self.assertEqual(violation.field, "agents[0].replias")
        self.assertEqual(
            violation.message, "unknown key 'replias' (did you mean 'replicas'?)"
        )

    def test_a_key_valid_for_another_type_names_this_one(self):
        violation = self.one(
            {
                "agents": [
                    {
                        "name": "Workflow",
                        "type": "workflow",
                        "workflow_file": "workflow/example_workflow.py",
                        "entrypoint": "agents/example_agent.py",
                    }
                ]
            }
        )

        self.assertEqual(violation.field, "agents[0].entrypoint")
        self.assertEqual(
            violation.message, "key 'entrypoint' is not valid for type 'workflow'"
        )

    def test_an_unknown_nested_key_is_rejected(self):
        self.assertEqual(
            self.fields({"agents": [_agent()], "redis": {"hostname": "localhost"}}),
            ["redis.hostname"],
        )


class ReplicaTests(_ManifestCase):
    def test_a_replica_count_that_is_not_a_positive_integer_is_rejected(self):
        for replicas, quoted in (
            ("2", "the string '2'"),
            (0, "the number 0"),
            (-1, "the number -1"),
            (1.5, "the number 1.5"),
            (True, "the boolean true"),
            ([{"host": "a"}], "the list [{'host': 'a'}]"),
        ):
            with self.subTest(replicas=replicas):
                violation = self.one({"agents": [_agent(replicas=replicas)]})
                self.assertEqual(violation.field, "agents[0].replicas")
                self.assertEqual(
                    violation.message, f"expected an integer >= 1, got {quoted}"
                )


class ServiceIdentityTests(_ManifestCase):
    def test_a_service_without_a_name_is_rejected(self):
        violation = self.one({"agents": [{"entrypoint": "agents/a.py"}]})

        self.assertEqual(violation.field, "agents[0].name")
        self.assertEqual(violation.message, "is required but missing")

    def test_two_services_cannot_share_a_name(self):
        violation = self.one(
            {"agents": [_agent(), _agent(entrypoint="agents/other.py")]}
        )

        self.assertEqual(violation.field, "agents[1].name")
        self.assertIn("duplicate service name 'ExampleAgent'", violation.message)

    def test_names_that_differ_only_in_case_collide(self):
        # The image tag and the container name are both name.lower().
        violation = self.one(
            {
                "agents": [
                    _agent(),
                    _agent(name="exampleagent", entrypoint="agents/other.py"),
                ]
            }
        )

        self.assertEqual(violation.field, "agents[1].name")
        self.assertIn("image tag", violation.message)


class EntrypointTests(_ManifestCase):
    def test_an_agent_without_an_entrypoint_is_rejected(self):
        violation = self.one({"agents": [{"name": "ExampleAgent"}]})

        self.assertEqual(violation.field, "agents[0].entrypoint")
        self.assertEqual(violation.message, "is required but missing")

    def test_a_workflow_without_a_workflow_file_is_rejected(self):
        violation = self.one({"agents": [{"name": "Workflow", "type": "workflow"}]})

        self.assertEqual(violation.field, "agents[0].workflow_file")
        self.assertEqual(violation.message, "is required but missing")

    def test_an_entrypoint_outside_the_project_is_rejected(self):
        for entrypoint, expected in (
            ("/etc/passwd.py", "must be relative to the project"),
            ("../elsewhere/agent.py", "must not escape the project with '..'"),
            ("agents/example_agent", "must name a .py file"),
        ):
            with self.subTest(entrypoint=entrypoint):
                violation = self.one({"agents": [_agent(entrypoint=entrypoint)]})
                self.assertEqual(violation.field, "agents[0].entrypoint")
                self.assertIn(expected, violation.message)


class DatabaseServiceTests(_ManifestCase):
    def _database(self, **overrides):
        entry = {"name": "StateDB", "type": "database", "image": "postgres:16-alpine"}
        entry.update(overrides)
        return {"agents": [entry]}

    def test_a_database_without_an_image_is_rejected(self):
        violation = self.one({"agents": [{"name": "StateDB", "type": "database"}]})

        self.assertEqual(violation.field, "agents[0].image")
        self.assertEqual(violation.message, "is required but missing")

    def test_a_database_cannot_be_replicated(self):
        violation = self.one(self._database(replicas=2))

        self.assertEqual(violation.field, "agents[0].replicas")
        self.assertIn("single container", violation.message)

    def test_a_database_env_must_be_a_mapping(self):
        violation = self.one(self._database(env=["POSTGRES_USER=bob"]))

        self.assertEqual(violation.field, "agents[0].env")
        self.assertIn("expected a mapping", violation.message)

    def test_a_database_parses_with_its_ports_and_volume(self):
        manifest = self.load(
            self._database(db_port=5433, volume_path="/var/lib/postgresql/data")
        )

        (service,) = manifest.agents
        self.assertIsInstance(service, DatabaseService)
        self.assertEqual(service.db_port, 5433)
        self.assertEqual(service.volume_path, "/var/lib/postgresql/data")


class ProviderTests(_ManifestCase):
    def test_a_provider_is_matched_exactly(self):
        for provider in ("Local", "ec2", "EC2 "):
            with self.subTest(provider=provider):
                violations = self.violations({"agents": [_agent(provider=provider)]})
                self.assertIn("agents[0].provider", [v.field for v in violations])

    def test_an_ec2_service_needs_an_instance_type(self):
        self.assertIn(
            "agents[0].instance_type",
            self.fields(
                {
                    "agents": [_agent(provider="EC2")],
                    "ec2": _EC2_BLOCK,
                }
            ),
        )

    def test_an_ec2_service_needs_the_ec2_block(self):
        violation = self.one(
            {"agents": [_agent(provider="EC2", instance_type="t3.micro")]}
        )

        self.assertEqual(violation.field, "ec2")
        self.assertIn("provider 'EC2'", violation.message)
        self.assertEqual(violation.line, 0)

    def test_the_ec2_block_must_be_complete(self):
        block = dict(_EC2_BLOCK)
        del block["ssh_user"]

        self.assertEqual(
            self.fields(
                {
                    "agents": [_agent(provider="EC2", instance_type="t3.micro")],
                    "ec2": block,
                }
            ),
            ["ec2.ssh_user"],
        )

    def test_the_ec2_block_carries_its_own_defaults(self):
        manifest = self.load(
            {
                "agents": [_agent(provider="EC2", instance_type="t3.micro")],
                "ec2": _EC2_BLOCK,
            }
        )

        self.assertEqual(manifest.ec2.ssh_private_key_path, "~/.ssh/ventis_ec2")
        self.assertEqual(manifest.ec2.public_ip_timeout, 120)
        self.assertEqual(manifest.ec2.controller_health_timeout, 180)


_EC2_BLOCK = {
    "region": "us-east-1",
    "ami_id": "ami-0123456789abcdef0",
    "subnet_id": "subnet-0123456789abcdef0",
    "security_group_ids": ["sg-0123456789abcdef0"],
    "ssh_user": "ubuntu",
}


class DefaultsTests(_ManifestCase):
    def test_every_default_materializes(self):
        manifest = self.load(
            {
                "agents": [
                    _agent(),
                    {
                        "name": "Workflow",
                        "type": "workflow",
                        "workflow_file": "workflow/example_workflow.py",
                    },
                    {
                        "name": "StateDB",
                        "type": "database",
                        "image": "postgres:16-alpine",
                    },
                ]
            }
        )

        agent, workflow, database = manifest.agents
        self.assertEqual(manifest.poll_interval, 5)
        self.assertEqual(manifest.cleanup_interval, 10)
        self.assertEqual(manifest.redis.host, "localhost")
        self.assertEqual(manifest.redis.port, 6379)
        self.assertEqual(manifest.redis.db, 0)
        self.assertIsNone(manifest.database)
        self.assertIsNone(manifest.otel)
        self.assertIsNone(manifest.ec2)

        self.assertIsInstance(agent, AgentService)
        self.assertEqual(agent.provider, "local")
        self.assertEqual(agent.replicas, 1)
        self.assertEqual(agent.redis_port, 6379)
        self.assertEqual(agent.resources.cpu, 1)
        self.assertEqual(agent.resources.memory, 512)
        self.assertIsNone(agent.resources.gpu)
        self.assertFalse(agent.stateful)
        self.assertEqual(agent.requirements, ())

        self.assertIsInstance(workflow, WorkflowService)
        self.assertEqual(workflow.api_port, 8080)
        self.assertEqual(workflow.dashboard_port, 8081)

        self.assertIsInstance(database, DatabaseService)
        self.assertEqual(database.db_port, 5432)


class OtelTests(_ManifestCase):
    def _otel(self, destination):
        return {"agents": [_agent()], "otel": {"destinations": [destination]}}

    def test_an_unsupported_protocol_is_caught_at_load(self):
        violation = self.one(
            self._otel(
                {"name": "local", "protocol": "smoke-signal", "endpoint": "http://x"}
            )
        )

        self.assertEqual(violation.field, "otel.destinations[0].protocol")
        self.assertIn("'grpc', 'http'", violation.message)

    def test_a_destination_without_an_endpoint_is_caught_at_load(self):
        violation = self.one(self._otel({"name": "local", "protocol": "http"}))

        self.assertEqual(violation.field, "otel.destinations[0].endpoint")
        self.assertEqual(violation.message, "is required but missing")

    def test_a_complete_destination_parses(self):
        manifest = self.load(
            self._otel(
                {
                    "name": "local",
                    "protocol": "http",
                    "endpoint": "http://host.docker.internal:3000/v1/traces",
                    "headers": {"x-key": "value"},
                }
            )
        )

        (destination,) = manifest.otel.destinations
        self.assertEqual(destination.protocol, "http")
        self.assertEqual(destination.headers, {"x-key": "value"})
        self.assertFalse(destination.insecure)


class DatabaseBlockTests(_ManifestCase):
    def test_an_empty_database_block_is_no_database(self):
        # `database:` with nothing under it parses as None -- readers must not
        # take that for a mapping, and the schema must not take it for an error.
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "global_controller.yaml")
            Path(path).write_text(
                "agents:\n"
                "  - name: ExampleAgent\n"
                "    entrypoint: agents/example_agent.py\n"
                "database:\n"
            )
            manifest = load_manifest(path)

        self.assertIsNone(manifest.database)
        self.assertEqual(len(manifest.agents), 1)

    def test_a_database_block_without_a_url_is_rejected(self):
        self.assertEqual(
            self.fields({"agents": [_agent()], "database": {"urls": "sqlite://"}}),
            ["database.urls", "database.url"],
        )


class EnvExpansionTests(_ManifestCase):
    """`${VAR}` is supported in string fields only.

    Expansion is textual on both sides, so a reference in a numeric field
    reaches the Global Controller as a string -- `replicas` of "3" starts one
    replica, not three. Rejecting it here is the only way that stays true.
    """

    def test_an_env_ref_in_a_numeric_field_is_rejected_even_when_it_is_set(self):
        config = {
            "agents": [
                {
                    "name": "Workflow",
                    "type": "workflow",
                    "workflow_file": "workflow/example_workflow.py",
                    "api_port": "${CANYONOS_TEST_API_PORT}",
                }
            ]
        }

        with patch.dict(os.environ, {"CANYONOS_TEST_API_PORT": "9000"}):
            violation = self.one(config)

        self.assertEqual(violation.field, "agents[0].api_port")
        self.assertEqual(
            violation.message,
            "expected an integer >= 1, got '${CANYONOS_TEST_API_PORT}' "
            "(environment references are only supported in string fields)",
        )

    def test_an_env_ref_in_a_boolean_field_is_rejected(self):
        config = {"agents": [_agent(stateful="${CANYONOS_TEST_STATEFUL}")]}

        with patch.dict(os.environ, {"CANYONOS_TEST_STATEFUL": "true"}):
            violation = self.one(config)

        self.assertEqual(violation.field, "agents[0].stateful")
        self.assertIn("only supported in string fields", violation.message)

    def test_a_string_field_takes_the_variable_s_text(self):
        config = {
            "agents": [_agent(provider="EC2", instance_type="t3.micro")],
            "ec2": {**_EC2_BLOCK, "region": "${CANYONOS_TEST_REGION}"},
        }

        with patch.dict(os.environ, {"CANYONOS_TEST_REGION": "eu-west-2"}):
            manifest = self.load(config)

        self.assertEqual(manifest.ec2.region, "eu-west-2")

    def test_a_string_list_takes_the_variable_s_text(self):
        config = {
            "agents": [_agent(provider="EC2", instance_type="t3.micro")],
            "ec2": {**_EC2_BLOCK, "security_group_ids": ["${CANYONOS_TEST_SG}"]},
        }

        with patch.dict(os.environ, {"CANYONOS_TEST_SG": "sg-abc"}):
            manifest = self.load(config)

        self.assertEqual(manifest.ec2.security_group_ids, ("sg-abc",))

    def test_an_unset_ref_is_left_literal_just_as_the_controller_leaves_it(self):
        config = {
            "agents": [_agent(provider="EC2", instance_type="t3.micro")],
            "ec2": {**_EC2_BLOCK, "region": "${CANYONOS_TEST_REGION}"},
        }

        environ = {k: v for k, v in os.environ.items() if k != "CANYONOS_TEST_REGION"}
        with patch.dict(os.environ, environ, clear=True):
            manifest = self.load(config)

        self.assertEqual(manifest.ec2.region, "${CANYONOS_TEST_REGION}")

    def test_an_unset_ref_in_a_numeric_field_is_reported_the_same_way(self):
        config = {"agents": [_agent(replicas="${CANYONOS_TEST_REPLICAS}")]}

        environ = {k: v for k, v in os.environ.items() if k != "CANYONOS_TEST_REPLICAS"}
        with patch.dict(os.environ, environ, clear=True):
            violation = self.one(config)

        self.assertEqual(violation.field, "agents[0].replicas")
        self.assertEqual(
            violation.message,
            "expected an integer >= 1, got '${CANYONOS_TEST_REPLICAS}' "
            "(environment references are only supported in string fields)",
        )


class UnparseableFileTests(unittest.TestCase):
    """The gate runs before the plain load, so a broken file is a violation too."""

    def _load(self, text):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "global_controller.yaml")
            Path(path).write_text(text)
            with self.assertRaises(SchemaError) as raised:
                load_manifest(path)
        return raised.exception.violations

    def test_a_file_that_is_not_yaml_is_reported_on_one_line(self):
        (violation,) = self._load("agents: [one,\n  two: three\n")

        rendered = render_violation(violation)
        self.assertNotIn("\n", rendered)
        self.assertIn("is not valid YAML", rendered)
        self.assertGreater(violation.line, 0)
        # No field to name, so the location is followed by the message itself.
        self.assertNotIn(": : ", rendered)

    def test_an_empty_file_is_reported(self):
        (violation,) = self._load("# nothing here\n")

        self.assertEqual(violation.message, "is empty")

    def test_a_file_that_is_not_a_mapping_is_reported(self):
        (violation,) = self._load("- one\n- two\n")

        self.assertIn("expected a mapping", violation.message)


class RenderingTests(_ManifestCase):
    def test_a_violation_renders_as_one_line_with_its_location(self):
        violation = self.one({"agents": [_agent()], "registry": {"url": "example"}})

        rendered = render_violation(violation)
        self.assertNotIn("\n", rendered)
        self.assertIn(f"{violation.path}:{violation.line}: ", rendered)
        self.assertIn("registry: ", rendered)
        self.assertTrue(rendered.endswith(violation.message))

    def test_every_violation_in_a_file_is_reported_at_once(self):
        fields = self.fields(
            {
                "agents": [_agent(replicas="2"), {"name": "Nameless"}],
                "poll_interval": "soon",
            }
        )

        self.assertEqual(
            fields, ["agents[0].replicas", "agents[1].entrypoint", "poll_interval"]
        )


if __name__ == "__main__":
    unittest.main()
