# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Which replica a local controller is: CANYONOS_REPLICA_ID, set by whatever launches
it (replicas.launch on Docker and EC2, the operator on Kubernetes). It is the only
source: nothing in Redis names a replica to itself."""

import os
import unittest
from unittest.mock import patch

from fakes import _FakeRedis
from test_local_controller_readiness import _build_controller


class LocalControllerIdentityTests(unittest.TestCase):
    # Where the provisioner used to write the ID, after the container had started.
    OLD_KEY = "controller:localhost:50051:replica_id"

    def _replica_id(self, environment, strings):
        with patch.dict(os.environ):
            os.environ.pop("CANYONOS_REPLICA_ID", None)
            os.environ.update(environment)
            return _build_controller(_FakeRedis(strings=strings)).replica_id

    def test_the_environment_names_the_replica_from_the_start(self):
        self.assertEqual(
            self._replica_id({"CANYONOS_REPLICA_ID": "HelloAgent-0"}, {}),
            "HelloAgent-0",
        )

    def test_redis_is_never_asked(self):
        self.assertIsNone(self._replica_id({}, {self.OLD_KEY: "HelloAgent-7"}))


if __name__ == "__main__":
    unittest.main()
