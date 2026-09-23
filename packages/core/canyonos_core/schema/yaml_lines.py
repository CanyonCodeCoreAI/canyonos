"""YAML loading that remembers which line every mapping key was written on.

A violation that cannot point at a line is much harder to act on than one that
can, and PyYAML drops the marks as soon as it builds the plain dict -- so the
mapping constructor is replaced with one that keeps them.
"""

import yaml
import yaml.constructor
import yaml.resolver


class LineDict(dict):
    """A mapping that remembers where it and each of its keys were written."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.line = 0
        self.key_lines = {}


class LineList(list):
    """A sequence that remembers where it and each of its items were written."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.line = 0
        self.item_lines = []


class LineLoader(yaml.SafeLoader):
    pass


def _reject_duplicate_keys(node):
    """Refuse a mapping that sets the same key twice.

    PyYAML keeps the last value without a word, so `replicas:` written twice
    in one service deploys whichever came second. Only scalar keys are
    compared, by tag and text, so `1` and `"1"` stay distinct.
    """
    seen = {}
    for key, _ in node.value:
        if not isinstance(key, yaml.ScalarNode):
            continue
        identity = (key.tag, key.value)
        if identity in seen:
            raise yaml.constructor.ConstructorError(
                None,
                None,
                f"found duplicate key {key.value!r} (first set on line {seen[identity]})",
                key.start_mark,
            )
        seen[identity] = key.start_mark.line + 1


def _construct_mapping(loader, node):
    _reject_duplicate_keys(node)
    data = LineDict()
    yield data
    data.update(loader.construct_mapping(node, deep=False))
    data.line = node.start_mark.line + 1
    data.key_lines = {
        key.value: key.start_mark.line + 1
        for key, _ in node.value
        if isinstance(key, yaml.ScalarNode)
    }


def _construct_sequence(loader, node):
    data = LineList()
    yield data
    data.extend(loader.construct_sequence(node, deep=False))
    data.line = node.start_mark.line + 1
    data.item_lines = [item.start_mark.line + 1 for item in node.value]


LineLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)
LineLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_SEQUENCE_TAG, _construct_sequence
)


def line_of(node, key=None):
    """The 1-based line of `key` inside `node`, or of `node` itself.

    `key` is a mapping key, or an index into a sequence.
    """
    if isinstance(node, LineList):
        if isinstance(key, int) and 0 <= key < len(node.item_lines):
            return node.item_lines[key]
        return node.line
    if not isinstance(node, LineDict):
        return 0
    if key is not None:
        return node.key_lines.get(key, node.line)
    return node.line


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
