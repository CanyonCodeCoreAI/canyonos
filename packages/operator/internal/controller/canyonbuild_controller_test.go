/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

const testBuildName = "acme-t1"

var _ = Describe("CanyonBuild controller", func() {
	var namespace string
	var counter int
	reconciler := &CanyonBuildReconciler{}

	newBuild := func() *canyonosv1alpha1.CanyonBuild {
		build := &canyonosv1alpha1.CanyonBuild{
			ObjectMeta: metav1.ObjectMeta{Name: testBuildName, Namespace: namespace},
			Spec: canyonosv1alpha1.CanyonBuildSpec{
				Project: testProjectName, Config: "config/global_controller.yaml", Registry: "localhost:5001", Tag: "t1",
			},
		}
		Expect(k8sClient.Create(ctx, build)).To(Succeed())
		return build
	}
	reconcileBuild := func(build *canyonosv1alpha1.CanyonBuild) *canyonosv1alpha1.CanyonBuild {
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(build)})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(build), build)).To(Succeed())
		return build
	}

	BeforeEach(func() {
		counter++
		namespace = fmt.Sprintf("build-%d", counter)
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace}})).To(Succeed())
		*reconciler = CanyonBuildReconciler{
			Client: k8sClient, Scheme: k8sClient.Scheme(), ControllerImage: testControllerImage,
			BuilderAddress:  "tcp://buildkitd.canyonos-build.svc:1234",
			RegistryAliases: map[string]string{"localhost:5001": "kind-registry:5000"},
		}
	})

	It("fails at once on a cluster with no builder", func() {
		reconciler.BuilderAddress = ""
		build := reconcileBuild(newBuild())
		Expect(build.Status.Phase).To(Equal(BuildFailed))
		Expect(build.Status.Message).To(ContainSubstring("builder.enabled=true"))
	})

	It("runs the build as a Job with its own identity, pushing to the alias", func() {
		build := reconcileBuild(newBuild())
		Expect(build.Status.Phase).To(Equal(BuildPending))

		for _, obj := range []client.Object{&batchv1.Job{}, &corev1.ServiceAccount{}, &rbacv1.Role{}, &rbacv1.RoleBinding{}} {
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, obj)).To(Succeed())
			Expect(obj.GetOwnerReferences()[0].Kind).To(Equal("CanyonBuild"))
		}
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		Expect(job.Spec.Template.Spec.Containers[1].Command[2]).To(ContainSubstring("--push-registry 'kind-registry:5000'"))
		Expect(job.Spec.Template.Spec.Containers[1].Image).To(Equal(testControllerImage))
	})

	// receivingPod is a build pod waiting for the upload, as the Job controller (absent
	// from envtest) makes it for the Job with jobUID.
	receivingPod := func(name string, jobUID types.UID) *corev1.Pod {
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: map[string]string{
				builders.LabelBuild: testBuildName, batchv1.ControllerUidLabel: string(jobUID),
			}},
			Spec: corev1.PodSpec{Containers: []corev1.Container{
				{Name: builders.BuildReceiver, Image: testControllerImage},
				{Name: builders.BuildContainer, Image: testControllerImage},
			}},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		pod.Status.Phase = corev1.PodRunning
		pod.Status.ContainerStatuses = []corev1.ContainerStatus{
			{Name: builders.BuildReceiver, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
			{Name: builders.BuildContainer, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
		}
		Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
		return pod
	}
	buildJob := func() *batchv1.Job {
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		return job
	}

	It("never takes the pod of an earlier build of the same name for its own", func() {
		build := reconcileBuild(newBuild())
		receivingPod(testBuildName+"-old00", "an-earlier-job")

		build = reconcileBuild(build)
		Expect(build.Status.Phase).To(Equal(BuildPending))
		Expect(build.Status.PodName).To(BeEmpty())

		receivingPod(testBuildName+"-new00", buildJob().UID)
		build = reconcileBuild(build)
		Expect(build.Status.Phase).To(Equal(BuildReceiving))
		Expect(build.Status.PodName).To(Equal(testBuildName + "-new00"))
	})

	It("says when to upload, then reports the pushed images", func() {
		build := reconcileBuild(newBuild())
		pod := receivingPod(testBuildName+"-abcde", buildJob().UID)
		build = reconcileBuild(build)
		Expect(build.Status.Phase).To(Equal(BuildReceiving))
		Expect(build.Status.PodName).To(Equal(testBuildName + "-abcde"))

		pod.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{}}
		pod.Status.ContainerStatuses[1].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
			Message: `{"images": {"HelloAgent": "localhost:5001/canyonos-acme-helloagent@sha256:abc"}}`,
		}}
		Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
		job := buildJob()
		now := metav1.Now()
		job.Status.StartTime, job.Status.CompletionTime = &now, &now
		job.Status.Succeeded = 1
		job.Status.Conditions = []batchv1.JobCondition{
			{Type: batchv1.JobSuccessCriteriaMet, Status: corev1.ConditionTrue},
			{Type: batchv1.JobComplete, Status: corev1.ConditionTrue},
		}
		Expect(k8sClient.Status().Update(ctx, job)).To(Succeed())

		build = reconcileBuild(build)
		Expect(build.Status.Phase).To(Equal(BuildSucceeded))
		Expect(build.Status.Images).To(HaveKeyWithValue("HelloAgent", "localhost:5001/canyonos-acme-helloagent@sha256:abc"))
	})
})
