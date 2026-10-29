/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"encoding/json"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

var _ = Describe("Dashboard registry", func() {
	const (
		dashboard = "registry-dashboard"
		readyID   = "00000000-0000-4000-8000-000000000001"
		pendingID = "00000000-0000-4000-8000-000000000002"
		lockedID  = "00000000-0000-4000-8000-000000000003"
	)
	registry := &DashboardRegistryReconciler{}

	listed := func() []registeredProject {
		secret := &corev1.Secret{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: dashboard, Name: DashboardProjectsSecret}, secret)).
			To(Succeed())
		var content struct{ Projects []registeredProject }
		Expect(json.Unmarshal(secret.Data[DashboardProjectsKey], &content)).To(Succeed())
		// Other specs leave projects of their own on the same API server.
		var ours []registeredProject
		for _, project := range content.Projects {
			if project.ProjectID == readyID || project.ProjectID == pendingID || project.ProjectID == lockedID {
				ours = append(ours, project)
			}
		}
		return ours
	}
	project := func(namespace, id string, ready, withSecret bool) *canyonosv1alpha1.CanyonProject {
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace}})).To(Succeed())
		p := validProject(testProjectName)
		p.Namespace = namespace
		p.Spec.ProjectID = id
		Expect(k8sClient.Create(ctx, p)).To(Succeed())
		if ready {
			setCondition(&p.Status.Conditions, p.Generation, ConditionRedisReady, true, "", "")
			Expect(k8sClient.Status().Update(ctx, p)).To(Succeed())
		}
		if withSecret {
			Expect(k8sClient.Create(ctx, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: builders.RedisName, Namespace: namespace},
				Data:       map[string][]byte{builders.RedisPasswordKey: []byte("s3cret")},
			})).To(Succeed())
		}
		return p
	}

	It("lists each project whose Redis is ready, with how to reach and sign in to it", func() {
		registry.Client, registry.APIReader, registry.Namespace = k8sClient, k8sClient, dashboard
		registry.Redis = &ProjectRedis{Reader: k8sClient}
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: dashboard}})).To(Succeed())
		ready := project("registry-a", readyID, true, true)
		project("registry-b", pendingID, false, true)

		result, err := registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		// Listed again on a timer: an external Redis's new password reaches the dashboard.
		Expect(result.RequeueAfter).To(Equal(resyncPeriod))

		Expect(listed()).To(ConsistOf(registeredProject{
			ProjectID: readyID, Name: testProjectName,
			Redis: registeredRedis{Host: "canyonos-redis.registry-a.svc", Port: 6379, Password: "s3cret"},
		}))

		By("a project whose password cannot be read is left out and tried again, the others stay")
		project("registry-c", lockedID, true, false)
		result, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(result.RequeueAfter).To(Equal(resyncPeriod))
		Expect(listed()).To(HaveLen(1))

		By("a project that stops being ready leaves the list")
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(ready), ready)).To(Succeed())
		setCondition(&ready.Status.Conditions, ready.Generation, ConditionRedisReady, false, "NotReady", "")
		Expect(k8sClient.Status().Update(ctx, ready)).To(Succeed())
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(listed()).To(BeEmpty())
	})

	It("is listed again only when what the list says about a project changes", func() {
		changed := func(edit func(*canyonosv1alpha1.CanyonProject)) bool {
			old := validProject(testProjectName)
			setCondition(&old.Status.Conditions, old.Generation, ConditionRedisReady, true, "", "")
			updated := old.DeepCopy()
			edit(updated)
			return listChanged(event.TypedUpdateEvent[client.Object]{ObjectOld: old, ObjectNew: updated})
		}

		Expect(changed(func(p *canyonosv1alpha1.CanyonProject) { p.Status.EndpointURL = "http://elsewhere" })).
			To(BeFalse())
		Expect(changed(func(p *canyonosv1alpha1.CanyonProject) { p.Spec.DisplayName = "renamed" })).To(BeTrue())
		Expect(changed(func(p *canyonosv1alpha1.CanyonProject) { p.Spec.Redis.Mode = redisExternal })).To(BeTrue())
		Expect(changed(func(p *canyonosv1alpha1.CanyonProject) {
			setCondition(&p.Status.Conditions, p.Generation, ConditionRedisReady, false, "NotReady", "")
		})).To(BeTrue())
		Expect(changed(func(p *canyonosv1alpha1.CanyonProject) {
			now := metav1.Now()
			p.DeletionTimestamp = &now
		})).To(BeTrue())
	})

	It("is listed again when a project's Redis rolls to a new password", func() {
		rolled := func(name, oldHash, newHash string) bool {
			old := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: name}}
			old.Spec.Template.Annotations = map[string]string{builders.ConfigHashAnnotation: oldHash}
			updated := old.DeepCopy()
			updated.Spec.Template.Annotations = map[string]string{builders.ConfigHashAnnotation: newHash}
			return passwordRotated(event.TypedUpdateEvent[client.Object]{ObjectOld: old, ObjectNew: updated})
		}

		Expect(rolled(builders.RedisName, "a", "b")).To(BeTrue())
		Expect(rolled(builders.RedisName, "a", "a")).To(BeFalse())
		Expect(rolled("helloagent", "a", "b")).To(BeFalse())
	})
})
