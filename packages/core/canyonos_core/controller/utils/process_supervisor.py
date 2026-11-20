# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Registry for OS processes GlobalController spawns and supervises.

Deliberately GC-agnostic: callers must not call check_and_respawn() during their own shutdown.
"""

import logging
import os
import subprocess

logger = logging.getLogger(__name__)


class ProcessSupervisor:
    """Runs the Global Controller's background processes and restarts any that exit."""

    def __init__(self):
        self._specs = {}  # name -> (argv, env) tuple
        self._procs = {}  # name -> subprocess.Popen

    def register(self, name, argv, env=None):
        """Declare a process to manage. Does not start it -- call start_all() once
        everything is registered. `env`, if given, is merged on top of (not a
        replacement for) this process's own environment, so the child still inherits
        PATH etc."""
        self._specs[name] = (argv, env)

    def start_all(self):
        """Start every registered process."""
        for name, (argv, env) in self._specs.items():
            self._start(name, argv, env)

    def start(self, name):
        """Start one registered process."""
        self._start(name, *self._specs[name])

    def stop(self, name):
        """Terminate one process and stop managing it; nothing happens if it is unknown."""
        self._specs.pop(name, None)
        proc = self._procs.pop(name, None)
        if proc is None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def _start(self, name, argv, env=None):
        merged_env = {**os.environ, **env} if env else None
        self._procs[name] = subprocess.Popen(argv, env=merged_env)

    def check_and_respawn(self):
        """Restart any registered process that has exited."""
        for name, proc in list(self._procs.items()):
            if proc.poll() is not None:
                logger.warning(
                    "Managed process %r exited (code %s), respawning",
                    name,
                    proc.returncode,
                )
                argv, env = self._specs[name]
                self._start(name, argv, env)

    def terminate_all(self, timeout=10):
        """Terminate every managed process, falling back to kill() on timeout."""
        for proc in self._procs.values():
            proc.terminate()
        for name, proc in self._procs.items():
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self._procs.clear()
