/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"fmt"

	"github.com/alicebob/miniredis/v2"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/redis/go-redis/v9"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/redisstate"
)

const (
	testControllerImage   = "ghcr.io/canyoncodecoreai/canyonos-core:1.2.3"
	testExternalRedisHost = "redis.example.internal"
)

// envtest runs an API server but no controllers, so a StatefulSet never gets pods;
// readiness is set by hand where a test needs it.
var _ = Describe("CanyonProject controller: Redis", func() {
	ctx := context.Background()
	var namespace string
	var counter int
	// rdb stands in for the project's Redis.
	var rdb *redis.Client

	reconciler := func() *CanyonProjectReconciler {
		return &CanyonProjectReconciler{
			Client:            k8sClient,
			Scheme:            k8sClient.Scheme(),
			APIReader:         k8sClient,
			OperatorNamespace: "canyonos-system",
			RedisImage:        builders.RedisImage,
			ControllerImage:   testControllerImage,
			RedisFor: func(context.Context, *canyonosv1alpha1.CanyonProject) (redis.Cmdable, error) {
				return rdb, nil
			},
			RedisLogin: (&ProjectRedis{Reader: k8sClient}).Login,
		}
	}
	reconcileProject := func() {
		_, err := reconciler().Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Namespace: namespace, Name: testProjectName},
		})
		Expect(err).NotTo(HaveOccurred())
	}
	get := func(obj client.Object, name string) {
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, obj)).To(Succeed())
	}
	markReady := func(name string) {
		statefulSet := &appsv1.StatefulSet{}
		get(statefulSet, name)
		statefulSet.Status.Replicas = 1
		statefulSet.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, statefulSet)).To(Succeed())
	}
	markRedisReady := func() { markReady(builders.RedisName) }
	createProject := func(mutate func(*canyonosv1alpha1.CanyonProject)) {
		project := validProject(testProjectName)
		project.Namespace = namespace
		if mutate != nil {
			mutate(project)
		}
		Expect(k8sClient.Create(ctx, project)).To(Succeed())
	}

	BeforeEach(func() {
		counter++
		namespace = "redis-" + string(rune('a'+counter))
		rdb = redis.NewClient(&redis.Options{Addr: miniredis.RunT(GinkgoT()).Addr()})
		Expect(k8sClient.Create(ctx, &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: namespace},
		})).To(Succeed())
	})

	It("creates the Secret, StatefulSet, Service and NetworkPolicy, owned by the project", func() {
		createProject(nil)
		reconcileProject()

		secret := &corev1.Secret{}
		get(secret, builders.RedisName)
		Expect(string(secret.Data[builders.RedisPasswordKey])).To(MatchRegexp(`^[0-9a-f]{64}$`))

		for _, obj := range []client.Object{
			secret, &appsv1.StatefulSet{}, &corev1.Service{}, &networkingv1.NetworkPolicy{},
		} {
			get(obj, builders.RedisName)
			owners := obj.GetOwnerReferences()
			Expect(owners).To(HaveLen(1))
			Expect(owners[0].Kind).To(Equal("CanyonProject"))
			Expect(*owners[0].Controller).To(BeTrue())
		}
	})

	It("keeps the password across reconciles", func() {
		createProject(nil)
		reconcileProject()
		first := &corev1.Secret{}
		get(first, builders.RedisName)

		reconcileProject()
		second := &corev1.Secret{}
		get(second, builders.RedisName)
		Expect(second.Data[builders.RedisPasswordKey]).To(Equal(first.Data[builders.RedisPasswordKey]))
	})

	It("publishes the Redis address and reports not ready until Redis is", func() {
		createProject(nil)
		reconcileProject()

		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Status.RedisAddress).To(Equal("canyonos-redis." + namespace + ".svc:6379"))
		Expect(meta.IsStatusConditionFalse(project.Status.Conditions, ConditionRedisReady)).To(BeTrue())
		Expect(meta.IsStatusConditionFalse(project.Status.Conditions, ConditionReady)).To(BeTrue())

		markRedisReady()
		reconcileProject()
		get(project, testProjectName)
		Expect(meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady)).To(BeTrue())
		// Not the whole project: its global controller is still to start.
		Expect(meta.IsStatusConditionFalse(project.Status.Conditions, ConditionReady)).To(BeTrue())
		Expect(project.Status.ObservedGeneration).To(Equal(project.Generation))
	})

	It("starts no global controller before Redis is ready", func() {
		createProject(nil)
		reconcileProject()

		err := k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.GCName},
			&appsv1.Deployment{})
		Expect(err).To(HaveOccurred())
		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		condition := meta.FindStatusCondition(project.Status.Conditions, ConditionControllerReady)
		Expect(condition.Reason).To(Equal("WaitingForRedis"))
	})

	It("then runs it with its own namespaced Role, and reports why it is not ready yet", func() {
		createProject(nil)
		reconcileProject()
		markRedisReady()
		reconcileProject()

		for _, obj := range []client.Object{
			&corev1.ServiceAccount{}, &rbacv1.Role{}, &rbacv1.RoleBinding{}, &appsv1.Deployment{},
		} {
			get(obj, builders.GCName)
			Expect(obj.GetOwnerReferences()).To(HaveLen(1))
		}
		deployment := &appsv1.Deployment{}
		get(deployment, builders.GCName)
		Expect(deployment.Spec.Template.Spec.Containers[0].Image).To(Equal(testControllerImage))

		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		condition := meta.FindStatusCondition(project.Status.Conditions, ConditionControllerReady)
		Expect(condition.Reason).To(Equal("ConfigMissing"))

		Expect(k8sClient.Create(ctx, &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "canyonos-config", Namespace: namespace},
		})).To(Succeed())
		reconcileProject()
		get(project, testProjectName)
		condition = meta.FindStatusCondition(project.Status.Conditions, ConditionControllerReady)
		Expect(condition.Reason).To(Equal("Starting"))

		deployment.Status.Replicas = 1
		deployment.Status.ReadyReplicas = 1
		deployment.Status.AvailableReplicas = 1
		Expect(k8sClient.Status().Update(ctx, deployment)).To(Succeed())
		reconcileProject()
		get(project, testProjectName)
		Expect(meta.IsStatusConditionTrue(project.Status.Conditions, ConditionControllerReady)).To(BeTrue())
		// Not the whole project: its endpoint is still to start.
		Expect(meta.IsStatusConditionFalse(project.Status.Conditions, ConditionReady)).To(BeTrue())

		markReady(builders.EndpointWorkload)
		reconcileProject()
		get(project, testProjectName)
		Expect(meta.IsStatusConditionTrue(project.Status.Conditions, ConditionEndpointReady)).To(BeTrue())
		Expect(meta.IsStatusConditionTrue(project.Status.Conditions, ConditionReady)).To(BeTrue())
	})

	It("starts no endpoint before Redis is ready", func() {
		createProject(nil)
		reconcileProject()

		err := k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.EndpointWorkload},
			&appsv1.StatefulSet{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		condition := meta.FindStatusCondition(project.Status.Conditions, ConditionEndpointReady)
		Expect(condition.Reason).To(Equal("WaitingForRedis"))
	})

	It("then runs the endpoint behind a headless and a ClusterIP Service, and publishes its URL", func() {
		createProject(nil)
		reconcileProject()
		markRedisReady()
		reconcileProject()

		headless := &corev1.Service{}
		get(headless, builders.EndpointWorkload)
		Expect(headless.Spec.ClusterIP).To(Equal(corev1.ClusterIPNone))
		callers := &corev1.Service{}
		get(callers, builders.EndpointName)
		Expect(callers.Spec.ClusterIP).NotTo(Equal(corev1.ClusterIPNone))
		statefulSet := &appsv1.StatefulSet{}
		get(statefulSet, builders.EndpointWorkload)
		Expect(statefulSet.Spec.Template.Spec.Containers[0].Image).To(Equal(testControllerImage))
		for _, obj := range []client.Object{headless, callers, statefulSet} {
			Expect(obj.GetOwnerReferences()).To(HaveLen(1))
			Expect(obj.GetOwnerReferences()[0].Kind).To(Equal("CanyonProject"))
		}

		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Status.EndpointURL).To(Equal("http://canyonos-endpoint." + namespace + ".svc:8080"))
		Expect(meta.FindStatusCondition(project.Status.Conditions, ConditionEndpointReady).Reason).To(Equal("Starting"))
	})

	It("restarts the global controller and the endpoint with a rotated Redis password", func() {
		createProject(nil)
		reconcileProject()
		markRedisReady()
		reconcileProject()
		logins := func() (string, string) {
			gc, endpoint := &appsv1.Deployment{}, &appsv1.StatefulSet{}
			get(gc, builders.GCName)
			get(endpoint, builders.EndpointWorkload)
			return gc.Spec.Template.Annotations[builders.RedisLoginAnnotation],
				endpoint.Spec.Template.Annotations[builders.RedisLoginAnnotation]
		}
		gcBefore, endpointBefore := logins()
		Expect(gcBefore).NotTo(BeEmpty())
		Expect(endpointBefore).To(Equal(gcBefore))

		By("deleting the password Secret, which rotates it")
		secret := &corev1.Secret{}
		get(secret, builders.RedisName)
		Expect(k8sClient.Delete(ctx, secret)).To(Succeed())
		reconcileProject()

		gcAfter, endpointAfter := logins()
		Expect(gcAfter).NotTo(Equal(gcBefore))
		Expect(endpointAfter).To(Equal(gcAfter))
	})

	It("restarts the global controller when the password of an external Redis changes in place", func() {
		Expect(k8sClient.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "elasticache", Namespace: namespace},
			Data:       map[string][]byte{builders.RedisPasswordKey: []byte("first-password")},
		})).To(Succeed())
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.Redis.Mode = redisExternal
			p.Spec.Redis.Host = testExternalRedisHost
			p.Spec.Redis.PasswordSecretRef = "elasticache"
		})
		reconcileProject()
		login := func() string {
			gc := &appsv1.Deployment{}
			get(gc, builders.GCName)
			return gc.Spec.Template.Annotations[builders.RedisLoginAnnotation]
		}
		before := login()
		Expect(before).NotTo(BeEmpty())

		By("the customer changing the password in their Secret")
		secret := &corev1.Secret{}
		get(secret, "elasticache")
		secret.Data[builders.RedisPasswordKey] = []byte("second-password")
		Expect(k8sClient.Update(ctx, secret)).To(Succeed())
		reconcileProject()

		after := login()
		Expect(after).NotTo(Equal(before))
		Expect(after).NotTo(ContainSubstring("password"))
	})

	It("marks no login on the global controller of an external Redis without a password", func() {
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.Redis.Mode = redisExternal
			p.Spec.Redis.Host = testExternalRedisHost
		})
		reconcileProject()

		gc := &appsv1.Deployment{}
		get(gc, builders.GCName)
		Expect(gc.Spec.Template.Annotations).NotTo(HaveKey(builders.RedisLoginAnnotation))
	})

	It("writes the endpoint's replica and routes it beside the agents", func() {
		createProject(nil)
		reconcileProject()
		markRedisReady()
		agent := validAgent(testAgentName)
		agent.Namespace = namespace
		Expect(k8sClient.Create(ctx, agent)).To(Succeed())

		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: builders.EndpointWorkload + "-0", Namespace: namespace,
				Labels: map[string]string{builders.LabelName: builders.EndpointWorkload, builders.LabelProject: testProjectName},
			},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "endpoint", Image: testControllerImage}}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		setPodReady(pod, true)
		reconcileProject()

		address := fmt.Sprintf("endpoint-0.endpoint.%s.svc:%d", namespace, redisstate.ReplicaPort)
		Expect(rdb.HGet(ctx, redisstate.ReplicaKey("endpoint", 0), "address").Val()).To(Equal(address))
		Expect(rdb.SMembers(ctx, redisstate.AgentsKey).Val()).To(ConsistOf("endpoint", "HelloAgent"))
		Expect(rdb.HGet(ctx, redisstate.AddressesKey, "endpoint").Val()).To(Equal(redisstate.AddressesJSON([]string{address})))

		Expect(reconciler().endpointOfPod(ctx, pod)).To(ConsistOf(
			reconcile.Request{NamespacedName: client.ObjectKey{Namespace: namespace, Name: testProjectName}},
		))
		redisPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
			builders.LabelName: builders.RedisName, builders.LabelProject: testProjectName,
		}}}
		Expect(reconciler().endpointOfPod(ctx, redisPod)).To(BeEmpty())
	})

	It("exposes the endpoint through an Ingress when asked, and publishes its host", func() {
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.Endpoint.Ingress = &canyonosv1alpha1.EndpointIngress{
				Host: "acme.apps.example.com", TLSSecretName: "acme-tls",
			}
		})
		reconcileProject()
		markRedisReady()
		reconcileProject()

		ingress := &networkingv1.Ingress{}
		get(ingress, builders.EndpointName)
		Expect(ingress.Spec.Rules[0].Host).To(Equal("acme.apps.example.com"))
		Expect(ingress.GetOwnerReferences()[0].Kind).To(Equal("CanyonProject"))
		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Status.EndpointURL).To(Equal("https://acme.apps.example.com"))
		deployment := &appsv1.Deployment{}
		get(deployment, builders.GCName)
		Expect(deployment.Spec.Template.Spec.Containers[0].Env).To(ContainElement(
			corev1.EnvVar{Name: "CANYONOS_ENDPOINT_URL", Value: "https://acme.apps.example.com"}))

		By("removing the Ingress it made once the project no longer asks for one")
		project.Spec.Endpoint.Ingress = nil
		Expect(k8sClient.Update(ctx, project)).To(Succeed())
		reconcileProject()
		err := k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.EndpointName}, &networkingv1.Ingress{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
		get(project, testProjectName)
		Expect(project.Status.EndpointURL).To(Equal("http://canyonos-endpoint." + namespace + ".svc:8080"))
	})

	It("publishes a URL the customer exposes the endpoint at, and creates nothing for it", func() {
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.Endpoint.URL = "https://gateway.example.com/acme"
		})
		reconcileProject()
		markRedisReady()
		reconcileProject()

		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Status.EndpointURL).To(Equal("https://gateway.example.com/acme"))
		err := k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.EndpointName}, &networkingv1.Ingress{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
	})

	It("leaves alone a customer's Ingress that happens to share the name", func() {
		Expect(k8sClient.Create(ctx, &networkingv1.Ingress{
			ObjectMeta: metav1.ObjectMeta{Name: builders.EndpointName, Namespace: namespace},
			Spec: networkingv1.IngressSpec{DefaultBackend: &networkingv1.IngressBackend{
				Service: &networkingv1.IngressServiceBackend{Name: "web", Port: networkingv1.ServiceBackendPort{Number: 80}},
			}},
		})).To(Succeed())
		createProject(nil)
		reconcileProject()
		markRedisReady()
		reconcileProject()

		get(&networkingv1.Ingress{}, builders.EndpointName)
	})

	It("takes a deleted project down in order: endpoint, agents, their pods, then Redis", func() {
		createProject(nil)
		reconcileProject()
		markRedisReady()
		reconcileProject()
		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Finalizers).To(ContainElement(Finalizer))

		agents := &CanyonAgentReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), RedisFor: reconciler().RedisFor}
		agent := validAgent(testAgentName)
		agent.Namespace = namespace
		Expect(k8sClient.Create(ctx, agent)).To(Succeed())
		_, err := agents.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(agent)})
		Expect(err).NotTo(HaveOccurred())
		// A replica still draining, held by a finalizer as a kubelet would hold it.
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: testAgentName + "-0", Namespace: namespace, Finalizers: []string{"test.canyoncode.ai/draining"},
				Labels: map[string]string{builders.LabelAgent: testAgentName, builders.LabelProject: testProjectName,
					builders.LabelName: testAgentName},
			},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: testAgentImage}}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())

		Expect(k8sClient.Delete(ctx, project)).To(Succeed())
		result, err := reconciler().Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(project)})
		Expect(err).NotTo(HaveOccurred())
		Expect(result.RequeueAfter).To(BeNumerically(">", 0))
		err = k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.EndpointWorkload}, &appsv1.StatefulSet{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue(), "the endpoint goes first")
		get(agent, testAgentName)
		Expect(agent.DeletionTimestamp).NotTo(BeNil(), "then the project's agents")
		get(&appsv1.StatefulSet{}, builders.RedisName)

		By("the agent is unrouted but held while its pod drains, so Redis stays")
		Expect(k8sClient.Delete(ctx, pod)).To(Succeed())
		_, err = agents.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(agent)})
		Expect(err).NotTo(HaveOccurred())
		get(agent, testAgentName)
		result, err = reconciler().Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(project)})
		Expect(err).NotTo(HaveOccurred())
		Expect(result.RequeueAfter).To(BeNumerically(">", 0))
		get(project, testProjectName)
		Expect(meta.FindStatusCondition(project.Status.Conditions, ConditionReady).Reason).To(Equal("Deleting"))
		get(&appsv1.StatefulSet{}, builders.RedisName)

		By("once the pod is gone, the agent is released, then Redis cleaned and the project released")
		get(pod, pod.Name)
		pod.Finalizers = nil
		Expect(k8sClient.Update(ctx, pod)).To(Succeed())
		_, err = agents.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(agent)})
		Expect(err).NotTo(HaveOccurred())
		err = k8sClient.Get(ctx, client.ObjectKeyFromObject(agent), &canyonosv1alpha1.CanyonAgent{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
		_, err = reconciler().Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(project)})
		Expect(err).NotTo(HaveOccurred())
		Expect(rdb.Exists(ctx, redisstate.AgentsKey, redisstate.AddressesKey).Val()).To(BeZero())
		err = k8sClient.Get(ctx, client.ObjectKeyFromObject(project), &canyonosv1alpha1.CanyonProject{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
	})

	It("deletes Redis's disk with the project", func() {
		createProject(nil)
		reconcileProject()
		statefulSet := &appsv1.StatefulSet{}
		get(statefulSet, builders.RedisName)
		Expect(statefulSet.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).
			To(Equal(appsv1.DeletePersistentVolumeClaimRetentionPolicyType))
	})

	It("never takes over an object of the same name it did not create", func() {
		Expect(k8sClient.Create(ctx, &corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: builders.RedisName, Namespace: namespace,
				Labels: map[string]string{"team": "payments"}},
			Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 6379}}},
		})).To(Succeed())
		createProject(nil)
		_, err := reconciler().Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Namespace: namespace, Name: testProjectName},
		})
		Expect(err).To(MatchError(ContainSubstring("not managed by CanyonOS")))

		service := &corev1.Service{}
		get(service, builders.RedisName)
		Expect(service.OwnerReferences).To(BeEmpty())
		Expect(service.Labels).To(Equal(map[string]string{"team": "payments"}))
	})

	It("uses a project's own controller image, for a registry mirror", func() {
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.ControllerImage = "mirror.example.internal/canyonos-core:1.2.3"
		})
		reconcileProject()
		markRedisReady()
		reconcileProject()

		deployment := &appsv1.Deployment{}
		get(deployment, builders.GCName)
		Expect(deployment.Spec.Template.Spec.Containers[0].Image).
			To(Equal("mirror.example.internal/canyonos-core:1.2.3"))
	})

	It("puts back a Service someone deleted", func() {
		createProject(nil)
		reconcileProject()
		service := &corev1.Service{}
		get(service, builders.RedisName)
		Expect(k8sClient.Delete(ctx, service)).To(Succeed())

		reconcileProject()
		get(&corev1.Service{}, builders.RedisName)
	})

	It("runs nothing for an external Redis and publishes its address", func() {
		createProject(func(p *canyonosv1alpha1.CanyonProject) {
			p.Spec.Redis.Mode = redisExternal
			p.Spec.Redis.Host = testExternalRedisHost
		})
		reconcileProject()

		err := k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.RedisName},
			&appsv1.StatefulSet{})
		Expect(client.IgnoreNotFound(err)).To(Succeed())
		Expect(err).To(HaveOccurred())

		project := &canyonosv1alpha1.CanyonProject{}
		get(project, testProjectName)
		Expect(project.Status.RedisAddress).To(Equal("redis.example.internal:6379"))
		Expect(meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady)).To(BeTrue())
	})

	It("turns a write conflict into a quiet retry", func() {
		conflict := apierrors.NewConflict(
			schema.GroupResource{Group: "apps", Resource: "deployments"}, "canyonos-gc", nil)
		result, err := retryOnConflict(conflict)
		Expect(err).NotTo(HaveOccurred())
		Expect(result.RequeueAfter).To(BeNumerically(">", 0))

		_, err = retryOnConflict(apierrors.NewForbidden(
			schema.GroupResource{Resource: "secrets"}, "x", nil))
		Expect(err).To(HaveOccurred())
	})

	It("ignores a project that no longer exists", func() {
		_, err := reconciler().Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Namespace: namespace, Name: "gone"},
		})
		Expect(err).NotTo(HaveOccurred())
	})
})
