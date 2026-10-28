/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

const (
	testDatabaseImage = "postgres:16-alpine"
	testDatabaseMount = "/var/lib/postgresql/data"
	lostNamespace     = "lost"
)

// A pod past its deletion deadline counts as stuck on a lost node. envtest's API
// server sets deletionTimestamp itself, so these run on the fake client, which takes
// any past one. It returns whether the reconcile force-deleted the stuck pod.
func reconcileWithStuckPod(t *testing.T, mutate func(*canyonosv1alpha1.CanyonAgent)) bool {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := canyonosv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	project := validProject(testProjectName)
	project.Namespace = lostNamespace
	setCondition(&project.Status.Conditions, project.Generation, ConditionRedisReady, true, "", "")
	agent := validAgent(testAgentName)
	agent.Namespace = lostNamespace
	mutate(agent)
	stuck := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: agent.Name + "-0", Namespace: lostNamespace,
			Labels:            map[string]string{builders.LabelAgent: agent.Name},
			Finalizers:        []string{"test.canyoncode.ai/hold"},
			DeletionTimestamp: &metav1.Time{Time: time.Now().Add(-2 * time.Minute)},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: "img"}}},
	}
	forceDeleted := false
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(project, agent, stuck).
		WithStatusSubresource(&canyonosv1alpha1.CanyonProject{}, &canyonosv1alpha1.CanyonAgent{}).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
				if obj.GetName() == stuck.Name {
					forceDeleted = true
				}
				return c.Delete(ctx, obj, opts...)
			},
		}).
		Build()
	rdb := redis.NewClient(&redis.Options{Addr: miniredis.RunT(t).Addr()})
	reconciler := &CanyonAgentReconciler{
		Client: c, Scheme: scheme,
		RedisFor: func(context.Context, *canyonosv1alpha1.CanyonProject) (redis.Cmdable, error) { return rdb, nil },
	}
	if _, err := reconciler.Reconcile(context.Background(), reconcile.Request{
		NamespacedName: client.ObjectKeyFromObject(agent),
	}); err != nil {
		t.Fatal(err)
	}
	return forceDeleted
}

func TestAnAgentPodStuckOnALostNodeIsForceDeleted(t *testing.T) {
	if !reconcileWithStuckPod(t, func(*canyonosv1alpha1.CanyonAgent) {}) {
		t.Error("a stateless replica on a lost node must be released, so it runs elsewhere")
	}
}

func TestADatabasePodStuckOnALostNodeIsNeverForceDeleted(t *testing.T) {
	forceDeleted := reconcileWithStuckPod(t, func(agent *canyonosv1alpha1.CanyonAgent) {
		agent.Spec.Type = typeDatabase
		agent.Spec.Image = testDatabaseImage
		agent.Spec.Database = &canyonosv1alpha1.DatabaseSpec{Port: 5432, MountPath: testDatabaseMount}
	})
	if forceDeleted {
		t.Error("a database's pod must wait for its node: a second copy would write the same disk")
	}
}
