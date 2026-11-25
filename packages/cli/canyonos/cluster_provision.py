# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
What every cluster provisioner of `canyonos provision` shares: the folder each cluster
keeps on this machine, Terraform run on the cluster's module there, the kubectl context
it gets, CanyonOS installed on it, and the two parts of making and deleting one.

A cluster platform (ROSA, EKS, ...) is a `Platform`: how to sign in to its accounts, the
questions for its settings, its Terraform module's inputs and how kubectl signs in to
what the module made. Provisioning is then two parts:

- Part A asks: `Platform.sign_in` and `Platform.ask`, in menus, give the accounts and
  the settings.
- Part B makes: `make(platform, settings, accounts)` makes the cluster those settings
  describe and returns it as a `ProvisionedCluster`, asking nothing, so a command with
  flags or JSON, or the MCP server, can call it with settings of its own.
  `destroy(platform, cluster, accounts)` deletes one the same way.

`run_provision` and `run_teardown` join the two for `canyonos provision`'s menus.

A cluster's folder, ~/.canyonos/clusters/<name>, holds its record, a copy of the module
it was made with and the Terraform state, so tearing it down later uses the same
module even after the CLI is upgraded. It is readable only by you: the state holds the
cluster's admin password.
"""

import contextlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from types import SimpleNamespace

from canyonos import env, tools, ui
from canyonos.kubernetes_target import kubectl
from canyonos.os_support import make_private_dir, write_private_file
from canyonos.provision import CREATED_BY, PROVISION_ID_TAG, Cancelled, pick

RECORD_FILE = "cluster.json"
VARIABLES_FILE = "terraform.tfvars.json"
LOG_FILE = "terraform.log"
CHART = "oci://ghcr.io/canyoncodecoreai/charts/canyonos-operator"
CANYONOS_NAMESPACE = "canyonos-system"
# Terraform's progress lines, shown one at a time under the spinner.
PROGRESS = re.compile(
    r"^(\S+): (Creating|Still creating|Creation complete|Destroying|Still destroying"
    r"|Destruction complete|Modifying|Still modifying|Modifications complete)"
)
LOG_TAIL_LINES = 25
CONFIRM = "__confirm__"
INSTALL = "__install__"
SKIP_INSTALL = "__skip_install__"
REMOVE = "__remove__"


def _rosa():
    # Imported by name, not by a string, so the release build (Nuitka) bundles it.
    from canyonos.rosa_provision import platform

    return platform


# Each cluster platform's `Platform`, its module imported only when it is asked for.
PLATFORMS = {"rosa": _rosa}


def platforms():
    """The names of the cluster platforms this CLI can make, e.g. ["rosa"]."""
    return list(PLATFORMS)


def get_platform(name):
    """The `Platform` called `name`, its module imported only now."""
    if name not in PLATFORMS:
        raise RuntimeError(
            f"There is no cluster platform {name!r}; there is {', '.join(platforms())}."
        )
    return PLATFORMS[name]()


class Progress:
    """Where Part B says how it is going: in the terminal (a spinner for each step,
    then a line when it is done), or, given `report`, a function that takes one line,
    to that function alone, for a caller with no terminal of its own (the MCP server
    talks over stdout, so nothing may be printed there)."""

    def __init__(self, report=None):
        self.report = report

    @contextlib.contextmanager
    def step(self, message):
        """A step that takes a while; `.update(line)` on what it yields says where it is."""
        if self.report:
            self.report(message)
            yield SimpleNamespace(update=self.report)
            return
        with ui.status(message) as spinner:
            yield spinner

    def done(self, message):
        (self.report or ui.ok)(message)

    def note(self, message):
        (self.report or ui.hint)(message)

    def warn(self, message):
        (self.report or ui.warn)(message)


def clusters_dir():
    return Path.home() / ".canyonos" / "clusters"


@dataclass
class Cluster:
    """What provisioning recorded about a cluster it made from this machine."""

    name: str
    platform: str
    region: str
    account: str
    # The kubectl context, cluster and user it gets, all of this name.
    context: str
    provision_id: str = field(default_factory=lambda: secrets.token_hex(3))
    created: str = field(
        default_factory=lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    )

    @property
    def dir(self):
        return clusters_dir() / self.name

    def tags(self):
        """The tags CanyonOS puts on everything it makes for this cluster."""
        return {"CreatedBy": CREATED_BY, PROVISION_ID_TAG: self.provision_id}

    def save(self):
        make_private_dir(self.dir)
        write_private_file(self.dir / RECORD_FILE, json.dumps(asdict(self), indent=2))


def recorded_clusters(platform):
    """The clusters of `platform` provisioned from this machine, oldest first."""
    found = []
    for record in sorted(clusters_dir().glob(f"*/{RECORD_FILE}")):
        cluster = Cluster(**json.loads(record.read_text(encoding="utf-8")))
        if cluster.platform == platform:
            found.append(cluster)
    return sorted(found, key=lambda cluster: cluster.created)


def write_module(cluster, module, variables):
    """Copy the Terraform module `module` this CLI ships into the cluster's folder, with
    `variables` as its inputs."""
    make_private_dir(cluster.dir)
    source = resources.files("canyonos") / "terraform" / module
    for item in source.iterdir():
        if item.is_file():
            (cluster.dir / item.name).write_bytes(item.read_bytes())
    write_private_file(cluster.dir / VARIABLES_FILE, json.dumps(variables, indent=2))


class Terraform:
    """Terraform run in a cluster's folder, with `env` added to its environment: the
    cloud's credentials, never written to disk."""

    def __init__(self, cluster, env):
        self.dir = cluster.dir
        self.env = env

    def _environment(self):
        plugins = tools.tools_dir() / "terraform-plugins"
        plugins.mkdir(parents=True, exist_ok=True)
        return {
            **os.environ,
            **self.env,
            "TF_IN_AUTOMATION": "1",
            "TF_INPUT": "0",
            "CHECKPOINT_DISABLE": "1",
            # Shared by every cluster, so the providers download once per machine.
            "TF_PLUGIN_CACHE_DIR": str(plugins),
        }

    def run(self, args, message, progress=None):
        """Run `terraform <args>` as a step of `progress` (the terminal's spinner by
        default) showing `message` and Terraform's latest step, every line kept in the
        folder's log. Raises RuntimeError with the log's last lines when it fails. On
        Ctrl+C, Terraform stops cleanly itself and keeps its state; this waits for
        that, then raises KeyboardInterrupt."""
        program = tools.path(tools.TERRAFORM)
        log_path = self.dir / LOG_FILE
        tail = []
        with (
            log_path.open("a", encoding="utf-8") as log,
            (progress or Progress()).step(message) as spinner,
        ):
            log.write(f"\n$ terraform {' '.join(args)}\n")
            process = subprocess.Popen(
                [str(program), *args, "-no-color"],
                # Never this process's stdin: it may be the MCP server's channel.
                stdin=subprocess.DEVNULL,
                cwd=self.dir,
                env=self._environment(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            try:
                for line in process.stdout:
                    log.write(line)
                    tail = [*tail[-LOG_TAIL_LINES + 1 :], line.rstrip()]
                    step = PROGRESS.match(line)
                    if step:
                        spinner.update(f"{message} {step.group(1)}: {step.group(2)}")
                process.wait()
            except KeyboardInterrupt:
                process.wait()
                raise
        if process.returncode:
            raise RuntimeError(
                f"terraform {args[0]} failed:\n"
                + "\n".join(tail)
                + f"\nThe whole log is in {log_path}"
            )

    def made_nothing(self):
        """True when Terraform's state records nothing made: no state yet (it stopped
        before making anything), or an empty one."""
        state = self.dir / "terraform.tfstate"
        if not state.exists():
            return True
        try:
            return not json.loads(state.read_text(encoding="utf-8")).get("resources")
        except ValueError:
            return False

    def output(self):
        """The module's outputs, sensitive ones included, by name."""
        program = tools.path(tools.TERRAFORM)
        result = subprocess.run(
            [str(program), "output", "-json"],
            stdin=subprocess.DEVNULL,
            cwd=self.dir,
            env=self._environment(),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode:
            raise RuntimeError(f"terraform output failed: {result.stderr.strip()}")
        return {name: item["value"] for name, item in json.loads(result.stdout).items()}


def use_context(cluster, server, token):
    """Add the kubectl context of the cluster, signing in with `token`, and make it
    the current one."""
    name = cluster.context
    kubectl(["config", "set-cluster", name, f"--server={server}"])
    kubectl(["config", "set-credentials", name, f"--token={token}"])
    kubectl(["config", "set-context", name, f"--cluster={name}", f"--user={name}"])
    kubectl(["config", "use-context", name])


def remove_context(cluster):
    """Remove the cluster's kubectl context, cluster and user, where they exist."""
    for kind in ("context", "cluster", "user"):
        kubectl(["config", f"delete-{kind}", cluster.context], check=False)


def install_canyonos(cluster, chart_version, values=()):
    """Install CanyonOS of `chart_version` from the chart its release published, on
    the cluster, with `values` (Helm `--set` arguments) added, and Helm waiting until
    the operator, the builder and the dashboard are ready. Run again, it upgrades it."""
    helm = tools.path(tools.HELM)
    result = subprocess.run(
        [str(helm), "upgrade", "--install", "canyonos", CHART,
         "--version", chart_version, "--kube-context", cluster.context,
         "--namespace", CANYONOS_NAMESPACE, "--create-namespace", "--take-ownership",
         "--wait", "--timeout", "15m", *values],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1200,
    )  # fmt: skip
    if result.returncode:
        raise RuntimeError(
            f"Installing CanyonOS {chart_version} failed: "
            f"{(result.stderr or result.stdout).strip()}"
        )


def empty_cluster(cluster):
    """Delete the namespaces CanyonOS workflows and its dashboard run in, so their
    disks and load balancers are removed by the cluster before it is deleted. Returns
    False when the cluster couldn't be reached to do so."""
    found = kubectl(
        ["--context", cluster.context, "get", "canyonprojects", "--all-namespaces",
         "-o", "jsonpath={.items[*].metadata.namespace}"],
        check=False,
        timeout=60,
    )  # fmt: skip
    if found.returncode:
        reachable = kubectl(
            ["--context", cluster.context, "get", "namespaces", "-o", "name"],
            check=False,
            timeout=60,
        )
        return reachable.returncode == 0
    namespaces = sorted(set(found.stdout.split()) | {"canyonos-dashboard"})
    kubectl(
        ["--context", cluster.context, "delete", "namespace", *namespaces,
         "--ignore-not-found", "--wait", "--timeout=10m"],
        timeout=660,
    )  # fmt: skip
    return True


def _remove_folder(folder):
    """Delete `folder` with everything in it, read-only files too: git, which
    Terraform downloads some modules with, makes its files read-only, and Windows
    won't delete a read-only file."""

    def writable_then_retry(remove, path, _error):
        os.chmod(path, stat.S_IWRITE)
        remove(path)

    if not folder.exists():
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(folder, onexc=writable_then_retry)
    else:
        shutil.rmtree(folder, onerror=writable_then_retry)


def forget(cluster):
    """Remove what this machine keeps of a cluster that is gone."""
    remove_context(cluster)
    _remove_folder(cluster.dir)


# --- Platforms, and the two parts of provisioning ---------------------------------


@dataclass
class Accounts:
    """The accounts a platform signed in to: all Part B needs from them."""

    # The cloud account the cluster is made in, as its record keeps it.
    account: str

    def terraform_env(self, region):
        """The environment Terraform signs in with in `region`. Never saved."""
        raise NotImplementedError


@dataclass(kw_only=True)
class ClusterSettings:
    """What every platform's settings hold. Plain data: a platform adds its own fields,
    and a caller without menus can fill them in itself."""

    name: str
    region: str
    # Install CanyonOS of this CLI's release once the cluster is ready.
    install: bool = True


@dataclass
class ProvisionedCluster:
    """A cluster Part B made, as data a caller can print or return."""

    name: str
    platform: str
    region: str
    account: str
    # The kubectl context it made, signed in as a cluster-admin ServiceAccount.
    context: str
    api_url: str
    console_url: str | None
    # Where this machine keeps its record and Terraform state.
    folder: str
    # The CanyonOS version installed, or None.
    canyonos: str | None
    # What else the platform has to say about it, e.g. the console's admin user.
    details: dict = field(default_factory=dict)


class Platform:
    """One kind of cluster `canyonos provision` makes. Its Terraform module is
    canyonos/terraform/<name>, and must output `api_url` (and may output
    `console_url`)."""

    # The record's platform and the module's folder, e.g. "rosa".
    name = ""
    # How people call it, e.g. "ROSA".
    title = ""
    # Rough minutes to make and to delete one, for the progress messages.
    make_minutes = 20
    delete_minutes = 15
    # Its `ClusterSettings`, for a caller that fills them in itself.
    settings_type = ClusterSettings

    def errors(self):
        """The errors its cloud libraries raise, beside OSError and RuntimeError."""
        return ()

    def sign_in(self):
        """Part A: sign in to the accounts it needs, in menus. Returns `Accounts`."""
        raise NotImplementedError

    def ask(self, accounts):
        """Part A: ask for its settings, in menus. Returns its `ClusterSettings`."""
        raise NotImplementedError

    def accounts_from_environment(self):
        """Sign in without asking, from what the environment holds (a cloud profile,
        tokens), for a caller with no terminal. Returns `Accounts`, or raises
        RuntimeError saying what to set."""
        raise NotImplementedError

    def reusable(self, accounts, region):
        """What already exists in the account that a new cluster could use instead of
        making its own (a network, an identity configuration, ...), by kind: lists of
        dicts, each with the id its settings take."""
        return {}

    def complete(self, settings, accounts):
        """`settings` with what a caller left out filled in, where the default
        depends on the accounts (e.g. the newest version). Returns new settings."""
        return settings

    def summary(self, settings, accounts):
        """Lines saying what making the cluster makes, for you to confirm."""
        raise NotImplementedError

    def variables(self, settings, accounts, cluster):
        """The inputs of its Terraform module, `cluster.tags()` among the tags."""
        raise NotImplementedError

    def connect(self, cluster, outputs):
        """Sign kubectl in to what the module made, as the context `cluster.context`,
        current, with a token canyonos can send. Returns details to keep in the
        result."""
        raise NotImplementedError

    def check(self, settings, accounts):
        """Before anything is made: raise RuntimeError saying what the settings or the
        cloud would refuse, when the platform can tell without making anything."""

    def chart_values(self, settings):
        """Helm `--set` arguments the CanyonOS chart needs on this platform."""
        return []

    def clear_destroy_blocker(self, cluster, accounts, outputs, error):
        """Remove what made Terraform's destroy fail with `error`, when the platform
        knows it. Returns True to run the destroy again."""
        return False

    def show_next_steps(self, made):
        """What to do with the cluster now, after `canyonos provision` made it."""


def require_kubectl():
    if not shutil.which("kubectl"):
        raise RuntimeError(
            "kubectl is not installed or not on PATH: "
            "https://kubernetes.io/docs/tasks/tools/"
        )


def check_account(cluster, accounts):
    if accounts.account != cluster.account:
        raise RuntimeError(
            f"{cluster.name} is in account {cluster.account}; these credentials are "
            f"for {accounts.account}."
        )


def make(platform, settings, accounts, report=None):
    """Part B: make the cluster `settings` describe, sign kubectl in to it and, if the
    settings say so, install CanyonOS, asking nothing. Returns a `ProvisionedCluster`.
    What a run that fails partway made is recorded, for `destroy` to remove. Progress
    goes to the terminal, or only to `report` (a function taking a line) when given."""
    progress = Progress(report)
    require_kubectl()
    settings = platform.complete(settings, accounts)
    cluster = Cluster(
        name=settings.name,
        platform=platform.name,
        region=settings.region,
        account=accounts.account,
        context=f"canyonos-{settings.name}",
    )
    if (cluster.dir / RECORD_FILE).exists():
        raise RuntimeError(
            f"This machine already provisioned a cluster named {cluster.name}."
        )
    # Left by a cluster already torn down, whose folder couldn't all be removed.
    _remove_folder(cluster.dir)
    platform.check(settings, accounts)
    cluster.save()
    write_module(
        cluster, platform.name, platform.variables(settings, accounts, cluster)
    )
    terraform = Terraform(cluster, accounts.terraform_env(settings.region))
    try:
        terraform.run(["init"], "Downloading Terraform's providers...", progress)
        terraform.run(
            ["apply", "-auto-approve"],
            f"Making the cluster {cluster.name} (about {platform.make_minutes} "
            "minutes)...",
            progress,
        )
    except (RuntimeError, KeyboardInterrupt):
        if terraform.made_nothing():
            forget(cluster)
            progress.note("Nothing was made, so there is nothing to tear down.")
        else:
            progress.note(
                f"What was made so far is recorded in {cluster.dir}: run `canyonos "
                "provision` and choose Tear down to remove it."
            )
        raise
    outputs = terraform.output()
    with progress.step("Signing in to the cluster..."):
        details = platform.connect(cluster, outputs)
    progress.done(f"Cluster {cluster.name} is ready; kubectl now points at it")
    canyonos = None
    if settings.install:
        with progress.step(f"Installing CanyonOS {env.PROD_CHART_VERSION}..."):
            install_canyonos(
                cluster, env.PROD_CHART_VERSION, platform.chart_values(settings)
            )
        canyonos = env.PROD_CHART_VERSION
        progress.done(f"CanyonOS {canyonos} is installed")
    return ProvisionedCluster(
        name=cluster.name,
        platform=platform.name,
        region=cluster.region,
        account=cluster.account,
        context=cluster.context,
        api_url=outputs["api_url"],
        console_url=outputs.get("console_url"),
        folder=str(cluster.dir),
        canyonos=canyonos,
        details=details or {},
    )


def destroy(platform, cluster, accounts, report=None):
    """Part B: delete a cluster this machine provisioned, with its workflows and
    everything its module made, asking nothing; then forget it here. Progress goes to
    the terminal, or only to `report` when given."""
    progress = Progress(report)
    check_account(cluster, accounts)
    if not empty_cluster(cluster):
        progress.warn(
            "Couldn't reach the cluster to remove its workflows first; deleting it "
            "anyway."
        )
    terraform = Terraform(cluster, accounts.terraform_env(cluster.region))
    # Read first: a destroy that fails partway may have removed the outputs.
    outputs = terraform.output()
    message = (
        f"Deleting the cluster {cluster.name} (about {platform.delete_minutes} "
        "minutes)..."
    )
    try:
        terraform.run(["destroy", "-auto-approve"], message, progress)
    except RuntimeError as error:
        if not platform.clear_destroy_blocker(cluster, accounts, outputs, str(error)):
            raise
        terraform.run(["destroy", "-auto-approve"], message, progress)
    forget(cluster)


def run_provision(platform):
    """`canyonos provision` → Provision → `platform`: Part A in menus, a summary to
    confirm, then Part B. Returns True once the cluster is ready, False if you backed
    out or a step failed."""
    try:
        require_kubectl()
        accounts = platform.sign_in()
        # What the answers imply (e.g. an existing network's zones), for the check
        # and the summary as for make().
        settings = platform.complete(platform.ask(accounts), accounts)
        with ui.status("Checking the account allows it..."):
            platform.check(settings, accounts)
        ui.say("This makes:")
        for line in platform.summary(settings, accounts):
            ui.say(f"  {line}")
        if settings.install:
            ui.say(f"  Then CanyonOS {env.PROD_CHART_VERSION}")
        ui.hint(
            "The cloud bills the cluster and what it runs on by the hour until it is "
            f"torn down. Making it takes about {platform.make_minutes} minutes."
        )
        pick(
            [(CONFIRM, "Make the cluster", None)],
            "Make it? Nothing has been created yet; esc stops here.",
        )
        made = make(platform, settings, accounts)
        platform.show_next_steps(made)
        ui.hint(
            "When you're done, run `canyonos provision` and choose Tear down to "
            "delete the cluster with everything made for it."
        )
        return True
    except (Cancelled, KeyboardInterrupt):
        ui.say("Provisioning stopped.")
    except (OSError, RuntimeError, *platform.errors()) as e:
        ui.fail(f"Provisioning failed: {e}")
    return False


def run_teardown(platform):
    """`canyonos provision` → Tear down → `platform`: choose one of the clusters this
    machine provisioned, sign in, confirm, then Part B. Returns True once it is gone
    or there was none, False if you backed out or a step failed."""
    try:
        clusters = recorded_clusters(platform.name)
        if not clusters:
            ui.say(f"No {platform.title} clusters were provisioned from this machine.")
            return True
        cluster = pick(
            [
                (
                    cluster,
                    cluster.name,
                    f"Account {cluster.account}, {cluster.region}, made "
                    f"{cluster.created} UTC",
                )
                for cluster in clusters
            ],
            "Which cluster should be torn down? Its workflows are removed with it.",
        )
        accounts = platform.sign_in()
        check_account(cluster, accounts)
        ui.say(
            f"This deletes the cluster {cluster.name}, its workflows and their disks, "
            "and everything made for it."
        )
        pick(
            [(REMOVE, "Delete the cluster and everything made for it", None)],
            "Delete it? This can't be undone; esc stops here.",
        )
        destroy(platform, cluster, accounts)
        ui.ok(f"Deleted the cluster {cluster.name} and everything made for it")
        return True
    except (Cancelled, KeyboardInterrupt):
        ui.say("Nothing removed.")
    except (OSError, RuntimeError, *platform.errors()) as e:
        ui.fail(f"Teardown failed: {e}")
    return False


def choose_install():
    """Whether to install CanyonOS: always from a released CLI. A development CLI's
    checkout may differ from the published release of its version."""
    if env.is_production:
        return True
    return (
        pick(
            [
                (
                    INSTALL,
                    f"Yes, the published CanyonOS {env.PROD_CHART_VERSION}",
                    "The operator, builder and dashboard of that release.",
                ),
                (
                    SKIP_INSTALL,
                    "No, leave CanyonOS out",
                    "Install it yourself later, e.g. built from this checkout.",
                ),
            ],
            f"This CLI runs from a checkout ({env.environment}). Install CanyonOS on "
            "the cluster once it is ready?",
        )
        == INSTALL
    )
