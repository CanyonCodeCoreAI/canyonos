# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos_core.cli run-gc`: the Global Controller on its own, as a Kubernetes pod.

No image build and no wait for replicas: the operator and Kubernetes run the pods. It
waits for the project's Redis (no crash loop while it starts), then runs the Global
Controller and watches its config: the config is a mounted ConfigMap, and a change to
its files reloads it in place. SIGTERM stops the Global Controller and leaves the
agents running.
"""

import hashlib
import logging
import os
import signal
import sys
import threading

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


def run(config_path):
    """Run the Global Controller in a Kubernetes pod until SIGTERM."""
    if os.environ.get(TARGET_ENV) != "kubernetes":
        raise SystemExit(
            f"run-gc runs the Global Controller on Kubernetes; set {TARGET_ENV}=kubernetes."
        )

    wait_for_redis(
        os.environ.get("CANYONOS_REDIS_HOST", "localhost"),
        int(os.environ.get("CANYONOS_REDIS_PORT") or 6379),
    )

    from canyonos_core.controller.global_controller import GlobalController

    controller = GlobalController(config_path)
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

    controller.run()
