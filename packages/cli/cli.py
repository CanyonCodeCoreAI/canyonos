# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Almost all commands will be executing on the canyonos container spawned by deploy
Commands like doctor and new_app will not though
"""

import argparse
import importlib.metadata
import os
import signal
import sys
from pathlib import Path

from canyonos import env, ui
from canyonos.auth import (
    DEFAULT_KEY_NAME,
    SCOPES as TOKEN_SCOPES,
    run_keys_create,
    run_keys_list,
    run_keys_trust,
    run_token_create,
)
from canyonos.clean import run_clean
from canyonos.config import run_config
from canyonos.contact import run_contact
from canyonos.convert import (
    AGENTS as CONVERT_AGENTS,
    DEFAULT_AGENT,
    DEFAULT_SCOPE,
    SCOPES as CONVERT_SCOPES,
    run_convert,
)
from canyonos.deploy import run_deploy
from canyonos.doctor import run_doctor
from canyonos import kubernetes_local, kubernetes_target
from canyonos.feedback import run_feedback
from canyonos.forwards import FORWARD_ARGUMENT, run_forward
from canyonos.logs import run_logs
from canyonos.new_app import run_new_app
from canyonos.os_support import prepare_console
from canyonos.quickstart import run_quickstart
from canyonos.serve import run_serve
from canyonos.provision import run_provision
from canyonos.status import run_status
from canyonos.stop import run_stop
from canyonos.sync import run_sync_and_reload
from canyonos.deployment import TARGETS, resolve_target
from canyonos.target import run_target
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


def _auth_dir_option():
    """A parent parser with --auth-dir, for every command that reads or writes keys.
    Attached to each action, so the option also works after it."""
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument(
        "--auth-dir",
        type=Path,
        metavar="PATH",
        help="The folder of keys to use instead of ~/.canyonos/auth",
    )
    return parent


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


def _enter_deployment_folder(args):
    """Deploy from the deployment's folder `args.folder`, made when it is missing, as
    if the command were typed there; the project folders it names stay relative to
    where it was typed."""
    args.folders = [os.path.abspath(folder) for folder in args.folders]
    os.makedirs(args.folder, exist_ok=True)
    os.chdir(args.folder)


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

    def add(name, run=None):
        # A KeyError here means the command has no entry on the help screen.
        command = subparsers.add_parser(
            name, help=DESCRIPTIONS[name], description=DESCRIPTIONS[name]
        )
        command.set_defaults(func=run)
        return command

    auth_dir = _auth_dir_option()

    def add_actions(command):
        """Give `command` required actions, each run on its own, such as
        `canyonos keys create`; returns the function that adds one."""
        actions = command.add_subparsers(dest="action", required=True)

        def add_action(name, description, run):
            action = actions.add_parser(
                name, help=description, description=description, parents=[auth_dir]
            )
            action.set_defaults(func=lambda args: sys.exit(0 if run(args) else 1))
            return action

        return add_action

    add("quickstart", lambda args: sys.exit(0 if run_quickstart() else 1))
    add("new-app", lambda args: sys.exit(0 if run_new_app() else 1))
    add("provision", lambda args: sys.exit(0 if run_provision() else 1))
    cluster = add(
        "cluster",
        lambda args: sys.exit(
            0
            if (
                kubernetes_local.run_cluster_up(args.workers)
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
        "--all",
        action="store_true",
        help="down: also remove the local registry and the images in it",
    )

    def add_target(command):
        command.add_argument(
            "--target",
            choices=TARGETS,
            help="Where the deployment runs: Docker on this machine or the Kubernetes "
            "cluster kubectl points at (default: deployment.yaml's `target`, else docker)",
        )
        return command

    def on_kubernetes(args):
        return resolve_target(args.target) == "kubernetes"

    deploy = add_target(
        add(
            "deploy",
            lambda args: sys.exit(
                0
                if (
                    kubernetes_target.run_kubernetes_deploy(serve=args.serve)
                    if on_kubernetes(args)
                    else run_deploy(
                        args.folders, serve=args.serve, verbose=args.verbose
                    )
                )
                is not None
                else 1
            ),
        )
    )
    deploy.add_argument(
        "--folder",
        metavar="PATH",
        help="The deployment's folder, which holds its deployment.yaml, made when "
        "missing (default: the current folder)",
    )
    deploy.add_argument(
        "folders",
        nargs="+",
        metavar="folder",
        help="A project folder to deploy, with its config/workflow_config.yaml; the deployment "
        "is named after its own folder (--folder) and set by its deployment.yaml",
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

    def this_machine_or_cluster(local, cluster):
        """Run `local(args)`, or `cluster()` on Kubernetes: the deployment of this
        folder only. --all and deployment names mean deployments on this machine, so
        they always run `local`, whatever this folder's target, and are refused with
        --target kubernetes."""

        def run(args):
            if args.all and args.deployments:
                ui.fail("Name deployments or pass --all, not both")
                return False
            if args.all or args.deployments:
                if args.target == "kubernetes":
                    ui.fail(
                        "--all and deployment names cover the deployments on this "
                        "machine, not a cluster's; run the command from each deployment's "
                        "folder"
                    )
                    return False
                return local(args)
            return cluster() if on_kubernetes(args) else local(args)

        return lambda args: sys.exit(0 if run(args) else 1)

    clean = add_target(
        add(
            "clean",
            this_machine_or_cluster(
                lambda args: run_clean(
                    all_deployments=args.all, yes=args.yes, refs=args.deployments
                ),
                kubernetes_target.run_kubernetes_clean,
            ),
        )
    )
    clean.add_argument(
        "deployments",
        nargs="*",
        metavar="DEPLOYMENT",
        help="The name, folder name or ID (or its start) of a deployment to clean. "
        "Without one, cleans the only deployment or this folder's, or asks "
        "which",
    )
    clean.add_argument(
        "--all",
        action="store_true",
        help="Remove everything CanyonOS put on this machine before uninstalling the "
        "CLI: every deployment, the dashboard and its data, CanyonOS's images and "
        "~/.canyonos",
    )
    clean.add_argument(
        "-y", "--yes", action="store_true", help="Don't ask before --all"
    )
    stop = add_target(
        add(
            "stop",
            this_machine_or_cluster(
                lambda args: run_stop(all_deployments=args.all, refs=args.deployments),
                kubernetes_target.run_kubernetes_stop,
            ),
        )
    )
    stop.add_argument(
        "deployments",
        nargs="*",
        metavar="DEPLOYMENT",
        help="The name, folder name or ID (or its start) of a deployment to stop. "
        "Without one, stops the only deployment, or asks which",
    )
    stop.add_argument(
        "--all",
        action="store_true",
        help="Stop every CanyonOS deployment on this machine, from any folder, "
        "including deployments whose folder is gone",
    )
    sync = add(
        "sync", lambda args: sys.exit(0 if run_sync_and_reload(args.folders) else 1)
    )
    sync.add_argument(
        "folders",
        nargs="+",
        metavar="folder",
        help="A project folder of the running deployment to copy in again",
    )

    add_key_action = add_actions(add("keys"))
    add_key_action(
        "create",
        "Make a key pair: a private key that signs tokens on this machine, and its "
        "public half, which deploys and the dashboard trust",
        lambda args: run_keys_create(args.name, args.auth_dir),
    ).add_argument(
        "--name",
        default=DEFAULT_KEY_NAME,
        help=f"The key's name, from the characters [A-Za-z0-9._-] (default: "
        f"{DEFAULT_KEY_NAME})",
    )
    add_key_action(
        "list",
        "Show the public keys deploys and the dashboard trust",
        lambda args: run_keys_list(args.auth_dir),
    )
    add_key_action(
        "trust",
        "Trust a public key made elsewhere, such as a teammate's, so the tokens it "
        "signs are accepted",
        lambda args: run_keys_trust(args.file, args.auth_dir),
    ).add_argument("file", help="The Ed25519 public key, in PEM, to trust")

    token_create = add_actions(add("token"))(
        "create",
        "Sign a token and show it once, with what it grants and how to send it",
        lambda args: run_token_create(
            args.scope,
            args.projects,
            args.all_projects,
            args.ttl,
            args.key,
            args.auth_dir,
        ),
    )
    token_create.add_argument(
        "--scope",
        required=True,
        choices=TOKEN_SCOPES,
        help="query: a workflow's endpoint; read or write: the dashboard API",
    )
    token_create.add_argument(
        "--project",
        dest="projects",
        action="append",
        default=[],
        metavar="ID",
        help="query: the ID of a project the token may query; repeat it for more",
    )
    token_create.add_argument(
        "--all-projects",
        action="store_true",
        help="query: let the token query every project",
    )
    token_create.add_argument(
        "--ttl",
        type=int,
        metavar="SECONDS",
        help="Seconds until the token expires (default: no expiry)",
    )
    token_create.add_argument(
        "--key",
        metavar="NAME",
        help="The private key to sign with; needed only when there is more than one",
    )

    logs = add_target(
        add(
            "logs",
            lambda args: sys.exit(
                0
                if (
                    kubernetes_target.run_kubernetes_logs
                    if on_kubernetes(args)
                    else run_logs
                )(follow=args.follow, tail=args.tail, agent=args.agent)
                else 1
            ),
        )
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
        help="Coding agent that converts the project, instead of asking (default: ask)",
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
    add_target(
        add(
            "doctor",
            lambda args: sys.exit(
                0 if run_doctor(kubernetes=on_kubernetes(args)) else 1
            ),
        )
    )
    add_target(
        add(
            "serve",
            lambda args: sys.exit(
                kubernetes_target.run_kubernetes_serve()
                if on_kubernetes(args)
                else run_serve()
            ),
        )
    )
    status = add_target(
        add(
            "status",
            lambda args: sys.exit(
                0
                if (
                    kubernetes_target.run_kubernetes_status
                    if on_kubernetes(args)
                    else run_status
                )(args.json)
                else 1
            ),
        )
    )
    status.add_argument(
        "--json",
        action="store_true",
        help="Print a single JSON object with each agent's replica counts and nothing else",
    )
    target = add(
        "target",
        lambda args: sys.exit(
            0
            if run_target(args.target, namespace=args.namespace, registry=args.registry)
            else 1
        ),
    )
    target.add_argument(
        "target",
        nargs="?",
        choices=TARGETS,
        help="Where this project deploys from now on (default: show where it does)",
    )
    target.add_argument(
        "--namespace",
        help="kubernetes: the project's namespace (default: the folder's name)",
    )
    target.add_argument(
        "--registry",
        help="kubernetes: where images are pushed and nodes pull from (default: the "
        "local registry the cluster advertises, else asked)",
    )
    add("upgrade", lambda args: sys.exit(run_upgrade()))

    # Test has args: prompt, --json, --timeout, --target.
    test = add_target(
        add(
            "test",
            lambda args: sys.exit(
                run_test(
                    args.prompt,
                    as_json=args.json,
                    timeout=args.timeout,
                    kubernetes=on_kubernetes(args),
                )
            ),
        )
    )
    test.add_argument(
        "prompt",
        nargs="?",
        help="Prompt sent to every workflow (default: each project's "
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
        help="The folder to check (default: the project root)",
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
        if getattr(args, "folder", None):
            _enter_deployment_folder(args)
        with recording_usage(args.command):
            args.func(args)
    except RuntimeError as e:
        ui.fail(e)
        sys.exit(1)
    finally:
        start_delivery(args.command, settings_at_start)


if __name__ == "__main__":
    main()
