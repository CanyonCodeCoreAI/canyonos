/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"fmt"
	"slices"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// revisionLabel is the StatefulSet revision a pod was created from.
const revisionLabel = appsv1.ControllerRevisionHashLabelKey

// rollout is what a surge update asks of a StatefulSet now: how many replicas to run,
// and which old pod, if any, to replace next.
type rollout struct {
	replicas int32
	replace  *corev1.Pod
	// pending counts the pods still on an old revision.
	pending int
}

// planRollout updates a StatefulSet without ever running fewer ready replicas than
// `desired`, which a StatefulSet's own rolling update does (it stops a pod before its
// replacement starts: a single-replica agent has no replica for the gap). With the
// OnDelete strategy the operator runs one extra replica (created from the new revision),
// replaces the old pods one at a time once every new pod is ready, and drops the
// extra replica when none is left. A new revision that never gets ready stalls the
// update with the old pods still serving.
//
// It is decided from the pods alone, each time: nothing is stored between passes.
func planRollout(desired int32, updateRevision, workload string, pods []corev1.Pod) rollout {
	var old []*corev1.Pod
	newReady, newTotal, stopping := 0, 0, false
	// Replicas below `desired` serving (a missing pod is not), and whether a surge
	// replica runs.
	serving, surging := 0, false
	for i := range pods {
		pod := &pods[i]
		index, ok := podIndex(workload, pod)
		if !ok {
			continue
		}
		if index >= int(desired) && pod.DeletionTimestamp == nil {
			surging = true
		} else if index < int(desired) && podServing(pod) {
			serving++
		}
		if pod.Labels[revisionLabel] != updateRevision {
			// A stopping old pod is still to be replaced: its successor is not up yet.
			old = append(old, pod)
			stopping = stopping || pod.DeletionTimestamp != nil
			continue
		}
		if pod.DeletionTimestamp != nil {
			stopping = true
			continue
		}
		newTotal++
		if podServing(pod) {
			newReady++
		}
	}
	if desired == 0 || updateRevision == "" {
		return rollout{replicas: desired}
	}
	if len(old) == 0 {
		// The last old pod's successor must serve before the surge replica goes.
		if surging && serving < int(desired) {
			return rollout{replicas: desired + 1}
		}
		return rollout{replicas: desired}
	}
	plan := rollout{replicas: desired + 1, pending: len(old)}
	// One at a time, and only once the replicas on the new revision serve.
	if stopping || newTotal == 0 || newReady < newTotal || len(old)+newTotal < int(plan.replicas) {
		return plan
	}
	slices.SortFunc(old, func(a, b *corev1.Pod) int {
		ai, _ := podIndex(workload, a)
		bi, _ := podIndex(workload, b)
		return bi - ai // the highest first, as a StatefulSet would
	})
	plan.replace = old[0]
	return plan
}

// planWorkload plans the surge update of an existing StatefulSet from its pods; a
// StatefulSet whose status has not caught up with its spec keeps its replicas.
func planWorkload(
	ctx context.Context, c client.Client, statefulSet *appsv1.StatefulSet, target agentPods, desired int32,
) (rollout, error) {
	if statefulSet.CreationTimestamp.IsZero() {
		return rollout{replicas: desired}, nil
	}
	if statefulSet.Status.ObservedGeneration < statefulSet.Generation {
		// Its revisions are not known yet: follow a new count, but keep a surge replica
		// already running rather than drop it mid-update.
		if current := statefulSet.Spec.Replicas; current != nil && *current == desired+1 && desired > 0 {
			return rollout{replicas: *current, pending: 1}, nil
		}
		return rollout{replicas: desired}, nil
	}
	pods := &corev1.PodList{}
	if err := c.List(ctx, pods, client.InNamespace(statefulSet.Namespace),
		client.MatchingLabels(target.selector)); err != nil {
		return rollout{}, err
	}
	return planRollout(desired, statefulSet.Status.UpdateRevision, target.workload, pods.Items), nil
}

// replaceNext deletes the old pod the plan replaces; the StatefulSet recreates it from
// the new revision. It leaves routing first, as any stopping pod does, and drains.
func replaceNext(ctx context.Context, c client.Client, plan rollout) error {
	if plan.replace == nil {
		return nil
	}
	err := c.Delete(ctx, plan.replace, client.Preconditions{UID: &plan.replace.UID})
	if apierrors.IsNotFound(err) || apierrors.IsConflict(err) {
		return nil
	}
	return err
}

// ConditionUpdated says whether every replica of a CanyonAgent runs its current spec.
const ConditionUpdated = "Updated"

// setUpdated reports a surge update in progress, or that none is.
func setUpdated(conditions *[]metav1.Condition, generation int64, plan rollout) {
	condition := metav1.Condition{
		Type: ConditionUpdated, Status: metav1.ConditionTrue, Reason: "UpToDate", ObservedGeneration: generation,
	}
	if plan.pending > 0 {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "RollingOut"
		condition.Message = fmt.Sprintf("%d replica(s) still to replace; one extra replica serves meanwhile", plan.pending)
	}
	meta.SetStatusCondition(conditions, condition)
}
