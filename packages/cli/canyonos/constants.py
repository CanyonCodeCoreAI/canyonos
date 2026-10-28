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

_EC2_TOKEN_URL = "http://169.254.169.254/latest/api/token"
_EC2_PUBLIC_IP_URL = "http://169.254.169.254/latest/meta-data/public-ipv4"
_EC2_PRIVATE_IP_URL = "http://169.254.169.254/latest/meta-data/local-ipv4"

_metadata_cache = {}


CANYON_DIR = ".canyon"


def project_root():
    """Find the folder every project file is read from: `.canyon` when it exists in
    the current directory, else the current directory itself."""
    return CANYON_DIR if os.path.isdir(CANYON_DIR) else "."


def default_config_path():
    """Build the path of the Global Controller's `global_controller.yaml` inside the
    project root, whether or not the file is there."""
    return os.path.join(project_root(), "config", "global_controller.yaml")


def project_env_path():
    """Name the `.env` in the folder `canyonos` runs in; deploy passes its values to
    the agent replicas."""
    return ".env"


def existing_config_path():
    """`default_config_path()`, used by deploy and test; raises when the file is not
    there."""
    config_path = default_config_path()
    if not os.path.isfile(config_path):
        raise RuntimeError(
            f"No {config_path} here. Run `canyonos convert` first, or rerun from your "
            "project folder."
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
    """Return the host port the endpoint answers on, or None when the config has no
    `endpoint:` block or its `api_port` is not a port number, which the deploy's
    schema check then reports. Raises when the config is not valid YAML."""
    endpoint = (load_yaml(config_path, yaml.safe_load) or {}).get("endpoint")
    if not isinstance(endpoint, dict):
        return None
    port = endpoint.get("api_port", DEFAULT_API_PORT)
    return port if isinstance(port, int) and not isinstance(port, bool) else None


def endpoint_answers(api_port):
    """True when the endpoint on this machine gives any HTTP answer; the probe's
    unknown request id 404s, which still proves the server is up and listening."""
    try:
        urllib.request.urlopen(
            f"http://127.0.0.1:{api_port}/status/canyonos-test-probe", timeout=2
        )
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False
    return True


def local_redis_port(config_path):
    """Host port this machine's Redis is published on: `redis.port`, or the default."""
    config = read_config(config_path)
    if not isinstance(config, dict):
        return DEFAULT_REDIS_PORT
    redis = config.get("redis")
    if not isinstance(redis, dict):
        return DEFAULT_REDIS_PORT
    return _port_or_default(redis.get("port", DEFAULT_REDIS_PORT))


def _port_or_default(value):
    """`value` when it is a usable TCP port, else the default the runtime falls back to."""
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_REDIS_PORT
    return value if 1 <= value <= 65535 else DEFAULT_REDIS_PORT


def port_in_use(port):
    """True if this host port is already taken (cannot be bound).

    Bind-based, matching `port_utils.is_port_free`, so "in use" here means the
    same thing a container launcher will hit when it tries to publish the port --
    not merely "something is actively accepting connections".
    """
    return not is_port_free(port)


def dashboard_port(config_path):
    """Host port the local dashboard prefers to start on, falling back to the default."""
    return read_config(config_path).get("dashboard_port", DEFAULT_DASHBOARD_PORT)


def container_path(relative):
    """`relative`, a path under the project on this machine, as a Linux container
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

    The indent settings match the project's YAML style, so edits don't reflow
    list indentation: block sequences stay indented under their key.
    """
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    yaml_rt.indent(mapping=2, sequence=4, offset=2)
    return yaml_rt
