# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canyonos_core.controller.utils.redis_client import RedisClient, connection_options
from canyonos_core.llm_gateway.hooks import Hooks

VARIABLES = (
    "CANYONOS_REDIS_PASSWORD",
    "CANYONOS_REDIS_USERNAME",
    "CANYONOS_REDIS_TLS",
    "CANYONOS_REDIS_CA_FILE",
)


def _clean_environment(**values):
    environment = {k: v for k, v in os.environ.items() if k not in VARIABLES}
    environment.update(values)
    return patch.dict(os.environ, environment, clear=True)


class ConnectionOptionsTests(unittest.TestCase):
    def test_nothing_set_means_a_plain_connection_as_before(self):
        self.assertEqual(connection_options({}), {})

    def test_empty_values_count_as_unset(self):
        self.assertEqual(connection_options(dict.fromkeys(VARIABLES, "")), {})

    def test_password_username_and_tls_with_a_ca(self):
        self.assertEqual(
            connection_options(
                {
                    "CANYONOS_REDIS_PASSWORD": "s3cret",
                    "CANYONOS_REDIS_USERNAME": "canyonos",
                    "CANYONOS_REDIS_TLS": "true",
                    "CANYONOS_REDIS_CA_FILE": "/etc/canyonos/redis-ca.crt",
                }
            ),
            {
                "password": "s3cret",
                "username": "canyonos",
                "ssl": True,
                "ssl_ca_certs": "/etc/canyonos/redis-ca.crt",
            },
        )

    def test_a_ca_file_alone_does_not_turn_tls_on(self):
        self.assertEqual(connection_options({"CANYONOS_REDIS_CA_FILE": "/ca.crt"}), {})

    def test_tls_accepts_the_usual_spellings(self):
        for value in ("1", "true", "TRUE", "yes", "on", " true "):
            self.assertEqual(
                connection_options({"CANYONOS_REDIS_TLS": value}), {"ssl": True}
            )
        for value in ("0", "false", "no", "off", "maybe"):
            self.assertEqual(connection_options({"CANYONOS_REDIS_TLS": value}), {})


class ConnectionsUseTheOptionsTests(unittest.TestCase):
    def test_redis_client_connects_with_them(self):
        with _clean_environment(
            CANYONOS_REDIS_PASSWORD="s3cret", CANYONOS_REDIS_USERNAME="canyonos"
        ):
            kwargs = RedisClient().client.connection_pool.connection_kwargs
        self.assertEqual(
            (kwargs["password"], kwargs["username"]), ("s3cret", "canyonos")
        )

    def test_redis_client_without_them_sends_no_credentials(self):
        with _clean_environment():
            kwargs = RedisClient().client.connection_pool.connection_kwargs
        self.assertIsNone(kwargs.get("password"))
        self.assertIsNone(kwargs.get("username"))

    def test_the_gateway_connects_with_them(self):
        config = SimpleNamespace(redis_host="localhost", redis_port=6379)
        with _clean_environment(CANYONOS_REDIS_PASSWORD="s3cret"):
            hooks = Hooks(config)
        kwargs = hooks._redis.connection_pool.connection_kwargs
        self.assertEqual(kwargs["password"], "s3cret")


if __name__ == "__main__":
    unittest.main()
