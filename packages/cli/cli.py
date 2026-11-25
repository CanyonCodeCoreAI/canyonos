# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Almost all commands will be executing on the canyonos container spawned by deploy
Commands like doctor and new_app will not though
"""

import argparse
import contextlib
import importlib.metadata
import json
import os
import signal
import sys

from canyonos import context, deployment, env, records, ui
from canyonos.chat import run_chat
from canyonos.clean import run_clean
from canyonos.config import run_config
from canyonos.contact import run_contact
from canyonos.context import run_list, run_select_context
from canyonos.curl import run_curl
from canyonos.convert import (
    AGENTS as CONVERT_AGENTS,
    DEFAULT_AGENT,
    DEFAULT_SCOPE,
    SCOPES as CONVERT_SCOPES,
    run_convert,
)
from canyonos.dashboard import run_open_dashboard
from canyonos.deploy import run_deploy
from canyonos.doctor import run_doctor
from canyonos import kubernetes_local, kubernetes_target
from canyonos.feedback import run_feedback
from canyonos.forwards import FORWARD_ARGUMENT, run_forward
from canyonos.api import NoDeployError
from canyonos.logs import run_logs
from canyonos.new_app import run_new_app
from canyonos.os_support import prepare_console
from canyonos.quickstart import run_quickstart
from canyonos.serve import run_serve
from canyonos.provision import run_provision
from canyonos.status import _report_status, run_status
from canyonos.stop import run_stop
from canyonos.sync import run_sync_and_reload
from canyonos.deployment import configured_target
from canyonos.test import DEFAULT_QUERY, REQUEST_TIMEOUT, run_test
from canyonos.upgrade import notify_if_outdated, run_upgrade
from canyonos.usage.delivery import (
    DELIVERY_ARGUMENT,
    deliver_pending_events,
    start_delivery,
)
from canyonos.usage.outbox import recording_usage
from canyonos.usage.settings import settings_stamp
from canyonos.validate import run_validate
from utils.help_screen import DESCRIPTIONS, print_custom_help


def _parse_bool(value):
    if value.lower() in ("true", "1", "yes"):
        return True
    if value.lower() in ("false", "0", "no"):
        return False
    raise argparse.ArgumentTypeError(f"expected true/false, got: {value!r}")


def add_api_key_options(command):
    """Give `command` --api-key and --no-api-key, which set, replace or remove the API
    key of the workflow group it deploys."""
    options = command.add_mutually_exclusive_group()
    options.add_argument(
        "--api-key",
        metavar="KEY",
        help="Set this workflow group's API key, any string you choose, replacing the "
        "one its record keeps (~/.canyonos/workflows/<workflow group>/api_key): its "
        "endpoint and its dashboard routes then need `Authorization: Bearer <key>`. "
        "Other workflow groups keep their own keys, and later deploys of this one "
        "reuse it. Default: the recorded key, else none, and anyone who reaches them "
        "is answered",
    )
    options.add_argument(
        "--no-api-key",
        action="store_true",
        help="Remove this workflow group's API key: its endpoint checks no key",
    )
    return command


class _RootParser(argparse.ArgumentParser):
    """Routes the top-level -h/--help through the custom help screen."""

    def print_help(self, file=None):
        """Show the CanyonOS help screen in the terminal for `canyonos -h`."""
        print_custom_help()


def main():
    """Run the `canyonos` command you typed, showing the help screen if there is none
    and any error in the terminal. A reported command then starts sending waiting usage
    events in the background: the CLI restarts itself with a hidden argument to be that
    sender."""
    if sys.argv[1:] == [DELIVERY_ARGUMENT]:
        deliver_pending_events()
        return
    if sys.argv[1:2] == [FORWARD_ARGUMENT]:
        run_forward(sys.argv[2])
        return
    settings_at_start = settings_stamp()
    prepare_console()
    # A coding agent's shell stops a command with SIGTERM: take the Ctrl+C path, so cleanup runs.
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        _run_command(settings_at_start)
    except KeyboardInterrupt:
        ui.say("Cancelled.")
        sys.exit(130)


def _uses_the_selected_deployment(args):
    """True when `args` is a command that acts on one workflow group of this machine and
    names none: `stop`, `clean`, `status`, `logs`, `test`, `sync`, `curl`, `config`,
    `doctor`, `chat`, `serve` and `dashboard`, which signs in with its key."""
    if args.command in ("stop", "clean"):
        return not args.all and not args.deployments
    return args.command in (
        "status",
        "logs",
        "test",
        "sync",
        "curl",
        "config",
        "doctor",
        "chat",
        "serve",
        "dashboard",
    )


def _enter_workflow_group(args):
    """Act on the workflow group a command that names none acts on: the one the folder
    it runs from belongs to, else the one `canyonos select-context` picked. `stop` and
    `clean` name it; the others run from its record (see records.py), with the paths
    they were given made absolute first."""
    if not _uses_the_selected_deployment(args):
        return
    if getattr(args, "folders", None):
        args.folders = [os.path.abspath(folder) for folder in args.folders]
    here = records.matching_cwd()
    selected = context.selected_deployment() if len(here) != 1 else None
    if args.command in ("stop", "clean"):
        picked = records.pick(here, selected.name if selected else None)
        if picked in here:
            # From its record, so its own `target` picks this machine or the cluster.
            records.enter(picked)
            args.deployments, args.from_folder = [picked], True
        elif picked is not None:
            ui.note(f"Acting on {picked}, the selected workflow group")
            args.deployments = [picked]
        return
    entered = records.enter_for_command(selected.name if selected else None)
    if entered is not None and entered not in here:
        ui.note(f"Acting on {entered}, the selected workflow group")


def _run_command(settings_at_start):
    parser = _RootParser(prog="canyonos")
    parser.add_argument(
        "-v",
        "--version",
        action="version",
        version=f"canyonos {importlib.metadata.version('canyonos') if env.is_production else env.environment}",
    )
    # Subparsers keep the stock argparse help, so `canyonos <cmd> -h` still
    # describes that command instead of reprinting the top-level screen.
    subparsers = parser.add_subparsers(
        dest="command", parser_class=argparse.ArgumentParser
    )

    def add(name, run=None, parents=()):
        # A KeyError here means the command has no entry on the help screen.
        command = subparsers.add_parser(
            name,
            help=DESCRIPTIONS[name],
            description=DESCRIPTIONS[name],
            parents=list(parents),
        )
        command.set_defaults(func=run)
        return command

    add("quickstart", lambda args: sys.exit(0 if run_quickstart() else 1))
    add("new-app", lambda args: sys.exit(0 if run_new_app() else 1))
    provision = add("provision", lambda args: sys.exit(0 if run_provision(args) else 1))
    provision.add_argument(
        "action",
        nargs="?",
        choices=("aws", "teardown"),
        help="aws: launch an EC2 machine to deploy from; teardown: remove one "
        "(default: ask)",
    )
    for flag, help_text in (
        ("--region", "The AWS region (--yes: your AWS settings' region)"),
        ("--vpc", "The VPC's ID (--yes: the region's default VPC)"),
        (
            "--subnet",
            "The subnet's ID (--yes: the VPC's first subnet that reaches the internet)",
        ),
        (
            "--security-group",
            "A security group's ID, or `new` (--yes: new; reachable from your IP)",
        ),
        ("--machine-type", "The machine type (--yes: t3.large)"),
        ("--key-pair", "A key pair's name, or `new` (--yes: new, saved under ~/.ssh)"),
        (
            "--role",
            "An instance profile, `new` for canyonos-controller, or `none` (--yes: new)",
        ),
        ("--machine", "teardown: the machine's ID (--yes: the only one there is)"),
    ):
        provision.add_argument(flag, metavar="VALUE", help=help_text)
    provision.add_argument(
        "--remove-key-pair",
        action="store_true",
        help="teardown: also remove the key pair made for the machine, and its private "
        "key under ~/.ssh (default: keep it)",
    )
    provision.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Ask nothing: what no flag answers takes its default, and nothing is "
        "confirmed. Uses your default AWS credentials",
    )
    cluster = add(
        "cluster",
        lambda args: sys.exit(
            0
            if (
                kubernetes_local.run_cluster_up(
                    args.workers,
                    engine=kubernetes_local.K3D if args.k3d else kubernetes_local.KIND,
                )
                if args.action == "up"
                else kubernetes_local.run_cluster_down(args.all)
            )
            else 1
        ),
    )
    cluster.add_argument(
        "action",
        choices=("up", "down"),
        help="up: make the cluster (or bring it to this release); down: delete it",
    )
    cluster.add_argument(
        "--workers",
        type=int,
        help="Worker nodes of a new cluster (default 1)",
    )
    cluster.add_argument(
        "--k3d",
        action="store_true",
        help="up: make the cluster with k3d instead of kind (down deletes either)",
    )
    cluster.add_argument(
        "--all",
        action="store_true",
        help="down: also remove the local registry and the images in it",
    )

    def deploy_to_target(args):
        """Deploy to the target; with --json, add what `status --json` then prints."""
        folders = records.enter_for_deploy(
            args.folders, args.workflow_group, yes=args.yes
        )
        if folders is False:
            ui.say("Deploy cancelled.")
            return False
        if args.target:
            deployment.set_target(args.target)
        deployed = run_deploy(
            folders,
            serve=args.serve,
            verbose=args.verbose,
            yes=args.yes or args.json,
            detach=args.detach,
            api_key=args.api_key,
            no_api_key=args.no_api_key,
        )
        if deployed is not None and args.json:
            ui.json_result["status"] = _report_status()
        return deployed is not None

    deploy = add(
        "deploy",
        lambda args: sys.exit(0 if deploy_to_target(args) else 1),
    )
    deploy.add_argument(
        "--workflow-group",
        metavar="NAME",
        help="The workflow group's name: a recorded one, by name or ID, deploys its "
        "workflows, or the folders given in their place after asking; a new one is made "
        "with the folders given (default: the one that has exactly these folders, else "
        "a new one named after them)",
    )
    deploy.add_argument(
        "folders",
        nargs="*",
        metavar="folder",
        help="A workflow's folder, with its config/workflow_config.yaml; a workflow_group.yaml "
        "in the folder this runs from starts a new workflow group",
    )
    deploy.add_argument(
        "--serve",
        type=_parse_bool,
        default=True,
        metavar="true|false",
        help="Automatically launch the local dashboard (canyonos serve) once the workflow is up (default: true)",
    )
    deploy.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream the container's full build and deploy logs instead of a progress summary",
    )
    add_api_key_options(deploy)
    deploy.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Deploy the resources the config sets, without the resource picker, and "
        "replace a workflow group's workflows without asking",
    )
    deploy.add_argument(
        "--target",
        choices=("docker", "kubernetes"),
        help="Deploy to Docker on this machine, or to the Kubernetes cluster kubectl "
        "points at, and keep it as the workflow group's target (default: the one its "
        "workflow_group.yaml sets, else docker). Kubernetes without a `kubernetes:` "
        "block gets the local cluster's (canyonos cluster up)",
    )
    deploy.add_argument(
        "--detach",
        action="store_true",
        help="Return once the deploy has started, without waiting for the workflow "
        "or starting the dashboard",
    )

    def printing_json(run):
        """`run`, or with --json, `run` with its output hidden and then one JSON object:
        whether it succeeded, why not as a `code`, every error it showed and what it put
        in `ui.json_result`."""

        def run_maybe_json(args):
            if not args.json:
                return run(args)
            ui.set_quiet(True)
            code, failure = 0, None
            try:
                # Log lines a command prints go to stderr, so stdout holds only the JSON.
                with contextlib.redirect_stdout(sys.stderr):
                    run(args)
            except SystemExit as e:
                code = e.code
            except RuntimeError as e:
                ui.fail(e)
                code = getattr(e, "exit_code", 1)
                failure = getattr(e, "error_code", None)
            ok = code == 0
            print(
                json.dumps(
                    {
                        "ok": ok,
                        "code": None if ok else (failure or "failed"),
                        "errors": ui.failures,
                        **ui.json_result,
                    },
                    indent=2,
                )
            )
            sys.exit(code)

        return run_maybe_json

    def this_machine_or_cluster(local, cluster):
        """Run `local(args)`, or `cluster()` on Kubernetes: the workflow group of this
        folder only. --all and workflow group names typed mean workflow groups on this
        machine, so they always run `local`, whatever this folder's target."""

        def run(args):
            if args.all and args.deployments:
                ui.fail("Name workflow groups or pass --all, not both")
                return False
            typed = args.deployments and not getattr(args, "from_folder", False)
            if args.all or typed:
                return local(args)
            return cluster() if configured_target() == "kubernetes" else local(args)

        return lambda args: sys.exit(0 if run(args) else 1)

    clean = add(
        "clean",
        this_machine_or_cluster(
            lambda args: run_clean(
                all_deployments=args.all, yes=args.yes, refs=args.deployments
            ),
            kubernetes_target.run_kubernetes_stop,
        ),
    )
    clean.add_argument(
        "deployments",
        nargs="*",
        metavar="DEPLOYMENT",
        help="The name, folder name or ID (or its start) of a workflow group to clean. "
        "Without one, cleans the only workflow group or this folder's, or asks "
        "which",
    )
    clean.add_argument(
        "--all",
        action="store_true",
        help="Remove everything CanyonOS put on this machine before uninstalling the "
        "CLI: every workflow group, the dashboard and its data, CanyonOS's images and "
        "~/.canyonos",
    )
    clean.add_argument(
        "-y", "--yes", action="store_true", help="Don't ask before --all"
    )
    stop = add(
        "stop",
        this_machine_or_cluster(
            lambda args: run_stop(
                all_deployments=args.all,
                refs=args.deployments,
                from_folder=getattr(args, "from_folder", False),
            ),
            kubernetes_target.run_kubernetes_stop,
        ),
    )
    stop.add_argument(
        "deployments",
        nargs="*",
        metavar="DEPLOYMENT",
        help="The name, folder name or ID (or its start) of a workflow group to stop. "
        "Without one, stops the only workflow group, or asks which",
    )
    stop.add_argument(
        "--all",
        action="store_true",
        help="Stop every CanyonOS workflow group on this machine, from any folder, "
        "including workflow groups whose folder is gone",
    )
    sync = add(
        "sync", lambda args: sys.exit(0 if run_sync_and_reload(args.folders) else 1)
    )
    sync.add_argument(
        "folders",
        nargs="+",
        metavar="folder",
        help="A workflow folder of the running workflow group to copy in again",
    )

    logs = add(
        "logs",
        lambda args: sys.exit(
            0
            if run_logs(
                follow=args.follow and not args.json,
                tail=args.tail,
                agent=args.agent,
            )
            else 1
        ),
    )
    logs.add_argument(
        "agent",
        nargs="?",
        help="An agent, or one replica such as portfolio.IntentAgent-1a2b3c4d, whose logs "
        "to print instead of the Global Controller's",
    )
    logs.add_argument(
        "--no-follow",
        dest="follow",
        action="store_false",
        help="Print the logs and exit instead of streaming them until Ctrl-C",
    )
    logs.add_argument(
        "--tail",
        default="200",
        metavar="N",
        help="Show only the last N lines, or `all` (default: 200)",
    )
    add("config", lambda args: sys.exit(0 if run_config() else 1))
    contact = add("contact", lambda args: run_contact(usage=args.usage))
    contact.add_argument(
        "--usage",
        choices=("on", "off"),
        metavar="on|off",
        help="Turn usage reporting on or off without being asked (default: show and ask)",
    )
    feedback = add("feedback", lambda args: run_feedback(args.message, yes=args.yes))
    feedback.add_argument("message", help="What to tell Canyon Code, in quotes")
    feedback.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Send without asking when there is no installation id; it still sends none",
    )

    # Convert has args: --agent, --scope, -y, --install-only. With none of them it
    # is the original two-menu interactive command.
    convert = add(
        "convert",
        lambda args: sys.exit(
            0
            if run_convert(
                agent=args.agent,
                scope=args.scope,
                yes=args.yes,
                install_only=args.install_only,
            )
            else 1
        ),
    )
    convert.add_argument(
        "--agent",
        choices=sorted(CONVERT_AGENTS),
        help="Coding agent that converts the workflow, instead of asking (default: ask)",
    )
    convert.add_argument(
        "--scope",
        choices=CONVERT_SCOPES,
        help="Where to install the CanyonOS skill, instead of asking (default: ask)",
    )
    convert.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help=(
            f"Never ask: take --agent {DEFAULT_AGENT} and --scope {DEFAULT_SCOPE} "
            "for whichever of them was not given, and run the agent unattended"
        ),
    )
    convert.add_argument(
        "--install-only",
        action="store_true",
        help="Install the CanyonOS skill and exit, without launching the coding agent",
    )
    doctor = add("doctor", lambda args: sys.exit(0 if run_doctor() else 1))
    add(
        "serve",
        lambda args: sys.exit(
            kubernetes_target.run_kubernetes_serve()
            if configured_target() == "kubernetes"
            else run_serve()
        ),
    )
    status = add(
        "status",
        lambda args: sys.exit(0 if run_status(args.json) else NoDeployError.exit_code),
    )
    status.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object with each agent's replica counts and nothing else",
    )
    for command in (deploy, clean, stop, sync, logs, doctor, provision):
        command.add_argument(
            "--json",
            action="store_true",
            help="Print a single JSON object, whether it succeeded, its errors and "
            "its result, and nothing else",
        )
        command.set_defaults(func=printing_json(command.get_default("func")))
    add("upgrade", lambda args: sys.exit(run_upgrade()))
    listing = add(
        "list",
        lambda args: sys.exit(0 if run_list(args.json, not args.no_status) else 1),
    )
    listing.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object with each workflow group, whether it runs, its "
        "target and its workflows' folders, and nothing else",
    )
    listing.add_argument(
        "--no-status",
        action="store_true",
        help="Don't ask the CanyonOS API whether each deploy runs (on Kubernetes, a "
        "port-forward each): a deployed one is listed as `unchecked`",
    )
    select_context = add(
        "select-context",
        lambda args: sys.exit(
            0 if run_select_context(args.deployment, clear=args.clear) else 1
        ),
    )
    select_context.add_argument(
        "deployment",
        nargs="?",
        metavar="DEPLOYMENT",
        help="The name, folder name or ID (or its start) of the workflow group to act on "
        "from folders that are no workflow group's, as `canyonos list` shows it",
    )
    select_context.add_argument(
        "--clear",
        action="store_true",
        help="Forget the selected workflow group",
    )
    add("dashboard", lambda args: sys.exit(0 if run_open_dashboard() else 1))
    add("chat", lambda args: sys.exit(run_chat()))
    curl = add(
        "curl",
        lambda args: sys.exit(
            run_curl(args.body, route=args.route, show_command=args.print)
        ),
    )
    curl.add_argument(
        "body",
        metavar="JSON",
        help="The request body, a JSON string in single quotes, such as "
        """'{"query": "hello"}'""",
    )
    curl.add_argument(
        "--route",
        metavar="WORKFLOW/AGENT/METHOD",
        help="The route to call when the workflow group serves several: its URL, "
        "<workflow>/<agent>/<method>, <agent>/<method> or <method> (default: the only "
        "route, else picked from a menu in a terminal)",
    )
    curl.add_argument(
        "--print",
        action="store_true",
        help="Print the equivalent curl command, the API key left out, instead of "
        "sending it",
    )

    # Test has args: prompt, --json, --timeout.
    test = add(
        "test",
        lambda args: sys.exit(
            run_test(
                args.prompt,
                as_json=args.json,
                timeout=args.timeout,
            )
        ),
    )
    test.add_argument(
        "prompt",
        nargs="?",
        help="Prompt sent to every workflow (default: each workflow's "
        f"config/test_query.txt, else {DEFAULT_QUERY!r})",
    )
    test.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON result object and nothing else (for CI)",
    )
    test.add_argument(
        "--timeout",
        type=int,
        default=REQUEST_TIMEOUT,
        metavar="SECONDS",
        help=(
            "Seconds to wait for the workflow to finish; the wait restarts after each "
            f"answer (default: {REQUEST_TIMEOUT})."
        ),
    )

    validate = add(
        "validate",
        lambda args: sys.exit(run_validate(args.root, as_json=args.json)),
    )
    validate.add_argument(
        "root",
        nargs="?",
        help="The folder to check (default: the workflow root)",
    )
    validate.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON result object and nothing else (for CI)",
    )

    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        return

    # `upgrade` is the notice's own advice, so repeating it there says nothing.
    if args.command != "upgrade":
        notify_if_outdated()

    try:
        _enter_workflow_group(args)
        with recording_usage(args.command):
            args.func(args)
    except RuntimeError as e:
        ui.fail(e)
        sys.exit(getattr(e, "exit_code", 1))
    finally:
        start_delivery(args.command, settings_at_start)


if __name__ == "__main__":
    main()
