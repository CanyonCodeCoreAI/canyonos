"""YAML loading that remembers which line every mapping key was written on.

A violation that cannot point at a line is much harder to act on than one that
can, and PyYAML drops the marks as soon as it builds the plain dict -- so the
mapping constructor is replaced with one that keeps them.
"""

import yaml
import yaml.resolver


class LineDict(dict):
    """A mapping that remembers where it and each of its keys were written."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.line = 0
        self.key_lines = {}


class LineLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader, node):
    data = LineDict()
    yield data
    data.update(loader.construct_mapping(node, deep=False))
    data.line = node.start_mark.line + 1
    data.key_lines = {
        key.value: key.start_mark.line + 1
        for key, _ in node.value
        if isinstance(key, yaml.ScalarNode)
    }


LineLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


def line_of(mapping, key=None):
    """The 1-based line of `key` inside `mapping`, or of the mapping itself."""
    if not isinstance(mapping, LineDict):
        return 0
    if key is not None:
        return mapping.key_lines.get(key, mapping.line)
    return mapping.line


def load_yaml_lines(path):
    """Parse `path` into line-aware mappings."""
    with open(path, "r", encoding="utf-8") as f:
        return yaml.load(f, Loader=LineLoader)


def parse_failure(exc):
    """A YAMLError as `(line, message)`, collapsed onto one line.

    PyYAML writes its errors over four lines; a violation has to stay on one
    for the host CLI to report it whole.
    """
    mark = getattr(exc, "problem_mark", None)
    return (mark.line + 1 if mark else 0), " ".join(str(exc).split())
