# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos init`, does the following:
1. Pull the Global Controller image
2. Start a container from it
3. Record where it's listening so cli knows where to send requests.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Formatting
from pyfiglet import figlet_format

from canyonos import env, project, ui
from canyonos.constants import (
    DEFAULT_REDIS_PORT,
    default_config_path,
    endpoint_api_port,
    existing_config_path,
    local_redis_port,
    port_in_use,
    private_ip,
    public_ip,
)
from canyonos.docker_cmd import (
    DOCKER_PULL_TIMEOUT,
    DOCKER_QUICK_TIMEOUT,
    DOCKER_RUN_TIMEOUT,
    cleanup_docker,
    run_docker,
)
from canyonos.port_utils import find_free_port, is_port_conflict


# Production is `env.PROD_CORE_IMAGE`; a developer can point this at the image
# built from their checkout instead.
GC_IMAGE = env.core_image
GC_CONTAINER_PORT = 8000

# Same network canyonos_core's own GlobalController creates for local-provider
# Redis/agent containers -- the GC container needs to be on it too, e.g. to
# resolve <container_name>:50051 for its own cleanup gRPC calls.
LOCAL_NETWORK = "canyonos-local"

# The project's workspace volume (`project.workspace_volume()`) is mounted here.
# Files are copied in via `canyonos sync` (docker cp), not mounted live, so
# host-side edits don't reach a running build. `canyonos stop` removes the
# volume, and since every deploy tears down the project's previous controller first,
# each deploy starts from an empty workspace.
GC_WORKSPACE_PATH = "/workspace"

# How to start the daemon behind each docker context, as (CLI command, macOS
# app). Keyed off the *active context* rather than which app is installed: with
# both Docker Desktop and OrbStack present, guessing by app bundle starts the
# wrong daemon and then waits out the timeout against a socket nothing is
# listening on.
DOCKER_RUNTIMES = {
    "orbstack": (["orb", "start"], "OrbStack"),
    "colima": (["colima", "start"], None),
    "desktop-linux": (None, "Docker"),
    "default": (None, "Docker"),
}
DOCKER_START_TIMEOUT = 60


def docker_running():
    """Return True if the Docker daemon answers `docker info`."""
    try:
        return (
            run_docker(
                ["docker", "info"],
                timeout=DOCKER_QUICK_TIMEOUT,
                action="docker info",
            ).returncode
            == 0
        )
    except RuntimeError:
        return False


def docker_start_command():
    """The command that starts the daemon for the active context, or None."""
    try:
        result = run_docker(
            ["docker", "context", "show"],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="docker context show",
        )
    except RuntimeError:
        return None

    context = result.stdout.strip() if result.returncode == 0 else "default"
    command, app = DOCKER_RUNTIMES.get(context, (None, "Docker"))
    if command and shutil.which(command[0]):
        return command
    # Docker Desktop's own CLI starts it wherever it was installed, on any OS;
    # --detach returns once the start is requested, and the caller waits on the daemon.
    if app == "Docker" and _docker_desktop_cli():
        return ["docker", "desktop", "start", "--detach"]
    # A Docker Desktop too old for that CLI, or another macOS app.
    if app and sys.platform == "darwin" and os.path.isdir(f"/Applications/{app}.app"):
        return ["open", "-a", app]
    return None


def _docker_desktop_cli():
    """True when `docker desktop` (Docker Desktop 4.37 and later) is installed."""
    try:
        result = run_docker(
            ["docker", "desktop", "version"],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="docker desktop version",
        )
    except RuntimeError:
        return False
    return result.returncode == 0


def _ensure_docker_running(timeout=DOCKER_START_TIMEOUT):
    if docker_running():
        return
    if shutil.which("docker") is None:
        raise RuntimeError(
            "Docker isn't installed. Install Docker Desktop or OrbStack, then rerun."
        )

    command = docker_start_command()
    if command is None:
        info = run_docker(
            ["docker", "info"], timeout=DOCKER_QUICK_TIMEOUT, action="docker info"
        )
        if "permission denied" in info.stderr.lower():
            raise RuntimeError(
                "Docker is running, but this user isn't allowed to use it. Add yourself "
                "to the docker group (`sudo usermod -aG docker $USER`, then log in "
                "again) and rerun."
            )
        # Linux/systemd wants root here; escalating on the user's behalf is not
        # this CLI's call to make.
        raise RuntimeError(
            "Docker isn't running, and there's no way to start it for the current "
            "docker context. Start it (on Linux: `sudo systemctl start docker`) and re-run."
        )

    ui.say(f"Docker isn't running -- starting it with `{' '.join(command)}`...")
    run_docker(
        command,
        timeout=DOCKER_START_TIMEOUT,
        action="Starting the Docker runtime",
        check=True,
    )

    deadline = time.time() + timeout
    with ui.status("Waiting for the Docker daemon..."):
        while time.time() < deadline:
            if docker_running():
                ui.ok("Docker is running.")
                return
            time.sleep(1)

    raise RuntimeError(
        f"Docker did not become ready within {timeout}s. Start it manually and re-run."
    )


GC_DOCKER_SOCKET = "/var/run/docker.sock"


def _docker_endpoint():
    """The engine plain `docker` calls reach right now (`DOCKER_HOST`, else the active
    context's): `unix://` a socket, `npipe://` Docker Desktop's pipe on Windows,
    `tcp://` or `ssh://` a remote engine. None when the context can't be read."""
    host = os.environ.get("DOCKER_HOST")
    if host is not None:
        return host
    result = subprocess.run(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def docker_is_local():
    """True when plain `docker` talks to an engine on this machine, so a folder here
    can be bind-mounted: a unix socket, or Docker Desktop's named pipe on Windows."""
    endpoint = _docker_endpoint()
    return endpoint is not None and endpoint.startswith(("unix://", "npipe://"))


def active_docker_socket():
    """Real path of the unix socket plain `docker` calls resolve to right now, or None
    for a named pipe or a remote endpoint (no socket on this machine to name)."""
    endpoint = _docker_endpoint()
    if endpoint is None or not endpoint.startswith("unix://"):
        return None
    return os.path.realpath(endpoint[len("unix://") :])


def docker_env(state):
    """Env for a host-side `docker` call that should target the exact engine
    a deploy's container was created on, rather than whatever context happens
    to be active now. None (inherit the caller's environment) for a state.json
    from before this was tracked, or a deploy whose DOCKER_HOST wasn't a plain
    unix socket.
    """
    socket = state.get("docker_socket")
    if not socket:
        return None
    return {**os.environ, "DOCKER_HOST": f"unix://{socket}"}


def _image_present(image):
    return (
        subprocess.run(
            ["docker", "image", "inspect", image], capture_output=True
        ).returncode
        == 0
    )


def _pull_image(image=GC_IMAGE):
    # The production image always comes from the registry. A dev image is
    # usually built locally and may not be in any registry at all, so use
    # whatever the daemon already holds before trying to pull it.
    if image != env.PROD_CORE_IMAGE and _image_present(image):
        return
    result = run_docker(
        ["docker", "pull", image],
        timeout=DOCKER_PULL_TIMEOUT,
        action=f"docker pull {image}",
    )
    if result.returncode != 0:
        if image == env.LOCAL_CORE_IMAGE:
            raise RuntimeError(
                f"No {image} image on this machine, and it is not in a registry. "
                "Build it from the repo root with `bun run canyonos:dev`."
            )
        raise RuntimeError(
            f"docker pull {image} failed: {result.stderr.strip() or result.stdout.strip()}"
        )


def _port_reachable(port, attempts=10, delay=0.5):
    """
    A successful `docker run` only means Docker accepted the port binding --
    not that traffic actually flows. Confirm the container is actually reachable before trusting it.
    """
    url = f"http://127.0.0.1:{port}/status"
    for _ in range(attempts):
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except (urllib.error.URLError, OSError):
            time.sleep(delay)
    return False


def _named_container(name=None):
    """(id, running) for the container holding exactly this name, or (None, False).
    The name defaults to this project's Global Controller container."""
    name = name or project.gc_container_name()
    try:
        result = run_docker(
            ["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting Docker container {name}",
        )
    except RuntimeError:
        return None, False
    if result.returncode != 0:
        return None, False
    fields = result.stdout.split()
    if not fields:
        return None, False
    return fields[0], fields[1:2] == ["true"]


def _free_container_name():
    """Remove a leftover container squatting on the project's Global Controller name.

    A fixed --name only works if nothing else holds it, and two things leave a
    dead holder behind: a crashed run whose state file is gone, and a failed
    port binding, since docker creates the container before it publishes ports.
    A *running* holder is something else entirely -- a live controller this CLI
    lost track of, e.g. another HOME sharing the daemon or a run whose state
    file never got written. Tearing it down would orphan the Redis and agent
    containers it spawned, so refuse the way the raw name conflict used to.
    """
    container_id, running = _named_container()
    if container_id is None:
        return
    if running:
        raise RuntimeError(
            f"The container name {project.gc_container_name()} is held by a running "
            f"Global Controller ({container_id[:12]}). Run `canyonos stop` from the "
            f"`{project.folder_name()}` folder to tear it down first."
        )
    failure = cleanup_docker(
        ["docker", "rm", "-f", container_id],
        action=f"Removing stale Docker container {container_id[:12]}",
        missing_text="No such container",
    )
    if failure:
        raise RuntimeError(failure)


def _create_workspace_volume():
    """Create the project's workspace volume up front, so it carries the project's
    label and shows in its Docker group; a volume that already exists is reused."""
    volume = project.workspace_volume()
    run_docker(
        ["docker", "volume", "create", *project.project_label_args(), volume],
        timeout=DOCKER_QUICK_TIMEOUT,
        action=f"Creating Docker volume {volume}",
        check=True,
    )


def _run_container(
    image=GC_IMAGE,
    port=GC_CONTAINER_PORT,
    redis_port=DEFAULT_REDIS_PORT,
    api_port=None,
    max_attempts=50,
):
    """Start this project's Global Controller container, published on 127.0.0.1 at
    `port`, or at the next free port after it, and tell it Redis's port and, for an
    endpoint whose port isn't set, the port it had last deploy."""
    start_port = port
    # The real socket behind whatever's active right now, not the
    # /var/run/docker.sock alias -- some other app can hold that alias and
    # point it at a different engine than the one every other `docker`
    # command here is actually using.
    active_socket = active_docker_socket()
    # Without a unix socket here (Docker Desktop's named pipe on Windows), the engine
    # still serves the alias inside its own VM, so that is what gets mounted.
    host_socket = active_socket or GC_DOCKER_SOCKET
    # Idempotent: succeeds silently if the network already exists (created by
    # this or a prior GC/Redis launch).
    network = run_docker(
        ["docker", "network", "create", LOCAL_NETWORK],
        timeout=DOCKER_QUICK_TIMEOUT,
        action=f"Creating Docker network {LOCAL_NETWORK}",
    )
    if (
        network.returncode != 0
        and "already exists" not in (network.stderr or "").lower()
    ):
        raise RuntimeError(
            f"Could not create Docker network {LOCAL_NETWORK}: "
            f"{network.stderr.strip() or network.stdout.strip()}"
        )
    host_private_ip = private_ip()
    host_public_ip = public_ip()
    _create_workspace_volume()
    for _ in range(max_attempts):
        _free_container_name()
        cmd = [
            "docker",
            "run",
            "-d",
            # As PID 1 the server ignores SIGTERM, making `docker stop` wait 10s.
            "--init",
            *project.project_label_args(),
            *project.gc_role_label_args(),
            "--name",
            project.gc_container_name(),
            "-p",
            f"127.0.0.1:{port}:{GC_CONTAINER_PORT}",
            "--network",
            LOCAL_NETWORK,
            # Docker-outside-of-Docker: GC shells out to `docker` to launch
            # Redis/agent containers, so it needs the host's real daemon --
            # specifically the same one this command itself just used, not
            # whatever the GC_DOCKER_SOCKET alias happens to point to.
            "-v",
            f"{host_socket}:{GC_DOCKER_SOCKET}",
            "-v",
            f"{project.workspace_volume()}:{GC_WORKSPACE_PATH}",
            "--add-host=host.docker.internal:host-gateway",
            "-e",
            "CANYONOS_REDIS_HOST=host.docker.internal",
            "-e",
            f"CANYONOS_REDIS_PORT={redis_port}",
            *(["-e", f"CANYONOS_LAST_API_PORT={api_port}"] if api_port else []),
            # So the GC's own docker-outside-of-docker calls resolve the
            # socket unambiguously too, instead of falling back to whatever
            # a bare `docker` invocation inside the container would default to.
            "-e",
            f"DOCKER_HOST=unix://{GC_DOCKER_SOCKET}",
            # The GC launches sibling containers (the machine metrics collector) from
            # its own image; it cannot read that from inside, so pass it in.
            "-e",
            f"CANYONOS_CONTROLLER_IMAGE={image}",
            # A bare name copies the host's value when set, so agent images match its CPU.
            "-e",
            "CANYONOS_DOCKER_PLATFORM",
            # Names and labels every container the GC launches with this project.
            "-e",
            f"{project.DOCKER_PROJECT_ENV}={project.project_name()}",
        ]
        if host_private_ip:
            cmd.extend(["-e", f"CANYONOS_PRIVATE_IP={host_private_ip}"])
        if host_public_ip:
            cmd.extend(["-e", f"CANYONOS_PUBLIC_IP={host_public_ip}"])
        cmd.append(image)  # image must come after all flags
        result = run_docker(
            cmd,
            timeout=DOCKER_RUN_TIMEOUT,
            action="Starting the Global Controller container",
        )
        if result.returncode == 0:
            container_id = result.stdout.strip()
            if not container_id:
                raise RuntimeError(
                    "Docker started the Global Controller but returned no container ID."
                )
            if _port_reachable(port):
                # Only a real socket on this machine is recorded: later host-side
                # `docker` calls are pointed at it, and the alias names no socket here.
                return container_id, port, active_socket
            # Port bound fine but never actually became reachable -- treat
            # like a conflict, since that's effectively what it is.
            failure = cleanup_docker(
                ["docker", "rm", "-f", container_id],
                action=f"Removing unreachable Global Controller {container_id[:12]}",
                missing_text="No such container",
            )
            if failure:
                raise RuntimeError(failure)
            port += 1
            continue
        if is_port_conflict(result.stderr):
            port += 1
            continue
        raise RuntimeError(
            "Could not start the CanyonOS controller container: "
            f"{result.stderr.strip()}"
        )
    raise RuntimeError(
        f"no free port found after {max_attempts} attempts starting at {start_port}"
    )


def _save_state(container_id, port, docker_socket=None, redis_port=None, api_port=None):
    """Atomically write GC state so interruption cannot truncate the old record."""
    state_dir = project.state_dir()
    os.makedirs(state_dir, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=state_dir,
            prefix="state.",
            suffix=".tmp",
            delete=False,
        ) as f:
            temporary_path = f.name
            json.dump(
                {
                    "container_id": container_id,
                    "port": port,
                    "docker_socket": docker_socket,
                    "redis_port": redis_port,
                    "api_port": api_port,
                },
                f,
            )
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, project.state_path())
    except Exception:
        if temporary_path is not None:
            try:
                os.remove(temporary_path)
            except FileNotFoundError:
                pass
        raise


def load_state(state_path=None):
    """Read this project's Global Controller container and port from its state file
    under `~/.canyonos/projects`, or from the state file at `state_path`."""
    state_path = state_path or project.state_path()
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        raise
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(
            f"Could not read CanyonOS state at {state_path}: {e}. "
            "Move or remove that file, then run `canyonos deploy` again."
        ) from None

    if (
        not isinstance(state, dict)
        or not isinstance(state.get("container_id"), str)
        or not state["container_id"]
        or not isinstance(state.get("port"), int)
        or not 1 <= state["port"] <= 65535
    ):
        raise RuntimeError(
            f"CanyonOS state at {state_path} is invalid. "
            "Move or remove that file, then run `canyonos deploy` again."
        )
    return state


def stop_existing():
    """Tear down a previously started Global Controller, if state records one.

    Without this each run starts another container on the next free port and
    orphans the last one, which then can't be reached through state.json.
    """
    # Deferred: stop.py imports from this module, so a top-level import cycles.
    from canyonos.stop import stop_project

    if os.path.isfile(project.state_path()) and stop_project(load_state()):
        ui.warn(
            "Starting a new Global Controller anyway; the leftovers above need cleaning up by hand."
        )


def _saved_state():
    """The last deploy's state, empty without a readable state file."""
    if not os.path.isfile(project.state_path()):
        return {}
    try:
        return load_state()
    except (OSError, RuntimeError):
        return {}


def remember_api_port(api_port):
    """Record the port the endpoint got, so the next deploy starts from it. Without a
    readable state file nothing is recorded, and the next deploy starts from 8080."""
    try:
        state = load_state()
    except (OSError, RuntimeError):
        return
    _save_state(
        state["container_id"],
        state["port"],
        state.get("docker_socket"),
        state.get("redis_port"),
        api_port,
    )


def redis_port_of(state):
    """The Redis port a deploy recorded; for a state file from a CLI that recorded
    none, the config's `redis.port`, else Redis's default."""
    return (
        state.get("redis_port")
        or local_redis_port(default_config_path())
        or DEFAULT_REDIS_PORT
    )


def run_init(banner=True, image=GC_IMAGE):
    """Replace any existing Global Controller with a fresh container from `image` and
    save its ID and port for later commands; run at the start of `canyonos deploy`.
    The container is published on the last deploy's port or 8000, or the next free
    port after it."""
    if banner:
        ui.gradient(figlet_format("CANYON OS", font="ansi_shadow", width=200))

    # Before stop_existing(), which shells out to docker itself.
    _ensure_docker_running()
    # Read before stop_existing() removes the state, so a redeploy keeps its ports.
    saved = _saved_state()
    preferred = saved.get("port") or GC_CONTAINER_PORT
    stop_existing()

    # After stop_existing(), so the last deploy's ports read as free.
    config_path = existing_config_path()
    # Without `api_port`, the reconciler picks the endpoint's port when Docker binds it.
    api_port = endpoint_api_port(config_path)
    if api_port is not None and port_in_use(api_port):
        raise RuntimeError(
            f"Port {api_port} is already in use, and the endpoint needs it. Free it, or "
            f"change `endpoint.api_port` in {config_path} or delete it so CanyonOS picks "
            "a free port."
        )
    # A taken `redis.port` is left to the Global Controller, which reuses this
    # project's own Redis when a crashed deploy left it running there.
    redis_port = local_redis_port(config_path)
    if redis_port is None:
        preferred_redis = saved.get("redis_port") or DEFAULT_REDIS_PORT
        redis_port = find_free_port(preferred_redis)
        if redis_port != preferred_redis:
            ui.warn(f"Port {preferred_redis} is taken, so Redis is on {redis_port}.")
    last_api_port = saved.get("api_port") if api_port is None else None

    with ui.status("Pulling Global Controller image..."):
        _pull_image(image)
    with ui.status("Starting Global Controller container..."):
        container_id, port, docker_socket = _run_container(
            image=image, port=preferred, redis_port=redis_port, api_port=last_api_port
        )
    try:
        _save_state(container_id, port, docker_socket, redis_port, last_api_port)
    except OSError as e:
        cleanup_failure = cleanup_docker(
            ["docker", "rm", "-f", container_id],
            action=f"Removing Global Controller {container_id[:12]}",
            missing_text="No such container",
        )
        detail = (
            f" Automatic cleanup also failed: {cleanup_failure}"
            if cleanup_failure
            else ""
        )
        raise RuntimeError(
            f"Could not save Global Controller state at {project.state_path()}: {e}. "
            f"Removed container {container_id[:12]}.{detail}"
        ) from None
    ui.ok(f"Global Controller running in container {container_id[:12]} on port {port}")
    if port != preferred:
        ui.warn(f"Port {preferred} is taken, so the Global Controller is on {port}.")
