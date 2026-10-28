/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/redisstate"
)

const (
	// Finalizer holds a CanyonAgent or CanyonProject until the operator has taken it
	// down in order.
	Finalizer = "canyonos.canyoncode.ai/teardown"
	// teardownGiveUp is how long a deletion waits on a Redis it cannot reach before
	// going ahead without cleaning it: a deletion must never hang forever.
	teardownGiveUp = 5 * time.Minute
	// drainCheck is how often a deletion looks whether the pods it waits on are gone.
	drainCheck = 5 * time.Second
)

// addFinalizer puts the teardown finalizer on obj the first time it is reconciled.
func addFinalizer(ctx context.Context, c client.Client, obj client.Object) error {
	if !controllerutil.AddFinalizer(obj, Finalizer) {
		return nil
	}
	return c.Update(ctx, obj)
}

// releaseFinalizer lets Kubernetes delete obj and, through owner references,
// everything it still owns.
func releaseFinalizer(ctx context.Context, c client.Client, obj client.Object) error {
	if !controllerutil.RemoveFinalizer(obj, Finalizer) {
		return nil
	}
	return client.IgnoreNotFound(c.Update(ctx, obj))
}

// gaveUp says whether a deletion has waited long enough on `err` to go ahead without
// it, and logs the cleanup it skips.
func gaveUp(ctx context.Context, obj client.Object, err error, skipped string) bool {
	if time.Since(obj.GetDeletionTimestamp().Time) < teardownGiveUp {
		return false
	}
	logf.FromContext(ctx).Error(err, "giving up on cleanup to let the deletion finish", "skipped", skipped)
	return true
}

// deleteControlled deletes the named object if owner controls it; anything else of
// that name is not the operator's.
func deleteControlled(ctx context.Context, c client.Client, owner, obj client.Object, name string) error {
	err := c.Get(ctx, client.ObjectKey{Namespace: owner.GetNamespace(), Name: name}, obj)
	if err != nil {
		return client.IgnoreNotFound(err)
	}
	if !metav1.IsControlledBy(obj, owner) || obj.GetDeletionTimestamp() != nil {
		return nil
	}
	return client.IgnoreNotFound(c.Delete(ctx, obj))
}

// finalizeAgent takes a deleted agent down in order, a step per pass:
//  1. out of routing, its replica records and count gone, so no new call reaches it;
//  2. its StatefulSet deleted, so its pods drain on SIGTERM;
//  3. once its pods are gone, their agent-id and status keys go too, and the
//     agent is released.
func (r *CanyonAgentReconciler) finalizeAgent(
	ctx context.Context, agent *canyonosv1alpha1.CanyonAgent,
) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(agent, Finalizer) {
		return ctrl.Result{}, nil
	}
	project := &canyonosv1alpha1.CanyonProject{}
	err := r.Get(ctx, client.ObjectKey{Namespace: agent.Namespace, Name: agent.Spec.ProjectRef}, project)
	if apierrors.IsNotFound(err) {
		project = nil // nothing of it left to clean
	} else if err != nil {
		return ctrl.Result{}, err
	}

	present := 0
	if project != nil {
		target := agentPods{name: agent.Spec.AgentName, workload: agent.Name, selector: builders.AgentSelector(agent)}
		_, endpoints, err := listReplicas(ctx, r.Client, project, target)
		if err != nil {
			return ctrl.Result{}, err
		}
		present = len(endpoints)
		if err := r.unrouteAgent(ctx, project, agent, endpoints); err != nil &&
			!gaveUp(ctx, agent, err, "the agent's Redis keys") {
			return ctrl.Result{}, err
		}
	}
	if err := deleteControlled(ctx, r.Client, agent, &appsv1.StatefulSet{}, agent.Name); err != nil {
		return ctrl.Result{}, err
	}
	if present > 0 {
		return ctrl.Result{RequeueAfter: drainCheck}, nil
	}
	return ctrl.Result{}, releaseFinalizer(ctx, r.Client, agent)
}

// unrouteAgent removes what the operator wrote for the agent from its project's
// Redis, keeping the status keys of pods still `present` (draining). Nothing to do
// when the agent never had replicas of its own (wrong name: another CanyonAgent may
// own the agent's keys) or its project's Redis is not there.
func (r *CanyonAgentReconciler) unrouteAgent(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent, present []string,
) error {
	if agent.Name != builders.ResourceName(agent.Spec.AgentName) ||
		!meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady) {
		return nil
	}
	rdb, err := r.RedisFor(ctx, project)
	if err != nil {
		return err
	}
	agents, err := routedAgents(ctx, r.Client, project) // without this agent: it is being deleted
	if err != nil {
		return err
	}
	if err := redisstate.RemoveAgent(ctx, rdb, agent.Spec.AgentName, present); err != nil {
		return err
	}
	return redisstate.PublishRouting(ctx, rdb, agents)
}

// finalizeProject takes a deleted project down in order: the endpoint first, so no
// new request comes in; then its CanyonAgents, each unrouted and drained; and only
// once their pods are gone its Redis and global controller, which the draining
// calls still use.
func (r *CanyonProjectReconciler) finalizeProject(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(project, Finalizer) {
		return ctrl.Result{}, nil
	}
	if err := deleteControlled(ctx, r.Client, project, &appsv1.StatefulSet{}, builders.EndpointWorkload); err != nil {
		return ctrl.Result{}, err
	}
	agents := &canyonosv1alpha1.CanyonAgentList{}
	if err := r.List(ctx, agents, client.InNamespace(project.Namespace)); err != nil {
		return ctrl.Result{}, err
	}
	remaining := 0
	for _, agent := range agents.Items {
		if agent.Spec.ProjectRef != project.Name {
			continue
		}
		remaining++
		if agent.DeletionTimestamp == nil {
			if err := client.IgnoreNotFound(r.Delete(ctx, &agent)); err != nil {
				return ctrl.Result{}, err
			}
		}
	}
	draining, err := r.podsStillDraining(ctx, project)
	if err != nil {
		return ctrl.Result{}, err
	}
	if draining > 0 || remaining > 0 {
		setCondition(&project.Status.Conditions, project.Generation, ConditionReady, false, "Deleting",
			"waiting for the endpoint and agents to drain before removing Redis")
		if err := r.Status().Update(ctx, project); client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: drainCheck}, nil
	}

	// An external Redis outlives the project: leave none of the operator's keys in it.
	if err := r.cleanProjectRedis(ctx, project); err != nil && !gaveUp(ctx, project, err, "the endpoint's Redis keys") {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, releaseFinalizer(ctx, r.Client, project)
}

// podsStillDraining counts the project's endpoint and agent pods that still exist.
func (r *CanyonProjectReconciler) podsStillDraining(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) (int, error) {
	pods := &corev1.PodList{}
	if err := r.List(ctx, pods, client.InNamespace(project.Namespace),
		client.MatchingLabels{builders.LabelProject: project.Name}); err != nil {
		return 0, err
	}
	draining := 0
	for _, pod := range pods.Items {
		switch pod.Labels[builders.LabelName] {
		case builders.RedisName, builders.GCName:
			continue // they go last
		}
		if podExists(&pod) {
			draining++
		}
	}
	return draining, nil
}

// cleanProjectRedis removes the endpoint's replica and keys, and the routing table.
func (r *CanyonProjectReconciler) cleanProjectRedis(ctx context.Context, project *canyonosv1alpha1.CanyonProject) error {
	if !meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady) {
		return nil
	}
	rdb, err := r.RedisFor(ctx, project)
	if err != nil {
		return err
	}
	if err := redisstate.PublishRouting(ctx, rdb, nil); err != nil {
		return err
	}
	return redisstate.RemoveAgent(ctx, rdb, builders.EndpointAgentName, nil)
}
