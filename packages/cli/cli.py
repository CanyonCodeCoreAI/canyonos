# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Almost all commands will be executing on the canyonos container spawned by deploy
Commands like doctor and new_app will not though
"""

import argparse
import importlib.metadata
import signal
import sys

from canyonos import env, ui
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
from canyonos import kubernetes_target
from canyonos.feedback import run_feedback
from canyonos.logs import run_logs
from canyonos.new_app import run_new_app
from canyonos.os_support import prepare_console
from canyonos.quickstart import run_quickstart
from canyonos.serve import run_serve
from canyonos.status import run_status
from canyonos.stop import run_stop
from canyonos.sync import run_sync_and_reload
from canyonos.test import DEFAULT_QUERY, REQUEST_TIMEOUT, run_test
from canyonos.upgrade import notify_if_outdated, run_upgrade
from canyonos.usage.delivery import (
    DELIVERY_ARGUMENT,
    deliver_pending_events,
    start_delivery,
)
from canyonos.usage.outbox import recording_usage
from canyonos.validate import run_validate
from utils.help_screen import DESCRIPTIONS, print_custom_help


def _parse_bool(value):
    if value.lower() in ("true", "1", "yes"):
        return True
    if value.lower() in ("false", "0", "no"):
        return False
    raise argparse.ArgumentTypeError(f"expected true/false, got: {value!r}")


class _RootParser(argparse.ArgumentParser):
    """Routes the top-level -h/--help through the custom help screen."""

    def print_help(self, file=None):
        """Show the CanyonOS help screen in the terminal for `canyonos -h`."""
        print_custom_help()


def main():
    """Run the `canyonos` command you typed, showing the help screen if there is none
    and any error in the terminal, then start sending waiting usage events in the
    background. The CLI restarts itself with a hidden argument to be that sender."""
    if sys.argv[1:] == [DELIVERY_ARGUMENT]:
        deliver_pending_events()
        return
    prepare_console()
    # A coding agent's shell stops a command with SIGTERM: take the Ctrl+C path, so cleanup runs.
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        _run_command()
    except KeyboardInterrupt:
        ui.say("Cancelled.")
        sys.exit(130)
    finally:
        start_delivery()


def _run_command():
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

    def add(name, run):
        # A KeyError here means the command has no entry on the help screen.
        command = subparsers.add_parser(
            name, help=DESCRIPTIONS[name], description=DESCRIPTIONS[name]
        )
        command.set_defaults(func=run)
        return command

    add("quickstart", lambda args: sys.exit(0 if run_quickstart() else 1))
    add("new-app", lambda args: sys.exit(0 if run_new_app() else 1))

    def add_target(command):
        command.add_argument(
            "--target",
            choices=("docker", "kubernetes"),
            default="docker",
            help="Where the project runs: Docker on this machine (default) or the "
            "Kubernetes cluster kubectl points at",
        )
        return command

    def on_kubernetes(args):
        return args.target == "kubernetes"

    deploy = add_target(
        add(
            "deploy",
            lambda args: sys.exit(
                0
                if (
                    kubernetes_target.run_kubernetes_deploy()
                    if on_kubernetes(args)
                    else run_deploy(serve=args.serve, verbose=args.verbose)
                )
                is not None
                else 1
            ),
        )
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
        """Run `local(args)`, or `cluster()` with --target kubernetes: the project in this
        folder only, since --all means every project on this machine."""

        def run(args):
            if not on_kubernetes(args):
                return local(args)
            if args.all:
                ui.fail(
                    "--all covers the projects on this machine, not a cluster's; run "
                    "the command with --target kubernetes from each project's folder"
                )
                return False
            return cluster()

        return lambda args: sys.exit(0 if run(args) else 1)

    clean = add_target(
        add(
            "clean",
            this_machine_or_cluster(
                lambda args: run_clean(all_projects=args.all, yes=args.yes),
                kubernetes_target.run_kubernetes_clean,
            ),
        )
    )
    clean.add_argument(
        "--all",
        action="store_true",
        help="Remove everything CanyonOS put on this machine before uninstalling the "
        "CLI: every project, the dashboard and its data, CanyonOS's images and "
        "~/.canyonos",
    )
    clean.add_argument(
        "-y", "--yes", action="store_true", help="Don't ask before --all"
    )
    stop = add_target(
        add(
            "stop",
            this_machine_or_cluster(
                lambda args: run_stop(all_projects=args.all),
                kubernetes_target.run_kubernetes_stop,
            ),
        )
    )
    stop.add_argument(
        "--all",
        action="store_true",
        help="Stop every CanyonOS project on this machine, from any folder, "
        "including projects whose folder is gone",
    )
    add("sync", lambda args: sys.exit(0 if run_sync_and_reload() else 1))

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
        help="An agent, or one replica such as IntentAgent-1, whose logs to print "
        "instead of the Global Controller's",
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
        help="Send without asking while usage reporting is off; it still sends no installation id",
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
    add("doctor", lambda args: sys.exit(0 if run_doctor() else 1))
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
    add("upgrade", lambda args: sys.exit(run_upgrade()))

    # Test has args: prompt, --json, --timeout.
    test = add(
        "test",
        lambda args: sys.exit(
            run_test(args.prompt, as_json=args.json, timeout=args.timeout)
        ),
    )
    test.add_argument(
        "prompt",
        nargs="?",
        default=DEFAULT_QUERY,
        help=f"Prompt sent to the workflow (default: {DEFAULT_QUERY!r})",
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
        with recording_usage(args.command):
            args.func(args)
    except RuntimeError as e:
        ui.fail(e)
        sys.exit(1)


if __name__ == "__main__":
    main()
