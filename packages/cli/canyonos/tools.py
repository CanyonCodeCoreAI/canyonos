# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The command-line tools `canyonos provision` runs to make a cluster: Terraform and Helm,
at the versions pinned here. Each is downloaded once from its publisher into
~/.canyonos/tools and used only if its archive matches the SHA256 pinned here, so
every machine runs the same build and nothing needs installing by hand.
"""

import hashlib
import io
import os
import platform
import sys
import tarfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

DOWNLOAD_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class Tool:
    name: str
    version: str
    # The archive's URL; {version}, {os}, {arch} and {ext} are filled in.
    url: str
    # The program's path inside the archive, with {os}, {arch} and {exe} filled in.
    member: str
    # The archive's SHA256 for each "<os>-<arch>", as its publisher lists it.
    sha256: dict


TERRAFORM = Tool(
    "terraform",
    "1.17.2",
    "https://releases.hashicorp.com/terraform/{version}/terraform_{version}_{os}_{arch}.zip",
    "terraform{exe}",
    {
        "darwin-amd64": "66b472dcc36cf770d83757ed4d002c476174842c05c68637b40a7e99519cf3e1",
        "darwin-arm64": "da0c7ef278a911347862758e7573a5907365e66485c2637cf5c217c5e227992e",
        "linux-amd64": "e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b",
        "linux-arm64": "858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c",
        "windows-amd64": "2244b7a379ea8c4b224a2eab411b7288f41ef36316fca27ae4b51b1cf2a53024",
    },
)
# The Helm that `canyonos cluster up` and the release workflow run.
HELM = Tool(
    "helm",
    "3.17.3",
    "https://get.helm.sh/helm-v{version}-{os}-{arch}.{ext}",
    "{os}-{arch}/helm{exe}",
    {
        "darwin-amd64": "20ef8df4671349a6fc556a621be1170dd709c6c0cf5f7e83a2d9fb0515fd97fc",
        "darwin-arm64": "89aec43ce07b06239f1bba4a6507236bb48ae487bc5065a8e254d3ce58a16997",
        "linux-amd64": "ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd",
        "linux-arm64": "7944e3defd386c76fd92d9e6fec5c2d65a323f6fadc19bfb5e704e3eee10348e",
        "windows-amd64": "8ea93e2f6285e649dede583ac90ff8cdb938ca53ec6cf5fe909f2303fbc22d96",
    },
)


def tools_dir():
    return Path.home() / ".canyonos" / "tools"


def this_platform():
    """This machine as the tools' publishers name it: (os, arch)."""
    system = {"win32": "windows", "darwin": "darwin"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}
    if machine not in arch:
        raise RuntimeError(f"No {TERRAFORM.name} or {HELM.name} build for {machine}")
    return system, arch[machine]


def _download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "canyonos"})
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as reply:
            return reply.read()
    except OSError as e:
        raise RuntimeError(f"Couldn't download {url}: {e}") from None


def _extract(archive, member, is_zip):
    if is_zip:
        with zipfile.ZipFile(io.BytesIO(archive)) as files:
            return files.read(member)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as files:
        found = files.extractfile(member)
        if found is None:
            raise RuntimeError(f"{member} is missing from the archive")
        return found.read()


def path(tool):
    """The program of `tool` on this machine, downloaded and checked first if this is
    its first use. Raises RuntimeError when it can't be downloaded or doesn't match."""
    system, arch = this_platform()
    if f"{system}-{arch}" not in tool.sha256:
        # Windows on Arm: the cluster modules' providers aren't built for it.
        raise RuntimeError(f"CanyonOS can't provision clusters from {system}-{arch}")
    exe = ".exe" if system == "windows" else ""
    program = tools_dir() / f"{tool.name}-{tool.version}" / f"{tool.name}{exe}"
    if program.exists():
        return program
    is_zip = tool.url.endswith(".zip") or system == "windows"
    url = tool.url.format(
        version=tool.version, os=system, arch=arch, ext="zip" if is_zip else "tar.gz"
    )
    archive = _download(url)
    digest = hashlib.sha256(archive).hexdigest()
    if digest != tool.sha256[f"{system}-{arch}"]:
        raise RuntimeError(
            f"{url} doesn't match the SHA256 CanyonOS pins for it ({digest}), so it "
            "wasn't used."
        )
    contents = _extract(
        archive, tool.member.format(os=system, arch=arch, exe=exe), is_zip
    )
    program.parent.mkdir(parents=True, exist_ok=True)
    # Written beside it and renamed, so a run stopped halfway leaves no broken program.
    partial = program.with_name(program.name + ".partial")
    partial.write_bytes(contents)
    partial.chmod(0o755)
    os.replace(partial, program)
    return program
