# CanyonOS Testing & Load Analysis Tools

This directory contains an automated end-to-end testing suite for CanyonOS. It is designed to verify both functional correctness and concurrent performance of the distributed agent architecture.

## 1. Automated Test Runner (`run_tests.sh`)
This script automates the entire testing lifecycle by interacting with the `canyonos` CLI:
0. Runs the package test suites and the tests in this `tests/` directory.
1. Copies the `examples/helloworld` project into a temporary directory.
2. Builds and launches it using `canyonos deploy` in the background.
3. Waits for the deployed workflow endpoint to become reachable, then gives the agents a few extra seconds to register.
4. Runs the Python integration and performance scripts.
5. Redeploys helloworld with `context_propagation_workflow.py` as its workflow and runs the context propagation script.
6. **Cleanup:** Automatically terminates the deployment and cleans up the temporary directory upon success or failure.

To run the complete suite:
```bash
./run_tests.sh
```

## 2. Functional Integration Validation (`test_integration.py`)
Verifies that a query sent to the deployed helloworld workflow reaches its agent and comes back.
- Dispatches a single query to the deployed `/main` endpoint.
- Polls the `/status/<request_id>` endpoint until completion.
- Checks that the result holds the greeting from `HelloAgent`.

To run manually against an already-deployed CanyonOS instance:
```bash
python test_integration.py
```

## 3. High-Concurrency Stress Test (`test_performance.py`)
Evaluates the robustness and scalability of the CanyonOS Redis routing and Docker architecture under load. Using `concurrent.futures`, this script models N concurrent users actively polling CanyonOS simultaneously.

It produces an analytical report summarizing throughput, dropped requests, and latency percentiles.

To run manually against an already-deployed CanyonOS instance (e.g. 50 requests across 10 concurrent virtual users):
```bash
python test_performance.py --concurrent 10 --total 50
```

## 4. Context Propagation (`test_context_propagation.py`)
Checks that agent calls made from a thread, a raw `_thread.start_new_thread` thread, an asyncio task, asyncio's default executor, a `multiprocessing.Process`, and a reused thread pool, process pool and `multiprocessing.Pool` keep the request they belong to.
- `run_tests.sh` redeploys helloworld with `context_propagation_workflow.py` as its workflow.
- Sends two rounds of three concurrent requests and checks each caller saw the request's ID and the workflow's future ID, and that Redis recorded its agent call under that request and parent.
