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
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/redisstate"
)

// testContainer names the container of pods the tests create by hand.
const testContainer = "agent"

var _ = Describe("CanyonAgent controller", func() {
	ctx := context.Background()
	var namespace string
	var counter int
	// rdb stands in for the project's Redis.
	var rdb *redis.Client
	reconciler := &CanyonAgentReconciler{}

	reconcileAgent := func(name string) *canyonosv1alpha1.CanyonAgent {
		_, err := reconciler.Reconcile(ctx, reconcile.Request{
			NamespacedName: client.ObjectKey{Namespace: namespace, Name: name},
		})
		Expect(err).NotTo(HaveOccurred())
		agent := &canyonosv1alpha1.CanyonAgent{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, agent)).To(Succeed())
		return agent
	}
	readyReason := func(agent *canyonosv1alpha1.CanyonAgent) string {
		return meta.FindStatusCondition(agent.Status.Conditions, ConditionReady).Reason
	}
	createAgent := func(mutate func(*canyonosv1alpha1.CanyonAgent)) {
		agent := validAgent(testAgentName)
		agent.Namespace = namespace
		if mutate != nil {
			mutate(agent)
		}
		Expect(k8sClient.Create(ctx, agent)).To(Succeed())
	}
	createProject := func(redisReady bool) {
		project := validProject(testProjectName)
		project.Namespace = namespace
		Expect(k8sClient.Create(ctx, project)).To(Succeed())
		if redisReady {
			setCondition(&project.Status.Conditions, project.Generation, ConditionRedisReady, true, "", "")
			Expect(k8sClient.Status().Update(ctx, project)).To(Succeed())
		}
	}

	BeforeEach(func() {
		reconciler.Client = k8sClient
		reconciler.Scheme = k8sClient.Scheme()
		rdb = redis.NewClient(&redis.Options{Addr: miniredis.RunT(GinkgoT()).Addr()})
		reconciler.RedisFor = func(context.Context, *canyonosv1alpha1.CanyonProject) (redis.Cmdable, error) {
			return rdb, nil
		}
		reconciler.RedisLogin = nil
		counter++
		namespace = fmt.Sprintf("agent-%d", counter)
		Expect(k8sClient.Create(ctx, &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: namespace},
		})).To(Succeed())
	})

	It("waits for its project's Redis", func() {
		createProject(false)
		createAgent(nil)
		Expect(readyReason(reconcileAgent(testAgentName))).To(Equal("WaitingForProject"))
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName},
			&appsv1.StatefulSet{})).NotTo(Succeed())
	})

	It("says when its project does not exist", func() {
		createAgent(nil)
		Expect(readyReason(reconcileAgent(testAgentName))).To(Equal("ProjectNotFound"))
	})

	It("refuses a name routing would not find", func() {
		createProject(true)
		agent := validAgent("hello")
		agent.Namespace = namespace
		Expect(k8sClient.Create(ctx, agent)).To(Succeed())
		reconciled := reconcileAgent("hello")
		condition := meta.FindStatusCondition(reconciled.Status.Conditions, ConditionReady)
		Expect(condition.Reason).To(Equal("NameMismatch"))
		Expect(condition.Message).To(ContainSubstring(`"` + testAgentName + `"`))
	})

	It("runs a database on its own disk and routes other agents to it", func() {
		const dbName = "statedb"
		createProject(true)
		db := validAgent(dbName)
		db.Namespace = namespace
		db.Spec.AgentName, db.Spec.Image, db.Spec.Type = "StateDB", testDatabaseImage, "database"
		db.Spec.Replicas = new(int32(3))
		db.Spec.Database = &canyonosv1alpha1.DatabaseSpec{
			Port: 5432, MountPath: testDatabaseMount, RunAsUser: new(int64(70)), FSGroup: new(int64(70)),
		}
		Expect(k8sClient.Create(ctx, db)).To(Succeed())
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: dbName + "-0", Namespace: namespace, Labels: map[string]string{builders.LabelAgent: dbName},
			},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: testDatabaseImage}}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		setPodReady(pod, true)

		reconcileAgent(dbName)

		statefulSet := &appsv1.StatefulSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: dbName}, statefulSet)).To(Succeed())
		Expect(*statefulSet.Spec.Replicas).To(Equal(int32(1)), "one copy of its data")
		Expect(statefulSet.Spec.VolumeClaimTemplates).To(HaveLen(1))
		Expect(statefulSet.Spec.UpdateStrategy.Type).To(Equal(appsv1.RollingUpdateStatefulSetStrategyType))
		service := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: dbName}, service)).To(Succeed())
		Expect(service.Spec.Ports[0].Port).To(Equal(int32(5432)))
		address := dbName + "-0." + dbName + "." + namespace + ".svc:5432"
		Expect(rdb.HGet(ctx, redisstate.AddressesKey, "StateDB").Val()).To(Equal(redisstate.AddressesJSON([]string{address})))
	})

	It("runs a StatefulSet behind a headless Service once Redis is ready", func() {
		createProject(true)
		createAgent(func(a *canyonosv1alpha1.CanyonAgent) { a.Spec.Replicas = new(int32(2)) })
		agent := reconcileAgent(testAgentName)

		for _, obj := range []client.Object{&appsv1.StatefulSet{}, &corev1.Service{}} {
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, obj)).To(Succeed())
			Expect(obj.GetOwnerReferences()).To(HaveLen(1))
			Expect(obj.GetOwnerReferences()[0].Kind).To(Equal("CanyonAgent"))
		}
		Expect(agent.Status.Selector).To(Equal(builders.LabelAgent + "=helloagent"))
		Expect(readyReason(agent)).To(Equal("Starting"))

		statefulSet := &appsv1.StatefulSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, statefulSet)).To(Succeed())
		Expect(*statefulSet.Spec.Replicas).To(Equal(int32(2)))
		statefulSet.Status.Replicas = 2
		statefulSet.Status.ReadyReplicas = 2
		statefulSet.Status.AvailableReplicas = 2
		Expect(k8sClient.Status().Update(ctx, statefulSet)).To(Succeed())

		agent = reconcileAgent(testAgentName)
		Expect(meta.IsStatusConditionTrue(agent.Status.Conditions, ConditionReady)).To(BeTrue())
		Expect(agent.Status.ReadyReplicas).To(Equal(int32(2)))
	})

	It("restarts its pods with a rotated Redis password", func() {
		login := "first"
		reconciler.RedisLogin = func(context.Context, *canyonosv1alpha1.CanyonProject) (string, error) {
			return login, nil
		}
		createProject(true)
		createAgent(nil)
		reconcileAgent(testAgentName)
		template := func() map[string]string {
			statefulSet := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, statefulSet)).
				To(Succeed())
			return statefulSet.Spec.Template.Annotations
		}
		Expect(template()).To(HaveKeyWithValue(builders.RedisLoginAnnotation, "first"))

		login = "rotated"
		reconcileAgent(testAgentName)
		Expect(template()).To(HaveKeyWithValue(builders.RedisLoginAnnotation, "rotated"))
	})

	It("follows a new replica count, as /scale sets it", func() {
		createProject(true)
		createAgent(nil)
		reconcileAgent(testAgentName)

		agent := &canyonosv1alpha1.CanyonAgent{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, agent)).To(Succeed())
		agent.Spec.Replicas = new(int32(3))
		Expect(k8sClient.Update(ctx, agent)).To(Succeed())
		reconcileAgent(testAgentName)

		statefulSet := &appsv1.StatefulSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, statefulSet)).To(Succeed())
		Expect(*statefulSet.Spec.Replicas).To(Equal(int32(3)))
	})

	It("writes its ready replicas and the routing table into the project's Redis", func() {
		createProject(true)
		createAgent(func(a *canyonosv1alpha1.CanyonAgent) {
			a.Spec.Replicas = new(int32(2))
			a.Spec.Stateful = true
		})
		createPod := func(index int, ready bool) *corev1.Pod {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name: fmt.Sprintf("%s-%d", testAgentName, index), Namespace: namespace,
					Labels: map[string]string{builders.LabelAgent: testAgentName},
				},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: testAgentImage}}},
			}
			Expect(k8sClient.Create(ctx, pod)).To(Succeed())
			setPodReady(pod, ready)
			return pod
		}
		endpoint := func(index int) string {
			return fmt.Sprintf("%s-%d.%s.%s.svc:%d", testAgentName, index, testAgentName, namespace, redisstate.ReplicaPort)
		}
		const agentName = "HelloAgent"

		first := createPod(0, true)
		second := createPod(1, false)
		reconcileAgent(testAgentName)
		Expect(rdb.SMembers(ctx, redisstate.ReplicaSetKey(agentName)).Val()).To(ConsistOf(redisstate.ReplicaID(agentName, 0)))
		record := rdb.HGetAll(ctx, redisstate.ReplicaKey(agentName, 0)).Val()
		Expect(record).To(HaveKeyWithValue("address", endpoint(0)))
		Expect(record).To(HaveKeyWithValue("pod_uid", string(first.UID)))
		Expect(rdb.Get(ctx, redisstate.DesiredReplicasKey(agentName)).Val()).To(Equal("2"))
		Expect(rdb.HGet(ctx, redisstate.StatefulKey, agentName).Val()).To(Equal("true"))

		By("a replica turning ready joins routing")
		setPodReady(second, true)
		reconcileAgent(testAgentName)
		Expect(rdb.HGet(ctx, redisstate.AddressesKey, agentName).Val()).To(Equal(
			redisstate.AddressesJSON([]string{endpoint(0), endpoint(1)})))

		By("a terminating replica leaves routing before it stops")
		first.Finalizers = []string{"test.canyoncode.ai/hold"}
		Expect(k8sClient.Update(ctx, first)).To(Succeed())
		Expect(k8sClient.Delete(ctx, first)).To(Succeed())
		reconcileAgent(testAgentName)
		Expect(rdb.HGet(ctx, redisstate.AddressesKey, agentName).Val()).To(Equal(
			redisstate.AddressesJSON([]string{endpoint(1)})))
		Expect(rdb.Exists(ctx, redisstate.ReplicaKey(agentName, 0)).Val()).To(BeZero())

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(first), first)).To(Succeed())
		first.Finalizers = nil
		Expect(k8sClient.Update(ctx, first)).To(Succeed())
	})

	It("wakes an agent when one of its pods changes", func() {
		pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: testAgentName + "-0", Namespace: namespace, Labels: map[string]string{builders.LabelAgent: testAgentName},
		}}
		Expect(reconciler.agentOfPod(ctx, pod)).To(ConsistOf(
			reconcile.Request{NamespacedName: client.ObjectKey{Namespace: namespace, Name: testAgentName}},
		))
		Expect(reconciler.agentOfPod(ctx, &corev1.Pod{})).To(BeEmpty())
	})

	It("holds a deleted agent until it is out of routing and Redis", func() {
		createProject(true)
		createAgent(nil)
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: testAgentName + "-0", Namespace: namespace,
				Labels: map[string]string{builders.LabelAgent: testAgentName},
			},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: testAgentImage}}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		setPodReady(pod, true)
		agent := reconcileAgent(testAgentName)
		Expect(agent.Finalizers).To(ContainElement(Finalizer))
		Expect(rdb.HExists(ctx, redisstate.AddressesKey, "HelloAgent").Val()).To(BeTrue())

		status := redisstate.StatusKey(fmt.Sprintf("%s-0.%s.%s.svc:50051", testAgentName, testAgentName, namespace))
		rdb.Set(ctx, status, "draining", 0)

		Expect(k8sClient.Delete(ctx, agent)).To(Succeed())
		result, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(agent)})
		Expect(err).NotTo(HaveOccurred())
		By("first out of routing, its records and count gone")
		Expect(rdb.SIsMember(ctx, redisstate.AgentsKey, "HelloAgent").Val()).To(BeFalse())
		Expect(rdb.HExists(ctx, redisstate.AddressesKey, "HelloAgent").Val()).To(BeFalse())
		Expect(rdb.Exists(ctx, redisstate.ReplicaKey("HelloAgent", 0), redisstate.ReplicaSetKey("HelloAgent"),
			redisstate.DesiredReplicasKey("HelloAgent")).Val()).To(BeZero())
		Expect(rdb.SIsMember(ctx, redisstate.AgentsKey, "endpoint").Val()).To(BeTrue())
		By("then its StatefulSet deleted, and the agent held while its pod drains")
		err = k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testAgentName}, &appsv1.StatefulSet{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
		Expect(result.RequeueAfter).To(BeNumerically(">", 0))
		Expect(rdb.Get(ctx, status).Val()).To(Equal("draining"))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(agent), &canyonosv1alpha1.CanyonAgent{})).To(Succeed())

		By("once its pod is gone, its keys go and the agent is released")
		Expect(k8sClient.Delete(ctx, pod)).To(Succeed())
		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(agent)})
		Expect(err).NotTo(HaveOccurred())
		Expect(rdb.Exists(ctx, status).Val()).To(BeZero())
		err = k8sClient.Get(ctx, client.ObjectKeyFromObject(agent), &canyonosv1alpha1.CanyonAgent{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue())
	})

	It("deleting a wrongly named CanyonAgent leaves the real one alone", func() {
		createProject(true)
		createAgent(nil)
		reconcileAgent(testAgentName)
		Expect(rdb.Exists(ctx, redisstate.DesiredReplicasKey("HelloAgent")).Val()).To(Equal(int64(1)))

		wrong := validAgent("hello")
		wrong.Namespace = namespace
		Expect(k8sClient.Create(ctx, wrong)).To(Succeed())
		reconcileAgent("hello")
		Expect(k8sClient.Delete(ctx, wrong)).To(Succeed())
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(wrong)})
		Expect(err).NotTo(HaveOccurred())

		Expect(rdb.Exists(ctx, redisstate.DesiredReplicasKey("HelloAgent")).Val()).To(Equal(int64(1)))
		Expect(rdb.SIsMember(ctx, redisstate.AgentsKey, "HelloAgent").Val()).To(BeTrue())
	})

	It("reports an HPA that also scales it, and changes nothing", func() {
		createProject(true)
		createAgent(nil)
		agent := reconcileAgent(testAgentName)
		Expect(meta.IsStatusConditionFalse(agent.Status.Conditions, ConditionScalingConflict)).To(BeTrue())

		hpa := &autoscalingv2.HorizontalPodAutoscaler{
			ObjectMeta: metav1.ObjectMeta{Name: "keda-hpa-helloagent", Namespace: namespace},
			Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
				ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
					APIVersion: "canyonos.canyoncode.ai/v1alpha1", Kind: "CanyonAgent", Name: testAgentName,
				},
				MaxReplicas: 5,
			},
		}
		Expect(k8sClient.Create(ctx, hpa)).To(Succeed())
		Expect(reconciler.agentOfHPA(ctx, hpa)).To(ConsistOf(
			reconcile.Request{NamespacedName: client.ObjectKey{Namespace: namespace, Name: testAgentName}},
		))

		agent = reconcileAgent(testAgentName)
		condition := meta.FindStatusCondition(agent.Status.Conditions, ConditionScalingConflict)
		Expect(condition.Status).To(Equal(metav1.ConditionTrue))
		Expect(condition.Message).To(ContainSubstring("keda-hpa-helloagent"))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(hpa), hpa)).To(Succeed())

		Expect(scaledAgent(autoscalingv2.CrossVersionObjectReference{
			APIVersion: "apps/v1", Kind: "StatefulSet", Name: testAgentName,
		})).To(Equal(testAgentName))
		Expect(scaledAgent(autoscalingv2.CrossVersionObjectReference{
			APIVersion: "apps/v1", Kind: "Deployment", Name: testAgentName,
		})).To(BeEmpty())
	})

	It("wakes a project's agents when the project changes", func() {
		createProject(true)
		createAgent(nil)
		other := validAgent("other")
		other.Namespace = namespace
		other.Spec.ProjectRef = "elsewhere"
		Expect(k8sClient.Create(ctx, other)).To(Succeed())

		project := &canyonosv1alpha1.CanyonProject{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testProjectName}, project)).To(Succeed())
		Expect(reconciler.agentsOfProject(ctx, project)).To(ConsistOf(
			reconcile.Request{NamespacedName: client.ObjectKey{Namespace: namespace, Name: testAgentName}},
		))
	})
})

// setPodReady sets a pod's Ready condition, as the kubelet would from its probe.
func setPodReady(pod *corev1.Pod, ready bool) {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: status}}
	ExpectWithOffset(1, k8sClient.Status().Update(context.Background(), pod)).To(Succeed())
}

var _ = Describe("Scheduling problems", func() {
	It("names the scheduler's reason a pod has no node", func() {
		namespace := "unschedulable"
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace}})).To(Succeed())
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: testAgentName + "-0", Namespace: namespace,
				Labels: map[string]string{builders.LabelAgent: testAgentName}},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: testContainer, Image: testAgentImage}}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		selector := map[string]string{builders.LabelAgent: testAgentName}
		Expect(unschedulable(ctx, k8sClient, namespace, selector)).To(BeEmpty())

		pod.Status.Conditions = []corev1.PodCondition{{
			Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonUnschedulable,
			Message: "0/2 nodes are available: 2 Insufficient cpu.",
		}}
		Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
		Expect(unschedulable(ctx, k8sClient, namespace, selector)).To(
			Equal("helloagent-0 has no node to run on: 0/2 nodes are available: 2 Insufficient cpu."))
	})
})
