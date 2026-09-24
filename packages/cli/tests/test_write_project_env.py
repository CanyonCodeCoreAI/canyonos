"""QA coverage for PR #141 (CAN-386): _write_project_env newline handling."""

import unittest
from pathlib import Path


class WriteProjectEnvNewlineTests(unittest.TestCase):
    """The PR's second change: don't glue a new key onto an unterminated last line."""

    def setUp(self):
        import tempfile

        from canyonos import dashboard_stack

        self.dashboard_stack = dashboard_stack
        self.dir = tempfile.mkdtemp()

    def _write(self, existing, managed):
        p = Path(self.dir) / ".env"
        p.write_text(existing, encoding="utf-8")
        self.dashboard_stack._write_project_env(p, managed)
        return p.read_text(encoding="utf-8")

    def test_unterminated_comment_last_line_no_longer_swallows_the_new_key(self):
        out = self._write("# trailing comment", {"CANYONOS_WEB_PORT": "8081"})
        self.assertIn("# trailing comment\n", out)
        self.assertIn("CANYONOS_WEB_PORT=8081\n", out)
        self.assertNotIn("# trailing commentCANYONOS_WEB_PORT", out)

    def test_unterminated_key_last_line_is_preserved(self):
        out = self._write("FOO=bar", {"CANYONOS_WEB_PORT": "8081"})
        self.assertEqual(out, "FOO=bar\nCANYONOS_WEB_PORT=8081\n")

    def test_replacing_an_existing_managed_key_does_not_duplicate_it(self):
        out = self._write(
            "CANYONOS_WEB_PORT=1\nCANYONOS_WEB_PORT=2\n", {"CANYONOS_WEB_PORT": "8081"}
        )
        self.assertEqual(out.count("CANYONOS_WEB_PORT"), 1)

    def test_a_commented_out_managed_key_is_left_alone_and_the_key_is_appended(self):
        out = self._write("#CANYONOS_WEB_PORT=9\n", {"CANYONOS_WEB_PORT": "8081"})
        self.assertIn("#CANYONOS_WEB_PORT=9\n", out)
        self.assertIn("CANYONOS_WEB_PORT=8081\n", out)

    def test_empty_file_still_writes_the_managed_keys(self):
        out = self._write("", {"CANYONOS_WEB_PORT": "8081"})
        self.assertEqual(out, "CANYONOS_WEB_PORT=8081\n")


if __name__ == "__main__":
    unittest.main()
