/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package redisstate

import (
	"context"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	server := miniredis.RunT(t)
	return server, redis.NewClient(&redis.Options{Addr: server.Addr()})
}

// addressesOf are the replicas' addresses: their pods all exist.
func addressesOf(replicas []Replica) []string {
	addresses := make([]string, len(replicas))
	for i, replica := range replicas {
		addresses[i] = replica.Address()
	}
	return addresses
}

// replicasOf rebuilds an agent's replicas from the contract's records.
func replicasOf(c contract, agentName string) []Replica {
	var replicas []Replica
	for index := 0; ; index++ {
		record, ok := c.Records[ReplicaKey(agentName, index)]
		if !ok {
			return replicas
		}
		replicas = append(replicas, replicaFromRecord(c, record))
	}
}

func TestWritingTheContractsReplicasGivesExactlyItsRedisState(t *testing.T) {
	c := load(t)
	server, rdb := newRedis(t)
	ctx := context.Background()

	for _, agent := range []string{helloAgent, workflowAgent} {
		replicas := replicasOf(c, agent)
		if err := SyncReplicas(ctx, rdb, agent, replicas, addressesOf(replicas), 1); err != nil {
			t.Fatal(err)
		}
	}
	agents := []Agent{{Name: helloAgent, Stateful: true}, {Name: workflowAgent}}
	if err := PublishRouting(ctx, rdb, agents); err != nil {
		t.Fatal(err)
	}

	for key, want := range c.Records {
		if got := rdb.HGetAll(ctx, key).Val(); !maps.Equal(got, want) {
			t.Errorf("%s:\n got  %v\n want %v", key, got, want)
		}
	}
	for key, want := range c.ReplicaSets {
		got, _ := server.Members(key)
		if !slices.Equal(got, want) {
			t.Errorf("%s: got %v, want %v", key, got, want)
		}
	}
	for agent, want := range c.Routing.Addresses {
		if got := rdb.HGet(ctx, AddressesKey, agent).Val(); got != want {
			t.Errorf("routing %s:\n got  %s\n want %s", agent, got, want)
		}
	}
	if got := rdb.HGetAll(ctx, StatefulKey).Val(); !maps.Equal(got, c.Routing.Stateful) {
		t.Errorf("stateful: got %v, want %v", got, c.Routing.Stateful)
	}
	if keys := rdb.Keys(ctx, "controller:*:replica_id").Val(); len(keys) != 0 {
		t.Errorf("a replica reads its ID from CANYONOS_REPLICA_ID, not Redis: %v", keys)
	}
	if got := rdb.Get(ctx, c.DesiredReplicasKey).Val(); got != "1" {
		t.Errorf("desired: got %q", got)
	}
}

func TestAStoppingReplicaLeavesAtOnceAndItsKeysWhenItsPodGoes(t *testing.T) {
	c := load(t)
	_, rdb := newRedis(t)
	ctx := context.Background()
	both := replicasOf(c, helloAgent)
	if err := SyncReplicas(ctx, rdb, helloAgent, both, addressesOf(both), 2); err != nil {
		t.Fatal(err)
	}
	gone := both[1]
	rdb.Set(ctx, StatusKey(gone.Address()), "stopped", 0)

	// Terminating: no longer a replica, but its pod still runs and reports.
	if err := SyncReplicas(ctx, rdb, helloAgent, both[:1], addressesOf(both), 1); err != nil {
		t.Fatal(err)
	}
	if rdb.Exists(ctx, ReplicaKey(helloAgent, 1)).Val() != 0 {
		t.Error("a stopping replica's record must go at once")
	}
	if rdb.Exists(ctx, StatusKey(gone.Address())).Val() != 1 {
		t.Error("its status stays while its pod shuts down")
	}

	// Its pod is gone.
	if err := SyncReplicas(ctx, rdb, helloAgent, both[:1], addressesOf(both[:1]), 1); err != nil {
		t.Fatal(err)
	}
	if rdb.Exists(ctx, StatusKey(gone.Address())).Val() != 0 {
		t.Error("its status goes with its pod")
	}
	if rdb.SIsMember(ctx, TrackedKey(helloAgent), gone.Address()).Val() {
		t.Error("and the operator stops tracking it")
	}
	if members := rdb.SMembers(ctx, ReplicaSetKey(helloAgent)).Val(); !slices.Equal(members, []string{ReplicaID(helloAgent, 0)}) {
		t.Errorf("replica set: %v", members)
	}

	if err := PublishRouting(ctx, rdb, []Agent{{Name: helloAgent}}); err != nil {
		t.Fatal(err)
	}
	if got := rdb.HGet(ctx, AddressesKey, helloAgent).Val(); got != AddressesJSON([]string{both[0].Address()}) {
		t.Errorf("routing still names the stopped replica: %s", got)
	}
}

func TestAnAgentNoLongerListedLeavesTheRoutingTable(t *testing.T) {
	c := load(t)
	_, rdb := newRedis(t)
	ctx := context.Background()
	for _, agent := range []string{helloAgent, workflowAgent} {
		_ = SyncReplicas(ctx, rdb, agent, replicasOf(c, agent), nil, 1)
	}
	_ = PublishRouting(ctx, rdb, []Agent{{Name: helloAgent, Stateful: true}, {Name: workflowAgent}})

	if err := PublishRouting(ctx, rdb, []Agent{{Name: workflowAgent}}); err != nil {
		t.Fatal(err)
	}
	if rdb.SIsMember(ctx, AgentsKey, helloAgent).Val() ||
		rdb.HExists(ctx, AddressesKey, helloAgent).Val() || rdb.HExists(ctx, StatefulKey, helloAgent).Val() {
		t.Error("an unlisted agent must leave the agents set, addresses and stateful flags")
	}
}

func TestAnAgentWithNoReadyReplicaHasNoAddresses(t *testing.T) {
	_, rdb := newRedis(t)
	ctx := context.Background()
	if err := SyncReplicas(ctx, rdb, helloAgent, nil, nil, 1); err != nil {
		t.Fatal(err)
	}
	if err := PublishRouting(ctx, rdb, []Agent{{Name: helloAgent}}); err != nil {
		t.Fatal(err)
	}
	if rdb.HExists(ctx, AddressesKey, helloAgent).Val() {
		t.Error("no ready replica: callers must see NoEndpointFound, not a dead address")
	}
	if !rdb.SIsMember(ctx, AgentsKey, helloAgent).Val() {
		t.Error("the agent is still known")
	}
}

func TestARemovedAgentLeavesNothingBehind(t *testing.T) {
	c := load(t)
	server, rdb := newRedis(t)
	ctx := context.Background()
	for _, agent := range []string{helloAgent, workflowAgent} {
		replicas := replicasOf(c, agent)
		_ = SyncReplicas(ctx, rdb, agent, replicas, addressesOf(replicas), 1)
	}
	hello := replicasOf(c, helloAgent)
	for _, replica := range hello {
		rdb.Set(ctx, StatusKey(replica.Address()), "stopped", 0)
	}

	// Removed while its pods shut down: out of routing, records gone, status kept.
	if err := RemoveAgent(ctx, rdb, helloAgent, addressesOf(hello)); err != nil {
		t.Fatal(err)
	}
	if rdb.Exists(ctx, ReplicaSetKey(helloAgent), StatusKey(hello[0].Address())).Val() != 1 {
		t.Error("the replica set goes at once; a stopping pod's status stays")
	}
	// Its pods are gone.
	if err := RemoveAgent(ctx, rdb, helloAgent, nil); err != nil {
		t.Fatal(err)
	}
	if err := PublishRouting(ctx, rdb, []Agent{{Name: workflowAgent}}); err != nil {
		t.Fatal(err)
	}
	for _, key := range server.Keys() {
		if strings.Contains(key, helloAgent) || strings.Contains(key, "helloagent") {
			t.Errorf("left behind: %s", key)
		}
	}
	if !rdb.HExists(ctx, AddressesKey, workflowAgent).Val() {
		t.Error("the other agent must stay routed")
	}
}
