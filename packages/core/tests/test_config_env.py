# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A project's `.env`, as config_env reads it for `${VAR}` refs in the config."""

import os
import tempfile
import unittest

from canyonos_core.controller.utils.config_env import expand_env_value, load_dotenv

BOM = b"\xef\xbb\xbf"


class LoadDotenvTests(unittest.TestCase):
    def _load(self, data):
        for key in ("ENV_FIRST", BOM.decode("utf-8") + "ENV_FIRST", "ENV_SECOND"):
            os.environ.pop(key, None)
            self.addCleanup(os.environ.pop, key, None)
        with tempfile.NamedTemporaryFile("wb", suffix=".env", delete=False) as f:
            f.write(data)
        self.addCleanup(os.unlink, f.name)
        load_dotenv(f.name)

    def test_a_byte_order_mark_is_not_part_of_the_first_key(self):
        # Windows editors (Notepad) save .env with one.
        self._load(BOM + b"ENV_FIRST=first\r\nENV_SECOND=second\r\n")

        self.assertEqual(os.environ.get("ENV_FIRST"), "first")
        self.assertEqual(os.environ.get("ENV_SECOND"), "second")
        self.assertEqual(expand_env_value("${ENV_FIRST}"), "first")

    def test_utf8_values_are_read_as_written(self):
        self._load("ENV_FIRST=café\n".encode("utf-8"))

        self.assertEqual(os.environ.get("ENV_FIRST"), "café")


if __name__ == "__main__":
    unittest.main()
