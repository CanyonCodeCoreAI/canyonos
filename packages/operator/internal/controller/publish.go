/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/redisstate"
)

// resyncPeriod rewrites replicas and routing even when nothing changed, in case
// the project's Redis lost them (a restart that missed an event).
const resyncPeriod = time.Minute

// agentPods names one agent's replicas (or the endpoint's): its name in records and routing
// (HelloAgent, endpoint), its StatefulSet (helloagent, endpoint) and the labels of
// its pods.
type agentPods struct {
	name     string
	workload string
	selector map[string]string
	// port its replicas take connections on; 0 is every agent's LocalController port.
	port int32
}

// publishReplicas writes an agent's ready replicas into its project's Redis, then
// the project's routing table from every agent's replicas. The global controller
// reads the replicas to scale and to know who is up; callers route by the table.
// Both controllers publish through here, so neither drops the other's agents.
func publishReplicas(
	ctx context.Context, c client.Client, redisFor RedisFor,
	project *canyonosv1alpha1.CanyonProject, target agentPods, desired int32,
) error {
	replicas, present, err := listReplicas(ctx, c, project, target)
	if err != nil {
		return err
	}
	rdb, err := redisFor(ctx, project)
	if err != nil {
		return err
	}
	if err := redisstate.SyncReplicas(ctx, rdb, target.name, replicas, present, desired); err != nil {
		return err
	}
	agents, err := routedAgents(ctx, c, project)
	if err != nil {
		return err
	}
	return redisstate.PublishRouting(ctx, rdb, agents)
}

// listReplicas lists an agent's pods: the replicas among them (ready, not
// terminating), and the addresses of all that still exist, draining ones included.
func listReplicas(
	ctx context.Context, c client.Client, project *canyonosv1alpha1.CanyonProject, target agentPods,
) ([]redisstate.Replica, []string, error) {
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods, client.InNamespace(project.Namespace),
		client.MatchingLabels(target.selector)); err != nil {
		return nil, nil, err
	}
	redisHost, redisPort := builders.RedisHostPort(project)
	var replicas []redisstate.Replica
	var present []string
	for _, pod := range pods.Items {
		index, ok := podIndex(target.workload, &pod)
		if !ok || !podExists(&pod) {
			continue
		}
		replica := redisstate.Replica{
			AgentName: target.name, ResourceName: target.workload, Index: index,
			PodName: pod.Name, PodUID: string(pod.UID), Namespace: pod.Namespace,
			RedisHost: redisHost, RedisPort: int(redisPort),
			CreatedAt: fmt.Sprintf("%d.0", pod.CreationTimestamp.Unix()), Port: int(target.port),
		}
		present = append(present, replica.Address())
		if podServing(&pod) {
			replicas = append(replicas, replica)
		}
	}
	return replicas, present, nil
}

// routable is an agent with replicas and routing of its own (one built from its code,
// or a database other agents find through routing, as on Docker): correctly named and not being
// deleted (unrouted before its pods stop).
func routable(agent *canyonosv1alpha1.CanyonAgent) bool {
	return agent.DeletionTimestamp == nil && agent.Name == builders.ResourceName(agent.Spec.AgentName)
}

// routedAgents are the project's agents that run, and its endpoint, as core's
// routing lists every replica spec including the endpoint's.
func routedAgents(
	ctx context.Context, c client.Client, project *canyonosv1alpha1.CanyonProject,
) ([]redisstate.Agent, error) {
	list := &canyonosv1alpha1.CanyonAgentList{}
	if err := c.List(ctx, list, client.InNamespace(project.Namespace)); err != nil {
		return nil, err
	}
	var agents []redisstate.Agent
	for _, agent := range list.Items {
		if !routable(&agent) || agent.Spec.ProjectRef != project.Name {
			continue
		}
		agents = append(agents, redisstate.Agent{Name: agent.Spec.AgentName, Stateful: agent.Spec.Stateful})
	}
	return append(agents, redisstate.Agent{Name: builders.EndpointAgentName}), nil
}

// podIndex is a replica's ordinal in its StatefulSet (helloagent-1 is 1).
func podIndex(workload string, pod *corev1.Pod) (int, bool) {
	ordinal, found := strings.CutPrefix(pod.Name, workload+"-")
	if !found {
		return 0, false
	}
	index, err := strconv.Atoi(ordinal)
	return index, err == nil
}

// podExists is a pod that is running or still stopping. One a minute past the end of
// its grace period counts as gone: its node is lost and Kubernetes will not finish it
// soon, and a deletion must not wait on it forever.
func podExists(pod *corev1.Pod) bool {
	return pod.DeletionTimestamp == nil || time.Now().Before(lostAt(pod))
}

// lostAt is when a stopping pod counts as lost: a minute after its deletion is due.
// The API server sets deletionTimestamp to the end of the grace period (the request
// time plus the grace), not to when the deletion began.
func lostAt(pod *corev1.Pod) time.Time {
	return pod.DeletionTimestamp.Add(time.Minute)
}

// nextCheck is when to look at a workload again: at the latest after resyncPeriod,
// sooner when one of its stopping pods will count as lost, so a replacement is not
// held up by the resync.
func nextCheck(ctx context.Context, c client.Client, namespace string, selector map[string]string) (time.Duration, error) {
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods, client.InNamespace(namespace), client.MatchingLabels(selector)); err != nil {
		return 0, err
	}
	next := resyncPeriod
	for i := range pods.Items {
		if pod := &pods.Items[i]; pod.DeletionTimestamp != nil {
			next = min(next, max(time.Until(lostAt(pod))+time.Second, time.Second))
		}
	}
	return next, nil
}

// podServing is a pod that takes calls: ready and not shutting down. A pod
// leaves routing the moment it starts terminating, before it stops.
func podServing(pod *corev1.Pod) bool {
	if pod.DeletionTimestamp != nil {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

// reasonUnschedulable: a pod waits for a node it fits on.
const reasonUnschedulable = "Unschedulable"

// unschedulable is the scheduler's reason a pod matching `selector` has no node (too
// little CPU or memory, a taint, a node selector nothing matches), or "" when every
// pod has one. Reported, not fatal: a cluster autoscaler may still add a node.
func unschedulable(ctx context.Context, c client.Client, namespace string, selector map[string]string) (string, error) {
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods, client.InNamespace(namespace), client.MatchingLabels(selector)); err != nil {
		return "", err
	}
	for _, pod := range pods.Items {
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodScheduled && condition.Status == corev1.ConditionFalse &&
				condition.Reason == corev1.PodReasonUnschedulable {
				return fmt.Sprintf("%s has no node to run on: %s", pod.Name, condition.Message), nil
			}
		}
	}
	return "", nil
}

// releaseLost force-deletes the pods of a workload stuck stopping on a lost node: past
// their grace period plus a minute, with no kubelet left to finish them. A
// StatefulSet replaces a pod only once it is gone, so without this a single-replica
// agent stays down until the node comes back or someone deletes the pod by hand.
func releaseLost(ctx context.Context, c client.Client, namespace string, selector map[string]string) error {
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods, client.InNamespace(namespace), client.MatchingLabels(selector)); err != nil {
		return err
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.DeletionTimestamp == nil || podExists(pod) {
			continue
		}
		logf.FromContext(ctx).Info("force-deleting a pod stuck on a lost node", "pod", pod.Name, "node", pod.Spec.NodeName)
		err := c.Delete(ctx, pod, client.GracePeriodSeconds(0), client.Preconditions{UID: &pod.UID})
		if client.IgnoreNotFound(err) != nil && !apierrors.IsConflict(err) {
			return err
		}
	}
	return nil
}
