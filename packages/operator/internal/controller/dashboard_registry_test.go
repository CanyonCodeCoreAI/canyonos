/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"strings"

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
	// The dashboard of the projects in namespaces named keys-*, and their keys.
	const (
		keysDashboard = "keys-dashboard"
		keysAID       = "00000000-0000-4000-8000-000000000004"
		keysBID       = "00000000-0000-4000-8000-000000000005"
		keysCID       = "00000000-0000-4000-8000-000000000006"
	)
	keyA, keyA2, keyB := ed25519PEM(), ed25519PEM(), ed25519PEM()
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

	trust := func(p *canyonosv1alpha1.CanyonProject, keys ...string) {
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(p), p)).To(Succeed())
		p.Spec.Auth = &canyonosv1alpha1.AuthSpec{TrustedKeys: keys}
		Expect(k8sClient.Update(ctx, p)).To(Succeed())
	}
	// The dashboard's trusted keys from projects in namespaces named keys-*: other specs
	// leave projects of their own on the same API server.
	trustedKeys := func() map[string]string {
		configMap := &corev1.ConfigMap{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: keysDashboard, Name: DashboardTrustedKeysConfigMap}, configMap)).
			To(Succeed())
		ours := map[string]string{}
		for name, key := range configMap.Data {
			if strings.HasPrefix(name, "keys-") {
				ours[name] = key
			}
		}
		return ours
	}
	apiPodHash := func() string {
		deployment := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: keysDashboard, Name: builders.DashboardAPIName}, deployment)).
			To(Succeed())
		return deployment.Spec.Template.Annotations[TrustedKeysAnnotation]
	}
	dashboardAPI := func() *appsv1.Deployment {
		labels := map[string]string{builders.LabelName: builders.DashboardAPIName}
		return &appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Name: builders.DashboardAPIName, Namespace: keysDashboard},
			Spec: appsv1.DeploymentSpec{
				Selector: &metav1.LabelSelector{MatchLabels: labels},
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: labels},
					Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "api", Image: "canyonos-api"}}},
				},
			},
		}
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

	It("hands the dashboard's API the keys of every listed project, and rolls it when they change", func() {
		registry.Client, registry.APIReader, registry.Namespace = k8sClient, k8sClient, keysDashboard
		registry.Redis = &ProjectRedis{Reader: k8sClient}
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: keysDashboard}})).To(Succeed())

		By("the ConfigMap exists before any project of its own is listed, so the API's volume mounts")
		_, err := registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(BeEmpty())

		By("two projects named alike in two namespaces each keep their own key")
		Expect(k8sClient.Create(ctx, dashboardAPI())).To(Succeed())
		a := project("keys-a", keysAID, true, true)
		b := project("keys-b", keysBID, true, true)
		trust(a, keyA)
		trust(b, keyB)
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(Equal(map[string]string{
			"keys-a_" + testProjectName + "_0.pub": keyA,
			"keys-b_" + testProjectName + "_0.pub": keyB,
		}))
		listedHash := apiPodHash()
		Expect(listedHash).To(HaveLen(64))

		By("nothing changed, nothing rolls")
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(apiPodHash()).To(Equal(listedHash))

		By("a rotated key replaces the old one and rolls the API")
		trust(a, keyA2)
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(HaveKeyWithValue("keys-a_"+testProjectName+"_0.pub", keyA2))
		Expect(apiPodHash()).NotTo(Equal(listedHash))

		By("a key that is not one Ed25519 public key is left out, so the API still starts")
		trust(a, "not a key", keyA2, "a comment\n"+keyB, keyA2+keyA2)
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(Equal(map[string]string{
			"keys-a_" + testProjectName + "_1.pub": keyA2,
			// Written as the one PEM block it holds, without the text before it.
			"keys-a_" + testProjectName + "_2.pub": keyB,
			"keys-b_" + testProjectName + "_0.pub": keyB,
		}))
		rotatedHash := apiPodHash()

		By("a project whose entry names would be too long for a ConfigMap is left out, the others stay")
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "keys-c"}})).To(Succeed())
		long := validProject(strings.TrimSuffix(strings.Repeat(strings.Repeat("a", 60)+".", 4), "."))
		long.Namespace = "keys-c"
		long.Spec.ProjectID = keysCID
		long.Spec.Auth = &canyonosv1alpha1.AuthSpec{TrustedKeys: []string{keyB}}
		Expect(k8sClient.Create(ctx, long)).To(Succeed())
		setCondition(&long.Status.Conditions, long.Generation, ConditionRedisReady, true, "", "")
		Expect(k8sClient.Status().Update(ctx, long)).To(Succeed())
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(HaveLen(3))
		Expect(apiPodHash()).To(Equal(rotatedHash))
		Expect(k8sClient.Delete(ctx, long)).To(Succeed())

		By("a project whose Redis stops being ready takes its keys out")
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(b), b)).To(Succeed())
		setCondition(&b.Status.Conditions, b.Generation, ConditionRedisReady, false, "NotReady", "")
		Expect(k8sClient.Status().Update(ctx, b)).To(Succeed())
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(Equal(map[string]string{
			"keys-a_" + testProjectName + "_1.pub": keyA2,
			"keys-a_" + testProjectName + "_2.pub": keyB,
		}))
		Expect(apiPodHash()).NotTo(Equal(rotatedHash))

		By("a deleted project takes its keys out")
		Expect(k8sClient.Delete(ctx, a)).To(Succeed())
		_, err = registry.Reconcile(ctx, reconcile.Request{})
		Expect(err).NotTo(HaveOccurred())
		Expect(trustedKeys()).To(BeEmpty())
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
			p.Spec.Auth = &canyonosv1alpha1.AuthSpec{TrustedKeys: []string{keyA}}
		})).To(BeTrue())

		By("a rotated key alone, so a rotation does not wait for the resync")
		old := validProject(testProjectName)
		old.Spec.Auth = &canyonosv1alpha1.AuthSpec{TrustedKeys: []string{keyA}}
		rotated := old.DeepCopy()
		rotated.Spec.Auth.TrustedKeys = []string{keyB}
		Expect(listChanged(event.TypedUpdateEvent[client.Object]{ObjectOld: old, ObjectNew: rotated})).To(BeTrue())
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

// ed25519PEM is a new Ed25519 public key in SPKI PEM, as `canyonos keys create` writes one.
func ed25519PEM() string {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	Expect(err).NotTo(HaveOccurred())
	der, err := x509.MarshalPKIXPublicKey(public)
	Expect(err).NotTo(HaveOccurred())
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}
