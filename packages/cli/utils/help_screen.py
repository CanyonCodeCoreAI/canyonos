# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Custom help screen for the canyonos CLI.

To run type: canyonos -h
"""

from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from canyonos import ui
from canyonos.theme import GREEN, WHITE

# The single source of truth for command descriptions: cli.py registers every
# subparser through this table, so a command can't be added to one and missed
# in the other.
CORE_COMMANDS = (
    ("deploy", "Build and launch the workflow, then open the dashboard"),
    ("config", "Configure project settings"),
)

UTIL_COMMANDS = (
    ("clean", "Stop the deploy, then delete .canyon, the skill and the agents' images"),
    ("convert", "Optional: convert an existing workflow with a coding agent"),
    ("doctor", "Check Docker and Compose are available"),
    ("logs", "Follow the running deploy's logs"),
    ("new-app", "Create a starter CanyonOS project with one agent"),
    ("serve", "Start local CanyonOS dashboard"),
    ("status", "Check whether a deploy is running and where it answers"),
    ("stop", "Stop the deploy and remove its containers, keeping its images"),
    (
        "sync",
        "Apply config changes to the running deploy; code changes need a redeploy",
    ),
    ("test", "Deploy locally and run one prompt end to end"),
    ("upgrade", "Upgrade the canyonos CLI to the latest release"),
    ("validate", "Check the project against the CanyonOS contract"),
)

CONTACT_COMMANDS = (
    ("contact", "See or change whether the CLI shares usage with Canyon Code"),
    ("feedback", "Send a message to Canyon Code"),
)

_ALL_COMMANDS = CORE_COMMANDS + UTIL_COMMANDS + CONTACT_COMMANDS
DESCRIPTIONS = dict(_ALL_COMMANDS)


# Both columns are sized from the widest entry across all tables, so the sections
# line up with each other instead of each shrinking to fit its own rows.
_NAME_WIDTH = max(len(name) for name, _ in _ALL_COMMANDS)
_DESCRIPTION_WIDTH = max(len(description) for _, description in _ALL_COMMANDS)


def _command_table(commands):
    table = Table(show_header=False, border_style="dim", padding=(0, 2))
    table.add_column(style=f"bold {GREEN}", width=_NAME_WIDTH)
    table.add_column(style=WHITE, width=_DESCRIPTION_WIDTH)
    for name, description in commands:
        table.add_row(name, description)
    return table


def print_custom_help():
    """Print a custom, visually appealing help screen."""
    title = Text("CanyonOS CLI", style=f"bold {GREEN}")
    subtitle = Text(
        "\nBuild, deploy, and manage agentic workflows with ease", style="dim"
    )
    ui.panel(Panel(title + subtitle, border_style=GREEN, padding=(1, 2)))

    ui.console.print(f"\n[bold {GREEN}]Core Commands[/]")
    ui.console.print(_command_table(CORE_COMMANDS))

    ui.console.print(f"\n[bold {GREEN}]Utils[/]")
    ui.console.print(_command_table(UTIL_COMMANDS))

    ui.console.print(f"\n[bold {GREEN}]Contact[/]")
    ui.console.print(_command_table(CONTACT_COMMANDS))

    ui.console.print(f"\n[bold {GREEN}]Quick Start:[/]")
    ui.console.print(
        "  [dim]Converting an existing workflow? Run canyonos convert in its folder "
        "first (opens coding agent).[/dim]"
    )
    ui.console.print(f"  [dim]1.[/dim] cd [{GREEN}]into-your-workflow-root-dir[/]")
    ui.console.print("  [dim]2.[/dim] canyonos deploy (UI automatically starts)")

    ui.console.print(
        f"[dim]For command-specific help: [{GREEN}]canyonos <command> --help[/][/dim]\n"
    )
