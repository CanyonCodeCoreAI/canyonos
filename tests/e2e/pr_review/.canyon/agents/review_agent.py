# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Review Agent
#
# Reviews the pull request with one call to a model on AWS Bedrock (Converse
# API), made directly with boto3. The CanyonOS LLM gateway records the call's
# tokens and cost on this execution's future and applies governance.yaml's
# model switch. Configure with env vars:
#   BEDROCK_MODEL_ID  (default: meta.llama3-70b-instruct-v1:0)
#   AWS_REGION        (default: us-east-1)
#
# A failed call fails the review: there is no fallback text.

import os

import boto3


class ReviewAgent(object):
    def __init__(self):
        self.tools = [self.review]
        self.model_id = os.environ.get(
            "BEDROCK_MODEL_ID", "meta.llama3-70b-instruct-v1:0"
        )
        self.region = os.environ.get("AWS_REGION", "us-east-1")
        self._client = boto3.client("bedrock-runtime", region_name=self.region)

    def review(self, pr: dict, tests: str) -> str:
        """Review the pull request; `tests` is TestRunnerAgent.run's result as JSON."""
        prompt = (
            "You are a code reviewer. Review the pull request below in 2-3 sentences, "
            "then end with APPROVE or REQUEST CHANGES on its own line. Request "
            "changes when any test failed.\n\n"
            f"Title: {pr.get('title', '')}\n"
            f"Test results: {tests}\n"
            f"Diff:\n{pr.get('diff', '')}"
        )
        response = self._client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 400, "temperature": 0.2},
        )
        return response["output"]["message"]["content"][0]["text"]


if __name__ == "__main__":
    print(
        ReviewAgent().review(
            {"title": "Add retry", "diff": "+def retry(): ..."}, '{"passed": true}'
        )
    )
