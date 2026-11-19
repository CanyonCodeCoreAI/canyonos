// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as docker from '@core/docker';
import { config } from '@core/env';
import { AppError } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import type { Container } from '@core/docker';

// On Docker the API reaches a workflow group's Redis by its container name, which resolves only
// on the group's network: the network of the group's Global Controller container, which the CLI
// creates and labels. So before it reads that Redis, the API's own container
// (CANYONOS_API_CONTAINER) joins the networks of that container it is not on yet.

const network_logger = logger.child({ domain: LOG_DOMAINS.DOCKER });

export const ROLE_LABEL = 'canyonos.role';
export const WORKFLOW_GROUP_LABEL = 'canyonos.workflow_group_id';
export const CONTROLLER_ROLE = 'global-controller';

// A status poll reads the group's Redis every few seconds; a join this recent is not checked
// again, unless a read since could not reach the Redis.
const JOINED_FOR_MS = 30_000;
// Docker's own networks: no container joins host or none, and the default bridge resolves no
// container names.
const DOCKER_NETWORKS: ReadonlySet<string> = new Set(['bridge', 'host', 'none']);

/** The workflow group's Global Controller container, the newest when there are several. */
export async function find_controller(workflow_group_id: string): Promise<Container | null> {
  const [found] = await docker.list_containers([
    `${ROLE_LABEL}=${CONTROLLER_ROLE}`,
    `${WORKFLOW_GROUP_LABEL}=${workflow_group_id}`,
  ]);
  if (!found) return null;
  try {
    return await docker.inspect(found.id);
  } catch (error) {
    // Removed between the listing and the inspect.
    if (error instanceof AppError && error.code === 'docker.not_found') return null;
    throw error;
  }
}

/** Connects `container` to each network of the workflow group's Global Controller container it
 * is not on, but Docker's own; returns the networks it joined, or null when the group has no
 * such container. */
export async function join_controller_networks(
  container: string,
  workflow_group_id: string
): Promise<string[] | null> {
  const controller = await find_controller(workflow_group_id);
  if (!controller) return null;
  return docker.join_networks(
    container,
    controller.networks.filter((network) => !DOCKER_NETWORKS.has(network))
  );
}

// When this API's container last joined each workflow group's networks, by workflow group id.
const joined = new Map<string, { at: number; done: Promise<void> }>();

const joins_networks = (): string | null =>
  config.workflowGroups.target === 'docker' && config.docker.socket !== null
    ? config.docker.apiContainer
    : null;

/** Joins the networks; whether that is worth remembering: not when it failed, nor while the
 * group has no Global Controller container, which the next read looks for again. */
async function join(container: string, workflow_group_id: string): Promise<boolean> {
  try {
    const networks = await join_controller_networks(container, workflow_group_id);
    if (networks?.length) {
      network_logger.info('Joined the networks of a workflow group', {
        container,
        workflow_group_id,
        networks,
      });
    }
    return networks !== null;
  } catch (error) {
    network_logger.warn("Could not join a workflow group's networks", {
      container,
      workflow_group_id,
      error,
    });
    return false;
  }
}

/** Puts this API's container on the networks of the workflow group's Global Controller
 * container, so its Redis resolves by name; a join in the last 30 seconds counts, unless
 * `fresh`. Nothing to do on the host or on Kubernetes. A failed join is logged, and the read
 * that follows reports why it could not reach the Redis. */
export function join_group_networks(
  workflow_group_id: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<void> {
  const container = joins_networks();
  if (container === null) return Promise.resolve();
  const last = joined.get(workflow_group_id);
  if (!fresh && last && Date.now() - last.at < JOINED_FOR_MS) return last.done;
  const done: Promise<void> = join(container, workflow_group_id).then((remember) => {
    if (!remember && joined.get(workflow_group_id)?.done === done) {
      joined.delete(workflow_group_id);
    }
  });
  joined.set(workflow_group_id, { at: Date.now(), done });
  return done;
}

/** Forgets the last join, so the next read joins again: a read that could not reach the Redis
 * may have found the container off a network it had joined, such as one recreated since. */
export function forget_group_networks(workflow_group_id: string): void {
  joined.delete(workflow_group_id);
}
