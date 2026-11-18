# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Example Workflow
# An agent that calls HelloAgent; the endpoint serves its `main` method.
#
# After `canyonos deploy helloworld --api-key <your api key>` in examples/helloworld:
#   curl -X POST http://localhost:8080/helloworld/Workflow/main \
#        -H "Authorization: Bearer <your api key>" \
#        -H 'Content-Type: application/json' -d '{"query": "World"}'
#   curl -H "Authorization: Bearer <your api key>" http://localhost:8080/status/<request_id>

from agents.hello_agent import HelloAgent


class Workflow(object):
    def main(self, query: str = "World"):
        agent = HelloAgent()
        greeting = agent.hello(name=query)
        return {"greeting": greeting}
