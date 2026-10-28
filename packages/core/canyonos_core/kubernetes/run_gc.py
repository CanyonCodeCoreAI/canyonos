# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos_core.cli run-gc`: the Global Controller on its own, as a Kubernetes pod.

No image build and no wait for replicas: the operator and Kubernetes run the pods. It
serves its health checks first, waits for the project's Redis (no crash loop while it
starts), then runs the Global Controller and watches its config: the config is a
mounted ConfigMap, and a change to its files reloads it in place. SIGTERM stops the
Global Controller and leaves the agents running.
"""

import hashlib
import logging
import os
import signal
import sys
import threading
from typing import NoReturn

from canyonos_core.controller.health import start_health_server
from canyonos_core.controller.orchestrator import TARGET_ENV
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.controller.utils.redis_utils import _wait_for_redis

logger = logging.getLogger(__name__)

CONFIG_WATCH_SECONDS = 10


def wait_for_redis(host, port):
    """Block until the project's Redis answers. Unlike a deploy, which fails after
    _wait_for_redis's timeout, the pod keeps waiting: the operator may still be
    starting Redis."""
    client = RedisClient(host=host, port=port)
    while True:
        try:
            _wait_for_redis(client, host, port)
            return
        except TimeoutError:
            logger.info(
                "Redis at %s:%s is not answering yet; still waiting.", host, port
            )


def config_fingerprint(config_dir):
    """A hash of every file in the config folder, read through symlinks: Kubernetes
    updates a mounted ConfigMap by swapping a symlink, so file times are no signal."""
    digest = hashlib.sha256()
    for name in sorted(os.listdir(config_dir)):
        path = os.path.join(config_dir, name)
        if name.startswith(".") or not os.path.isfile(path):
            continue  # the ConfigMap's ..data bookkeeping
        digest.update(name.encode())
        with open(path, "rb") as f:
            digest.update(f.read())
    return digest.hexdigest()


def watch_config(controller, config_dir, stop, interval=CONFIG_WATCH_SECONDS):
    """Reload the controller's config whenever the folder's files change, until `stop`
    is set. A broken edit is logged and the running config stays."""
    seen = config_fingerprint(config_dir)
    while not stop.wait(interval):
        try:
            current = config_fingerprint(config_dir)
        except OSError as e:
            logger.warning("Could not read the config folder: %s", e)
            continue
        if current == seen:
            continue
        seen = current
        logger.info("Config files changed; reloading.")
        try:
            controller.reload_config()
        except Exception as e:
            logger.error("Reload failed; keeping the running config: %s", e)


def _exit_with(error) -> NoReturn:
    """One CRITICAL line, not a traceback (as `canyonos deploy` reports a start that
    fails), then exit 1: the pod's log and status show the reason."""
    logger.critical("%s", error)
    sys.exit(1)


def run(config_path):
    """Run the Global Controller in a Kubernetes pod until SIGTERM."""
    if os.environ.get(TARGET_ENV) != "kubernetes":
        raise SystemExit(
            f"run-gc runs the Global Controller on Kubernetes; set {TARGET_ENV}=kubernetes."
        )
    redis_host = os.environ.get("CANYONOS_REDIS_HOST")
    if not redis_host:
        # Waiting on a default host would wait forever; the operator always sets it.
        raise SystemExit(
            "CANYONOS_REDIS_HOST is unset: the operator names the project's Redis there."
        )

    # Started and ready once the Global Controller runs; alive while this process
    # answers, since a Global Controller that crashes exits.
    running = threading.Event()

    def check_running():
        return running.is_set(), "running" if running.is_set() else "starting"

    try:
        start_health_server(
            {
                "/startupz": check_running,
                "/readyz": check_running,
                "/livez": lambda: (True, "alive"),
            }
        )
    except RuntimeError as e:
        _exit_with(e)

    wait_for_redis(redis_host, int(os.environ.get("CANYONOS_REDIS_PORT") or 6379))

    from canyonos_core.controller.global_controller import GlobalController

    try:
        controller = GlobalController(config_path)
    except RuntimeError as e:
        _exit_with(e)
    stop = threading.Event()

    def on_stop(signum, frame):
        logger.info("Received %s; stopping.", signal.Signals(signum).name)
        stop.set()
        controller.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)

    threading.Thread(
        target=watch_config,
        args=(controller, os.path.dirname(os.path.abspath(config_path)), stop),
        name="config-watcher",
        daemon=True,
    ).start()

    running.set()
    controller.run()
