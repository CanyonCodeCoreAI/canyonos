/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package redisstate

import (
	"context"
	"slices"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// Agent is one agent's entry in the routing table.
type Agent struct {
	Name     string // as in the config (HelloAgent)
	Stateful bool
}

// TrackedKey is the operator's own note of the replica addresses whose replica-ID and
// status keys may still be in Redis: those keys outlive a replica's record while
// its pod shuts down (it still reports its status), and go once the pod does.
func TrackedKey(agentName string) string {
	return "operator:" + agentName + ":addresses"
}

// SyncReplicas makes an agent's replica records exactly `replicas`, the pods that
// are ready and not terminating: each is written (or refreshed), every other record
// of the agent is removed, and `desired` is mirrored for the global controller to
// scale from. `present` are the addresses of every pod of the agent that still
// exists, in any state; the replica-ID and status keys of any other are deleted, as
// the provisioner deletes them with a replica.
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
		pipe.Set(ctx, ReplicaIDKey(replica.Address()), id, 0)
	}
	forgetGone(ctx, pipe, agentName, tracked, present)
	pipe.Set(ctx, DesiredReplicasKey(agentName), desired, 0)
	_, err = pipe.Exec(ctx)
	return err
}

// RemoveAgent deletes what the operator wrote for an agent being removed: its
// replica records, replica set and desired count at once, and the replica-ID and
// status keys of each pod that is no longer `present`. Called again once its pods
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

// forgetGone deletes the replica-ID and status keys of tracked addresses whose pod
// no longer exists.
func forgetGone(ctx context.Context, pipe redis.Pipeliner, agentName string, tracked, present []string) {
	for _, address := range tracked {
		if !slices.Contains(present, address) {
			pipe.Del(ctx, ReplicaIDKey(address), StatusKey(address))
			pipe.SRem(ctx, TrackedKey(agentName), address)
		}
	}
}

// PublishRouting writes the project's routing table from the replica records, as
// core's publish_routing_snapshot does: every agent listed, its replicas' addresses
// in index order, stateful flags, and agents no longer listed removed.
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
		} else {
			pipe.HDel(ctx, AddressesKey, agent.Name)
		}
	}
	_, err = pipe.Exec(ctx)
	return err
}

// routedAddresses are an agent's replica addresses in index order, read from its
// records as core's list_replicas reads them (unfinished records skipped).
func routedAddresses(ctx context.Context, rdb redis.Cmdable, agentName string) ([]string, error) {
	members, err := rdb.SMembers(ctx, ReplicaSetKey(agentName)).Result()
	if err != nil {
		return nil, err
	}
	type routed struct {
		index   int
		address string
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
		index, _ := strconv.Atoi(record["replica_index"])
		replicas = append(replicas, routed{index, record["address"]})
	}
	slices.SortFunc(replicas, func(a, b routed) int { return a.index - b.index })
	addresses := make([]string, len(replicas))
	for i, replica := range replicas {
		addresses[i] = replica.address
	}
	return addresses, nil
}
