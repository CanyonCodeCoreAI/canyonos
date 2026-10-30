/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package redisstate

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Agent is one agent's entry in the routing table.
type Agent struct {
	Name     string // as in the config (HelloAgent)
	Stateful bool
}

// TrackedKey is the operator's own note of the replica addresses whose status keys
// may still be in Redis: a status key outlives a replica's record while its pod
// shuts down (it still reports its status), and goes once the pod does.
func TrackedKey(agentName string) string {
	return "operator:" + agentName + ":addresses"
}

// SyncReplicas makes an agent's replica records exactly `replicas`, the pods that
// are ready and not terminating: each is written (or refreshed), every other record
// of the agent is removed, and `desired` is mirrored for the global controller to
// scale from. `present` are the addresses of every pod of the agent that still
// exists, in any state; the status keys of any other are deleted, as the
// provisioner deletes them with a replica.
func SyncReplicas(
	ctx context.Context, rdb redis.Cmdable, agentName string, replicas []Replica, present []string, desired int32,
) error {
	wanted := make(map[string]Replica, len(replicas))
	for _, replica := range replicas {
		wanted[ReplicaID(agentName, replica.Index)] = replica
	}
	members, err := rdb.SMembers(ctx, ReplicaSetKey(agentName)).Result()
	if err != nil {
		return err
	}
	tracked, err := rdb.SMembers(ctx, TrackedKey(agentName)).Result()
	if err != nil {
		return err
	}

	pipe := rdb.TxPipeline()
	for _, id := range members {
		if _, ok := wanted[id]; !ok {
			pipe.Del(ctx, "agent_instance:"+id)
			pipe.SRem(ctx, ReplicaSetKey(agentName), id)
		}
	}
	for id, replica := range wanted {
		pipe.HSet(ctx, ReplicaKey(agentName, replica.Index), replica.Record())
		pipe.SAdd(ctx, ReplicaSetKey(agentName), id)
		pipe.SAdd(ctx, TrackedKey(agentName), replica.Address())
	}
	forgetGone(ctx, pipe, agentName, tracked, present)
	pipe.Set(ctx, DesiredReplicasKey(agentName), desired, 0)
	_, err = pipe.Exec(ctx)
	return err
}

// RemoveAgent deletes what the operator wrote for an agent being removed: its
// replica records, replica set and desired count at once, and the status keys of
// each pod that is no longer `present`. Called again once its pods
// are gone, it leaves nothing. Routing drops the agent on the next PublishRouting
// without it.
func RemoveAgent(ctx context.Context, rdb redis.Cmdable, agentName string, present []string) error {
	members, err := rdb.SMembers(ctx, ReplicaSetKey(agentName)).Result()
	if err != nil {
		return err
	}
	tracked, err := rdb.SMembers(ctx, TrackedKey(agentName)).Result()
	if err != nil {
		return err
	}
	pipe := rdb.TxPipeline()
	for _, id := range members {
		pipe.Del(ctx, "agent_instance:"+id)
	}
	pipe.Del(ctx, ReplicaSetKey(agentName), DesiredReplicasKey(agentName))
	forgetGone(ctx, pipe, agentName, tracked, present)
	_, err = pipe.Exec(ctx)
	return err
}

// forgetGone deletes the status keys of tracked addresses whose pod no longer
// exists.
func forgetGone(ctx context.Context, pipe redis.Pipeliner, agentName string, tracked, present []string) {
	for _, address := range tracked {
		if !slices.Contains(present, address) {
			pipe.Del(ctx, StatusKey(address))
			pipe.SRem(ctx, TrackedKey(agentName), address)
		}
	}
}

// PublishRouting writes the project's routing table from the replica records, as
// core's publish_routing_snapshot does: every agent listed, its replicas' addresses
// oldest first, stateful flags, and agents no longer listed removed. It also writes
// UpKey, the agents with a replica up, which governance and the dashboard read (one
// missing from it counts as down). Core's reconciler judges it from each
// replica's `healthy` status and heartbeat. Here a replica is up when it has a record,
// that is when its pod is ready and not terminating: the readiness probe is the
// LocalController's /readyz, which passes only while it reports `healthy`, so
// Kubernetes already judges what the reconciler does. Pod readiness changes requeue
// the agent, so the set follows them without a heartbeat of its own.
func PublishRouting(ctx context.Context, rdb redis.Cmdable, agents []Agent) error {
	listed := make(map[string]bool, len(agents))
	for _, agent := range agents {
		listed[agent.Name] = true
	}
	existing, err := rdb.SMembers(ctx, AgentsKey).Result()
	if err != nil {
		return err
	}

	pipe := rdb.TxPipeline()
	for _, stale := range existing {
		if !listed[stale] {
			pipe.SRem(ctx, AgentsKey, stale)
			pipe.HDel(ctx, StatefulKey, stale)
			pipe.HDel(ctx, AddressesKey, stale)
		}
	}
	// Rebuilt inside the transaction, so a reader never sees it half written.
	pipe.Del(ctx, UpKey)
	for _, agent := range agents {
		pipe.SAdd(ctx, AgentsKey, agent.Name)
		if agent.Stateful {
			pipe.HSet(ctx, StatefulKey, agent.Name, "true")
		} else {
			pipe.HDel(ctx, StatefulKey, agent.Name)
		}
		addresses, err := routedAddresses(ctx, rdb, agent.Name)
		if err != nil {
			return err
		}
		if len(addresses) > 0 {
			pipe.HSet(ctx, AddressesKey, agent.Name, AddressesJSON(addresses))
			pipe.SAdd(ctx, UpKey, agent.Name)
		} else {
			pipe.HDel(ctx, AddressesKey, agent.Name)
		}
	}
	_, err = pipe.Exec(ctx)
	return err
}

// routedAddresses are an agent's replica addresses oldest first, ties in ID order, read
// from its records as core's list_replicas reads them (unfinished records skipped).
func routedAddresses(ctx context.Context, rdb redis.Cmdable, agentName string) ([]string, error) {
	members, err := rdb.SMembers(ctx, ReplicaSetKey(agentName)).Result()
	if err != nil {
		return nil, err
	}
	type routed struct {
		createdAt float64
		id        string
		address   string
	}
	var replicas []routed
	for _, id := range members {
		record, err := rdb.HGetAll(ctx, "agent_instance:"+id).Result()
		if err != nil {
			return nil, err
		}
		if record["address"] == "" {
			continue
		}
		createdAt, _ := strconv.ParseFloat(record["created_at"], 64)
		replicas = append(replicas, routed{createdAt, id, record["address"]})
	}
	slices.SortFunc(replicas, func(a, b routed) int {
		return cmp.Or(cmp.Compare(a.createdAt, b.createdAt), strings.Compare(a.id, b.id))
	})
	addresses := make([]string, len(replicas))
	for i, replica := range replicas {
		addresses[i] = replica.address
	}
	return addresses, nil
}
