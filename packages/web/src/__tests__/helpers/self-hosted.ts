// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// The workflow group of a self-hosted dashboard: the one whose Global Controller runs beside the
// first API, which finds it in that controller's Redis as it starts (`scripts/self-hosted-controller.ts`),
// with the key it was deployed with. It is keyed with another key than the seeded workflow groups.

export const SELF_HOSTED_WORKFLOW_GROUP_ID = '77777777-7777-4777-8777-777777777701';
export const SELF_HOSTED_WORKFLOW = '77777777-7777-4777-8777-777777777702';
export const SELF_HOSTED_WORKFLOW_NAME = 'Self-Hosted Flow';
export const SELF_HOSTED_API_KEY = 'the self-hosted controllers key';
