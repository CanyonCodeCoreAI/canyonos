# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import subprocess
import sys
import unittest

from canyonos_core.controller.utils import schema


class QueueLocationTests(unittest.TestCase):
    def _db_path(self, data_dir):
        """DB_PATH as a freshly started process sees it, as the exporter does."""
        environment = {k: v for k, v in os.environ.items() if k != "CANYONOS_DATA_DIR"}
        if data_dir:
            environment["CANYONOS_DATA_DIR"] = data_dir
        return subprocess.run(
            [
                sys.executable,
                "-c",
                "from canyonos_core.controller.utils.schema import DB_PATH; print(DB_PATH)",
            ],
            env=environment,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    def test_without_a_data_dir_the_queue_stays_beside_the_code(self):
        self.assertEqual(
            self._db_path(None),
            os.path.join(os.path.dirname(schema.__file__), "otel_queue.db"),
        )

    def test_a_data_dir_holds_the_queue(self):
        self.assertEqual(
            self._db_path("/var/lib/canyonos"),
            os.path.join("/var/lib/canyonos", "otel_queue.db"),
        )


if __name__ == "__main__":
    unittest.main()
