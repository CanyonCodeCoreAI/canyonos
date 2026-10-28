/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package redisstate

import (
	"encoding/json"
	"maps"
	"os"
	"strconv"
	"strings"
	"testing"
)

// The contract's example agents: HelloAgent has two replicas, Workflow one.
const (
	helloAgent    = "HelloAgent"
	workflowAgent = "Workflow"
)

// contract is testdata/contract.json, generated from core's Python.
type contract struct {
	Provider    string `json:"provider"`
	ReplicaPort int    `json:"replica_port"`
	Example     struct {
		Namespace string `json:"namespace"`
		RedisHost string `json:"redis_host"`
		RedisPort int    `json:"redis_port"`
		CreatedAt string `json:"created_at"`
	} `json:"example"`
	Records            map[string]map[string]string `json:"records"`
	ReplicaSets        map[string][]string          `json:"replica_sets"`
	DesiredReplicasKey string                       `json:"desired_replicas_key"`
	Routing            struct {
		AgentsKey    string            `json:"agents_key"`
		AddressesKey string            `json:"addresses_key"`
		StatefulKey  string            `json:"stateful_key"`
		Addresses    map[string]string `json:"addresses"`
		Stateful     map[string]string `json:"stateful"`
	} `json:"routing"`
}

func load(t *testing.T) contract {
	t.Helper()
	raw, err := os.ReadFile("testdata/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// replicaFromRecord rebuilds the inputs of a contract record, to check Record()
// produces the same record from them.
func replicaFromRecord(c contract, record map[string]string) Replica {
	index, _ := strconv.Atoi(strings.TrimPrefix(record["replica_id"], record["agent_name"]+"-"))
	resource := map[string]string{helloAgent: "helloagent", workflowAgent: "workflow"}[record["agent_name"]]
	return Replica{
		AgentName: record["agent_name"], ResourceName: resource, Index: index,
		PodName: record["container_name"], PodUID: record["pod_uid"], Namespace: c.Example.Namespace,
		RedisHost: c.Example.RedisHost, RedisPort: c.Example.RedisPort, CreatedAt: c.Example.CreatedAt,
	}
}

func TestConstantsMatchTheContract(t *testing.T) {
	c := load(t)
	if c.Provider != Provider || c.ReplicaPort != ReplicaPort {
		t.Errorf("provider/port: contract %s/%d, operator %s/%d", c.Provider, c.ReplicaPort, Provider, ReplicaPort)
	}
	if c.Routing.AgentsKey != AgentsKey || c.Routing.AddressesKey != AddressesKey ||
		c.Routing.StatefulKey != StatefulKey {
		t.Errorf("routing keys differ: %+v", c.Routing)
	}
	if c.DesiredReplicasKey != DesiredReplicasKey(helloAgent) {
		t.Errorf("desired key: contract %s, operator %s", c.DesiredReplicasKey, DesiredReplicasKey(helloAgent))
	}
}

func TestRecordsAreWhatPythonReads(t *testing.T) {
	c := load(t)
	if len(c.Records) == 0 {
		t.Fatal("contract has no records")
	}
	for key, want := range c.Records {
		replica := replicaFromRecord(c, want)
		if got := ReplicaKey(replica.AgentName, replica.Index); got != key {
			t.Errorf("key: got %s, want %s", got, key)
		}
		if got := replica.Record(); !maps.Equal(got, want) {
			t.Errorf("record %s:\n got  %v\n want %v", key, got, want)
		}
	}
}

func TestReplicaSets(t *testing.T) {
	c := load(t)
	for _, agent := range []string{helloAgent, workflowAgent} {
		members := c.ReplicaSets[ReplicaSetKey(agent)]
		if len(members) == 0 {
			t.Fatalf("no replica set for %s", agent)
		}
		for i, member := range members {
			if member != ReplicaID(agent, i) {
				t.Errorf("%s member %d: contract %s, operator %s", agent, i, member, ReplicaID(agent, i))
			}
		}
	}
}

func TestTheRoutingTableIsByteForByteWhatPythonWrites(t *testing.T) {
	c := load(t)
	for agent, want := range c.Routing.Addresses {
		var addresses []string
		for index := 0; ; index++ {
			record, ok := c.Records[ReplicaKey(agent, index)]
			if !ok {
				break
			}
			addresses = append(addresses, record["address"])
		}
		if got := AddressesJSON(addresses); got != want {
			t.Errorf("%s:\n got  %s\n want %s", agent, got, want)
		}
	}
}

func TestADatabaseIsReachedOnItsOwnPort(t *testing.T) {
	replica := Replica{AgentName: "StateDB", ResourceName: "statedb", PodName: "statedb-0", Namespace: "acme", Port: 5432}
	if replica.Address() != "statedb-0.statedb.acme.svc:5432" {
		t.Errorf("address %s", replica.Address())
	}
	record := replica.Record()
	if record["host_port"] != "5432" || record["private_host"] != "statedb-0.statedb.acme.svc" {
		t.Errorf("record %v", record)
	}
}
