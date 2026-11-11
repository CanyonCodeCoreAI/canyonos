# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Uses agent call results without `.value()` where the rewrite has more to do than
# wrap a use: unpacking, `await`, a Future on a project object that a library
# reads, the Future's own `.id`, and results handed to a project module that calls
# no agent and so is not rewritten. tests/e2e/projects/lazy-values lays it over
# helloworld; check.py says what each entry must be.

import asyncio
import dataclasses

from agents.hello_agent import HelloAgent
from agents.helpers import Box, shout
from agents.pair_agent import PairAgent


@dataclasses.dataclass
class Holder:
    greeting: object = None


async def _awaited(query):
    one = await HelloAgent().hello(name=query)
    both = await asyncio.gather(
        HelloAgent().hello(name=query), PairAgent().split(name=query)
    )
    return [one, *both]


class Workflow(object):
    def main(self, query: str = "World"):
        name, size = PairAgent().split(name=query)
        first, *rest = PairAgent().split(name=query)
        index, (nested_name, nested_size) = 0, PairAgent().split(name=query)
        looped = [f"{n}:{s}" for n, s in [PairAgent().split(name=query)]]

        holder = Holder()
        holder.greeting = HelloAgent().hello(name=query)

        box = Box()
        box.greeting = HelloAgent().hello(name=query)

        call = HelloAgent().hello(name=query)
        return {
            "helper": shout(HelloAgent().hello(name=query)),
            "helper_object": dataclasses.asdict(box),
            "unpacked": [name, size],
            "starred": [first, rest],
            "nested": [index, nested_name, nested_size],
            "looped": looped,
            "awaited": asyncio.run(_awaited(query)),
            "holder": dataclasses.asdict(holder),
            "future_id": isinstance(call.id, str) and len(call.id) == 16,
        }
