/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	oldRevision = "helloagent-old"
	newRevision = "helloagent-new"
)

// pod makes replica `index` of helloagent on `revision`, ready or not.
func pod(index int, revision string, ready bool) corev1.Pod {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:   fmt.Sprintf("%s-%d", testAgentName, index),
			Labels: map[string]string{revisionLabel: revision},
		},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: status}}},
	}
}

func stopping(p corev1.Pod) corev1.Pod {
	p.DeletionTimestamp = &metav1.Time{}
	return p
}

func TestNothingToUpdateRunsTheDesiredCount(t *testing.T) {
	plan := planRollout(2, newRevision, testAgentName, []corev1.Pod{pod(0, newRevision, true), pod(1, newRevision, true)})
	if plan.replicas != 2 || plan.replace != nil || plan.pending != 0 {
		t.Errorf("got %+v", plan)
	}
}

func TestASingleReplicaIsReplacedOnlyOnceItsSuccessorServes(t *testing.T) {
	// The template changed: run one extra replica, replace nothing yet.
	plan := planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(0, oldRevision, true)})
	if plan.replicas != 2 || plan.replace != nil || plan.pending != 1 {
		t.Fatalf("start: %+v", plan)
	}
	// The extra replica exists but is not ready: still nothing replaced.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(0, oldRevision, true), pod(1, newRevision, false)})
	if plan.replace != nil {
		t.Fatalf("replaced before the successor serves: %+v", plan)
	}
	// It serves: replace the old pod.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(0, oldRevision, true), pod(1, newRevision, true)})
	if plan.replace == nil || plan.replace.Name != "helloagent-0" || plan.replicas != 2 {
		t.Fatalf("replace: %+v", plan)
	}
	// The old pod is stopping: wait for it.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{stopping(pod(0, oldRevision, true)), pod(1, newRevision, true)})
	if plan.replace != nil || plan.replicas != 2 {
		t.Fatalf("while stopping: %+v", plan)
	}
	// Deleted, its successor not created yet: the surge replica stays.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(1, newRevision, true)})
	if plan.replicas != 2 {
		t.Fatalf("surge dropped while the successor does not exist: %+v", plan)
	}
	// Recreated on the new revision but not serving yet: the surge replica stays.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(0, newRevision, false), pod(1, newRevision, true)})
	if plan.replicas != 2 {
		t.Fatalf("surge dropped before the successor serves: %+v", plan)
	}
	// Recreated on the new revision and serving: back to one replica.
	plan = planRollout(1, newRevision, testAgentName, []corev1.Pod{pod(0, newRevision, true), pod(1, newRevision, true)})
	if plan.replicas != 1 || plan.pending != 0 {
		t.Fatalf("done: %+v", plan)
	}
}

func TestOldPodsAreReplacedOneAtATimeHighestFirst(t *testing.T) {
	pods := []corev1.Pod{pod(0, oldRevision, true), pod(1, oldRevision, true), pod(2, oldRevision, true), pod(3, newRevision, true)}
	plan := planRollout(3, newRevision, testAgentName, pods)
	if plan.replace == nil || plan.replace.Name != "helloagent-2" || plan.pending != 3 || plan.replicas != 4 {
		t.Fatalf("got %+v", plan)
	}
}

func TestABrokenNewRevisionStallsWithTheOldPodsServing(t *testing.T) {
	plan := planRollout(2, newRevision, testAgentName,
		[]corev1.Pod{pod(0, oldRevision, true), pod(1, oldRevision, true), pod(2, newRevision, false)})
	if plan.replace != nil || plan.replicas != 3 {
		t.Errorf("an unready new replica must stop the update: %+v", plan)
	}
}

func TestAScaleDownIsNotHeldByHealthyReplicas(t *testing.T) {
	pods := []corev1.Pod{pod(0, newRevision, true), pod(1, newRevision, true), pod(2, newRevision, true)}
	if plan := planRollout(1, newRevision, testAgentName, pods); plan.replicas != 1 {
		t.Errorf("got %+v", plan)
	}
}

func TestScaledToZeroThereIsNothingToSurge(t *testing.T) {
	if plan := planRollout(0, newRevision, testAgentName, []corev1.Pod{pod(0, oldRevision, true)}); plan.replicas != 0 {
		t.Errorf("got %+v", plan)
	}
}

func TestAPodAMinutePastItsGraceIsGone(t *testing.T) {
	// deletionTimestamp is the end of the grace period, set by the API server.
	stuck := pod(0, newRevision, false)
	stuck.DeletionTimestamp = &metav1.Time{Time: time.Now().Add(-61 * time.Second)}
	if podExists(&stuck) {
		t.Error("a pod a minute past its grace is stuck on a lost node")
	}
	stuck.DeletionTimestamp = &metav1.Time{Time: time.Now().Add(90 * time.Second)}
	if !podExists(&stuck) {
		t.Error("a pod within its grace period is still stopping")
	}
}

func TestAStoppingPodIsLookedAtAgainWhenItWouldCountAsLost(t *testing.T) {
	p := pod(0, newRevision, true)
	p.DeletionTimestamp = &metav1.Time{Time: time.Now().Add(-50 * time.Second)}
	if until := time.Until(lostAt(&p)); until < 9*time.Second || until > 11*time.Second {
		t.Errorf("lost in ~10 s (60 s after a deadline 50 s ago), got %s", until)
	}
}
