/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	authorizationv1 "k8s.io/api/authorization/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

const (
	testBuildName = "acme-t1"
	testRegistry  = "localhost:5001"
)

var _ = Describe("CanyonBuild controller", func() {
	var namespace string
	var counter int
	reconciler := &CanyonBuildReconciler{}

	newBuild := func(mutate func(*canyonosv1alpha1.CanyonBuild)) *canyonosv1alpha1.CanyonBuild {
		build := &canyonosv1alpha1.CanyonBuild{
			ObjectMeta: metav1.ObjectMeta{Name: testBuildName, Namespace: namespace},
			Spec: canyonosv1alpha1.CanyonBuildSpec{
				Project: testProjectName, Config: "config/workflow_config.yaml", Registry: testRegistry, Tag: "t1",
			},
		}
		if mutate != nil {
			mutate(build)
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
			RegistryAliases: map[string]string{testRegistry: "kind-registry:5000"},
		}
	})

	It("reports the operator's CanyonOS release on the build, for the CLI to check", func() {
		reconciler.Version = "0.1.739"
		build := reconcileBuild(newBuild(nil))
		Expect(build.Status.OperatorVersion).To(Equal("0.1.739"))
	})

	It("with --fixed-users=false, leaves the build pod's user IDs unset", func() {
		reconciler.PlatformUsers = true
		reconcileBuild(newBuild(nil))
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		security := job.Spec.Template.Spec.SecurityContext
		Expect(security.RunAsUser).To(BeNil())
		Expect(security.RunAsGroup).To(BeNil())
		Expect(*security.RunAsNonRoot).To(BeTrue())
	})

	It("fails at once on a cluster with no builder", func() {
		reconciler.BuilderAddress = ""
		build := reconcileBuild(newBuild(nil))
		Expect(build.Status.Phase).To(Equal(BuildFailed))
		Expect(build.Status.Message).To(ContainSubstring("builder.enabled=true"))
	})

	It("runs the build as a Job with its own Role, pushing to the alias", func() {
		build := reconcileBuild(newBuild(nil))
		Expect(build.Status.Phase).To(Equal(BuildPending))

		for _, obj := range []client.Object{&batchv1.Job{}, &rbacv1.Role{}, &rbacv1.RoleBinding{}} {
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, obj)).To(Succeed())
			Expect(obj.GetOwnerReferences()[0].Kind).To(Equal("CanyonBuild"))
		}
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		Expect(job.Spec.Template.Spec.Containers[1].Command[2]).To(ContainSubstring("--push-registry 'kind-registry:5000'"))
		Expect(job.Spec.Template.Spec.Containers[1].Image).To(Equal(testControllerImage))
	})

	It("runs every build in a namespace as one ServiceAccount, which the builds own", func() {
		reconcileBuild(newBuild(nil))
		second := reconcileBuild(newBuild(func(b *canyonosv1alpha1.CanyonBuild) { b.Name = "acme-t2" }))

		account := &corev1.ServiceAccount{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: builders.BuildServiceAccountName},
			account)).To(Succeed())
		owners := make([]string, 0, len(account.OwnerReferences))
		for _, owner := range account.OwnerReferences {
			Expect(owner.Controller).To(BeNil())
			owners = append(owners, owner.Name)
		}
		// Kubernetes deletes it with the last of them.
		Expect(owners).To(ConsistOf(testBuildName, second.Name))
		for _, name := range []string{testBuildName, second.Name} {
			job := &batchv1.Job{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, job)).To(Succeed())
			Expect(job.Spec.Template.Spec.ServiceAccountName).To(Equal(builders.BuildServiceAccountName))
			binding := &rbacv1.RoleBinding{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, binding)).To(Succeed())
			Expect(binding.Subjects[0].Name).To(Equal(builders.BuildServiceAccountName))
		}
	})

	It("uses the namespace's own build ServiceAccount as it is, for its workload identity", func() {
		own := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{
			Name: builders.BuildServiceAccountName, Namespace: namespace,
			Annotations: map[string]string{"eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/build"},
		}}
		Expect(k8sClient.Create(ctx, own)).To(Succeed())
		reconcileBuild(newBuild(nil))

		account := &corev1.ServiceAccount{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(own), account)).To(Succeed())
		Expect(account.OwnerReferences).To(BeEmpty())
		Expect(account.Labels).To(BeEmpty())
		Expect(account.ResourceVersion).To(Equal(own.ResourceVersion))
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		Expect(job.Spec.Template.Spec.ServiceAccountName).To(Equal(builders.BuildServiceAccountName))
	})

	It("keeps a build an earlier release started able to apply its project after an upgrade", func() {
		build := newBuild(nil)
		// What the release before canyonos-build made: the build's own ServiceAccount,
		// bound to its Role, which its Job's pod runs as.
		ownAccount := build.Name
		labels := map[string]string{
			builders.LabelName: "canyonos-build", builders.LabelManagedBy: builders.ManagedBy,
			builders.LabelPartOf: "canyonos", builders.LabelBuild: build.Name,
		}
		meta := metav1.ObjectMeta{Name: build.Name, Namespace: namespace, Labels: labels}
		job := builders.BuildJob(build, builders.BuildOptions{
			Image: testControllerImage, BuilderAddress: reconciler.BuilderAddress, PushRegistry: "kind-registry:5000",
		})
		job.Spec.Template.Spec.ServiceAccountName = ownAccount
		for _, obj := range []client.Object{
			&corev1.ServiceAccount{ObjectMeta: meta},
			builders.BuildRole(build),
			&rbacv1.RoleBinding{
				ObjectMeta: meta,
				RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: build.Name},
				Subjects:   []rbacv1.Subject{{Kind: rbacv1.ServiceAccountKind, Name: ownAccount, Namespace: namespace}},
			},
			job,
		} {
			Expect(controllerutil.SetControllerReference(build, obj, k8sClient.Scheme())).To(Succeed())
			Expect(k8sClient.Create(ctx, obj)).To(Succeed())
		}

		reconcileBuild(build)

		review := &authorizationv1.SubjectAccessReview{Spec: authorizationv1.SubjectAccessReviewSpec{
			User: "system:serviceaccount:" + namespace + ":" + ownAccount,
			ResourceAttributes: &authorizationv1.ResourceAttributes{
				Namespace: namespace, Verb: "create", Group: canyonosv1alpha1.SchemeGroupVersion.Group, Resource: "canyonagents",
			},
		}}
		Expect(k8sClient.Create(ctx, review)).To(Succeed())
		Expect(review.Status.Allowed).To(BeTrue(), "the running build's pod may no longer create its CanyonAgents")
	})

	It("hands the build its registry Secret outside $HOME/.docker, where buildx writes", func() {
		reconcileBuild(newBuild(func(b *canyonosv1alpha1.CanyonBuild) { b.Spec.RegistrySecretRef = "push-login" }))

		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		build := job.Spec.Template.Spec.Containers[1]
		Expect(envOf(build)).To(HaveKeyWithValue(builders.EnvRegistryAuth, "/etc/canyonos/registry/config.json"))
		var registryVolume string
		for _, mount := range build.VolumeMounts {
			Expect(mount.MountPath).NotTo(HavePrefix("/tmp/.docker"))
			if mount.MountPath == "/etc/canyonos/registry" {
				registryVolume = mount.Name
			}
		}
		Expect(registryVolume).NotTo(BeEmpty(), "nothing is mounted at /etc/canyonos/registry")
		var secretName string
		for _, volume := range job.Spec.Template.Spec.Volumes {
			if volume.Name == registryVolume && volume.Secret != nil {
				secretName = volume.Secret.SecretName
				Expect(volume.Secret.Items).To(ConsistOf(corev1.KeyToPath{Key: corev1.DockerConfigJsonKey, Path: "config.json"}))
			}
		}
		Expect(secretName).To(Equal("push-login"))
	})

	buildEnv := func() map[string]string {
		job := &batchv1.Job{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: testBuildName}, job)).To(Succeed())
		return envOf(job.Spec.Template.Spec.Containers[1])
	}

	It("hands the build the API key hash, for the project it applies", func() {
		reconcileBuild(newBuild(func(b *canyonosv1alpha1.CanyonBuild) {
			b.Spec.Auth = &canyonosv1alpha1.AuthSpec{APIKeyHash: testAPIKeyHashA}
		}))

		Expect(buildEnv()).To(HaveKeyWithValue(builders.EnvAPIKeyHash, testAPIKeyHashA))
	})

	It("gives a build with no spec.auth no hash", func() {
		reconcileBuild(newBuild(nil))

		Expect(buildEnv()).NotTo(HaveKey(builders.EnvAPIKeyHash))
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
		build := reconcileBuild(newBuild(nil))
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
		build := reconcileBuild(newBuild(nil))
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
