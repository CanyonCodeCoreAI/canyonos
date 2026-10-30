/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

// Package redisstate is the Redis data CanyonOS's Python side reads about replicas:
// each ready replica's record, the replica sets, the desired counts and the routing
// table. Its format is fixed by testdata/contract.json, generated from that Python
// (packages/core/tests/kubernetes_contract.py); the tests here check against it.
package redisstate

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const (
	// Provider names a Kubernetes replica in its record.
	Provider = "kubernetes"
	// ReplicaPort is where every replica's LocalController serves gRPC.
	ReplicaPort = 50051

	AgentsKey    = "routing_table:agents"
	AddressesKey = "routing_table:addresses"
	StatefulKey  = "routing_table:stateful"
	UpKey        = "routing_table:up"
)

// Replica is one ready pod of an agent.
type Replica struct {
	AgentName    string // the agent's name in the config (HelloAgent)
	ResourceName string // its Kubernetes name (helloagent)
	Index        int
	PodName      string
	PodUID       string
	Namespace    string
	RedisHost    string
	RedisPort    int
	CreatedAt    string // seconds since the epoch, as Python's str(float)
	// Port it takes connections on: a database's own; 0 is every agent's ReplicaPort.
	Port int
}

func (r Replica) port() int {
	if r.Port > 0 {
		return r.Port
	}
	return ReplicaPort
}

// ReplicaID is a replica's ID, as core names it: HelloAgent-0.
func ReplicaID(agentName string, index int) string {
	return fmt.Sprintf("%s-%d", agentName, index)
}

// ReplicaKey is a replica's record: agent_instance:HelloAgent-0.
func ReplicaKey(agentName string, index int) string {
	return "agent_instance:" + ReplicaID(agentName, index)
}

// ReplicaSetKey is an agent's set of replica IDs.
func ReplicaSetKey(agentName string) string {
	return "agent:" + agentName + ":instances"
}

// DesiredReplicasKey is the count the global controller scales from.
func DesiredReplicasKey(agentName string) string {
	return "agent:" + agentName + ":desired_replicas"
}

// StatusKey is where a replica reports its status, by its address.
func StatusKey(address string) string {
	return "controller:" + address + ":status"
}

// Address is where a replica takes calls: its pod's stable DNS name and gRPC port,
// the same string as the pod's CANYONOS_AGENT_HOST:CANYONOS_AGENT_PORT.
func (r Replica) Address() string {
	return fmt.Sprintf("%s.%s.%s.svc:%d", r.PodName, r.ResourceName, r.Namespace, r.port())
}

// Record is the replica's record, in the fields the Docker and EC2 provisioner
// writes. Its container is its pod.
func (r Replica) Record() map[string]string {
	host := strings.TrimSuffix(r.Address(), ":"+strconv.Itoa(r.port()))
	return map[string]string{
		"agent_name":        r.AgentName,
		"provider":          Provider,
		"replica_id":        ReplicaID(r.AgentName, r.Index),
		"private_host":      host,
		"public_host":       host,
		"host_port":         strconv.Itoa(r.port()),
		"container_port":    strconv.Itoa(r.port()),
		"published_address": r.Address(),
		"address":           r.Address(),
		"redis_host":        r.RedisHost,
		"redis_port":        strconv.Itoa(r.RedisPort),
		"container_name":    r.PodName,
		"created_at":        r.CreatedAt,
		"pod_uid":           r.PodUID,
	}
}

// AddressesJSON is an agent's entry in the routing table, byte for byte what
// Python's json.dumps writes: a list with ", " between items.
func AddressesJSON(addresses []string) string {
	quoted := make([]string, len(addresses))
	for i, address := range addresses {
		encoded, _ := json.Marshal(address) // a DNS name: ASCII, nothing to escape
		quoted[i] = string(encoded)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}
