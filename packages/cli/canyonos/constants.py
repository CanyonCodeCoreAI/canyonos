# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Shared helpers for the canyonos CLI.

Config/data layer. Holds shared values and parsing helpers"""

import codecs
import os
import urllib.error
import urllib.request

import yaml
from ruamel.yaml import YAML
from ruamel.yaml.error import MarkedYAMLError

from canyonos.port_utils import is_port_free

DEFAULT_API_PORT = 8080
DEFAULT_REDIS_PORT = 6379
DEFAULT_DASHBOARD_PORT = 8081
DEFAULT_DASHBOARD_API_PORT = 3000
# The dashboard's API by its container name, on the network each workflow group shares
# with it.
LOCAL_DASHBOARD_ENDPOINT = "http://canyonos-dashboard-api:3000"

_EC2_TOKEN_URL = "http://169.254.169.254/latest/api/token"
_EC2_PUBLIC_IP_URL = "http://169.254.169.254/latest/meta-data/public-ipv4"
_EC2_PRIVATE_IP_URL = "http://169.254.169.254/latest/meta-data/local-ipv4"

_metadata_cache = {}


CANYON_DIR = ".canyon"
# A workflow group's settings, in the folder `canyonos deploy` runs from.
DEPLOYMENT_CONFIG = "workflow_group.yaml"
# What a workflow group's config was called before; see deployment_config_path.
OLD_DEPLOYMENT_CONFIG = "deployment.yaml"


def workflow_folder(folder="."):
    """Find the folder every file of the workflow in `folder` is read from: its
    `.canyon` when it has one, else `folder` itself."""
    canyon = os.path.join(folder, CANYON_DIR)
    return canyon if os.path.isdir(canyon) else folder


def workflow_root():
    """`workflow_folder()` of the current directory."""
    return workflow_folder()


def workflow_config_path(root):
    """Build the path of a workflow's `config/workflow_config.yaml` inside its root,
    whether or not the file is there."""
    return os.path.join(root, "config", "workflow_config.yaml")


def deployment_config_path():
    """The workflow group's `workflow_group.yaml`, in the folder `canyonos` runs from,
    whether or not the file is there. Raises when the folder still has it under its
    old name."""
    if not os.path.exists(DEPLOYMENT_CONFIG) and os.path.isfile(OLD_DEPLOYMENT_CONFIG):
        raise RuntimeError(
            f"{OLD_DEPLOYMENT_CONFIG} is now called {DEPLOYMENT_CONFIG}: rename it, "
            "and its deployment_id to workflow_group_id."
        )
    return DEPLOYMENT_CONFIG


def workflow_env_path(folder="."):
    """Name the `.env` in a workflow's folder; deploy passes its values to the
    workflow's agent replicas."""
    return os.path.join(folder, ".env")


def existing_config_path():
    """`deployment_config_path()`; raises when the file is not there."""
    config_path = deployment_config_path()
    if not os.path.isfile(config_path):
        raise RuntimeError(
            f"No {config_path} here. Run `canyonos deploy <workflow folder>...` from "
            "the folder that holds the workflow group."
        )
    return config_path


def load_yaml(config_path, load):
    """The file at `config_path` parsed by `load`. A YAML syntax error is raised as a
    RuntimeError naming the line and what is wrong there."""
    with open(config_path, encoding="utf-8") as f:
        try:
            return load(f)
        except (yaml.MarkedYAMLError, MarkedYAMLError) as e:
            raise RuntimeError(
                f"{config_path} line {e.problem_mark.line + 1}: not valid YAML "
                f"({e.problem}). Fix it and rerun."
            ) from None


def read_config(config_path):
    """The config at `config_path` as loaded YAML, or {} when it is missing, empty or
    not valid YAML."""
    try:
        with open(config_path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def public_ip(timeout=0.3):
    """This machine's public IP via the EC2 IMDSv2 metadata service, or None.

    Only meaningful on an EC2 machine -- a laptop or any other host simply
    fails to reach the link-local metadata address and gets None back. Kept to
    a short timeout and cached for the life of the process so a non-EC2 host
    doesn't pay a network-timeout tax on every call site that wants a display
    host (deploy summary, `status`, etc).
    """
    return _ec2_metadata(_EC2_PUBLIC_IP_URL, timeout)


def private_ip(timeout=0.3):
    """This machine's private IP via the EC2 IMDSv2 metadata service, or None
    off EC2; cached like `public_ip`."""
    return _ec2_metadata(_EC2_PRIVATE_IP_URL, timeout)


def _ec2_metadata(url, timeout):
    """One EC2 IMDSv2 metadata value, or None; it and the token are fetched once per process."""
    if url in _metadata_cache:
        return _metadata_cache[url]
    _metadata_cache[url] = None
    try:
        if _EC2_TOKEN_URL not in _metadata_cache:
            _metadata_cache[_EC2_TOKEN_URL] = None
            token_req = urllib.request.Request(
                _EC2_TOKEN_URL,
                method="PUT",
                headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
            )
            _metadata_cache[_EC2_TOKEN_URL] = (
                urllib.request.urlopen(token_req, timeout=timeout).read().decode()
            )
        token = _metadata_cache[_EC2_TOKEN_URL]
        if token:
            ip_req = urllib.request.Request(
                url, headers={"X-aws-ec2-metadata-token": token}
            )
            _metadata_cache[url] = (
                urllib.request.urlopen(ip_req, timeout=timeout).read().decode().strip()
                or None
            )
    except (OSError, urllib.error.URLError):
        pass
    return _metadata_cache[url]


def endpoint_api_port(config_path):
    """Return the endpoint's `api_port` from the config, or None when the config sets
    none, or sets something other than a port number, which the deploy's schema check
    then reports. Raises when the config is not valid YAML."""
    endpoint = (load_yaml(config_path, yaml.safe_load) or {}).get("endpoint")
    if not isinstance(endpoint, dict):
        return None
    port = endpoint.get("api_port")
    return port if isinstance(port, int) and not isinstance(port, bool) else None


# What an endpoint answers before the Global Controller has published the API key
# hash (`auth.not_ready`): up, but refusing every request.
NOT_READY_STATUS = 503


def endpoint_answers_at(url, timeout):
    """True when the endpoint at `url` is up and taking requests: any HTTP answer to
    the probe, which sends no key, counts (a 401 is the endpoint checking its API key,
    and the 404 of its unknown request id comes with no key set), except the 503 it
    answers while it waits for the API key hash."""
    try:
        urllib.request.urlopen(
            f"{url.rstrip('/')}/status/canyonos-test-probe", timeout=timeout
        )
    except urllib.error.HTTPError as error:
        return error.code != NOT_READY_STATUS
    except OSError:
        return False
    return True


def endpoint_answers(api_port):
    """`endpoint_answers_at` for the endpoint on this machine."""
    return endpoint_answers_at(f"http://127.0.0.1:{api_port}", timeout=2)


def local_redis_port(config_path):
    """Return this machine's Redis port from the config's `redis.port`, or None when it
    sets none, or sets something other than a port number."""
    config = read_config(config_path)
    redis = config.get("redis") if isinstance(config, dict) else None
    port = redis.get("port") if isinstance(redis, dict) else None
    return port if isinstance(port, int) and not isinstance(port, bool) else None


def port_in_use(port):
    """True if this host port is already taken (cannot be bound).

    Bind-based, matching `port_utils.is_port_free`, so "in use" here means the
    same thing a container launcher will hit when it tries to publish the port --
    not merely "something is actively accepting connections".
    """
    return not is_port_free(port)


def dashboard_port(config_path):
    """The `dashboard_port` the config sets, or None."""
    return read_config(config_path).get("dashboard_port")


def sends_to_dashboard(config_path):
    """Whether the config's telemetry reaches the local dashboard: it sets no
    `otel.destinations`, so the default applies, or lists the dashboard's address."""
    destinations = (read_config(config_path).get("otel") or {}).get("destinations")
    return not destinations or any(
        destination["endpoint"] == LOCAL_DASHBOARD_ENDPOINT
        for destination in destinations
    )


def container_path(relative):
    """`relative`, a path under the workflow on this machine, as a Linux container
    names it: with forward slashes, which this machine reads too, even on Windows."""
    return relative.replace(os.sep, "/")


def write_config(config_path, data, yaml_rt):
    """Write `data`, loaded with `yaml_rt` (round_trip_yaml), back to the user's YAML
    file at `config_path`: UTF-8, with the line endings and the byte-order mark the
    file already has (a Windows checkout's CRLF stays CRLF, LF stays LF), so only
    what changed shows in git."""
    encoding, newline = _text_layout(config_path)
    with open(config_path, "w", encoding=encoding, newline=newline) as f:
        yaml_rt.dump(data, f)


def _text_layout(path):
    """The encoding name and line ending that write the file at `path` back the way it
    is: "utf-8-sig" keeps a byte-order mark; "\\n" for a new or one-line file."""
    try:
        with open(path, "rb") as f:
            head = f.read(64 * 1024)
    except FileNotFoundError:
        return "utf-8", "\n"
    encoding = "utf-8-sig" if head.startswith(codecs.BOM_UTF8) else "utf-8"
    return encoding, "\r\n" if b"\r\n" in head else "\n"


def round_trip_yaml():
    """Loader that preserves comments, key order, quoting and ${ENV} refs.

    The indent settings match the config files' YAML style, so edits don't reflow
    list indentation: block sequences stay indented under their key.
    """
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    yaml_rt.indent(mapping=2, sequence=4, offset=2)
    return yaml_rt
