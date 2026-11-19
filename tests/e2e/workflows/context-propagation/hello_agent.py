# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# helloworld's HelloAgent, which also says which Python its replica runs on.

import platform


class HelloAgent(object):
    def __init__(self):
        self.tools = [self.hello]

    def hello(self, name: str) -> str:
        """Greet someone by name."""
        return f"Hello, {name}! I'm the HelloAgent!"

    def python_version(self) -> str:
        """The Python this replica runs on, such as 3.12.13."""
        return platform.python_version()
