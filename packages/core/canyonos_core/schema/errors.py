"""Violations the schema reports, and the one-line form the deploy log prints.

The host CLI scrapes the in-container deploy's output and treats the *first*
line of a fatal message as the root cause, so every violation has to render as
a single self-contained line.
"""

from typing import NamedTuple


class SchemaViolation(NamedTuple):
    """One rejected field: where it is written and what is wrong with it."""

    path: str
    line: int
    field: str
    message: str


def render_violation(violation):
    """Render a violation as `path:line: field: message`, on one line."""
    location = violation.path
    if violation.line:
        location = f"{location}:{violation.line}"
    if not location:
        return f"{violation.field}: {violation.message}"
    return f"{location}: {violation.field}: {violation.message}"


class SchemaError(Exception):
    """Every violation found in one file, raised once instead of one at a time."""

    def __init__(self, violations):
        self.violations = tuple(violations)
        super().__init__("; ".join(render_violation(v) for v in self.violations))


class DependencyPinConflict(SchemaError):
    """An app pinned a package below the version the platform image is built on."""
