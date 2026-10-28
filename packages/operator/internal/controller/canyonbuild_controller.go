/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"encoding/json"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

// Build phases, in order.
const (
	BuildPending   = "Pending"
	BuildReceiving = "Receiving"
	BuildBuilding  = "Building"
	BuildSucceeded = "Succeeded"
	BuildFailed    = "Failed"
)

// CanyonBuildReconciler runs each CanyonBuild as a Job beside the cluster's builder.
type CanyonBuildReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// ControllerImage builds when the CanyonBuild names no image.
	ControllerImage string
	// BuilderAddress is the cluster's BuildKit; empty when none is installed.
	BuilderAddress string
	// RegistryAliases maps a registry as nodes pull from it to how the builder
	// reaches it (kind: localhost:5001 -> kind-registry:5000).
	RegistryAliases map[string]string
}

// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonbuilds,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonbuilds/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch
// A build's Role grants these; Kubernetes lets the operator grant only what it holds.
// apply-project creates a project's CanyonProject the first time it is deployed.
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;create;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonprojects,verbs=create
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents,verbs=create

// Reconcile creates the build's identity and Job, and reports how far it got.
func (r *CanyonBuildReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	build := &canyonosv1alpha1.CanyonBuild{}
	if err := r.Get(ctx, req.NamespacedName, build); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if build.Status.Phase == BuildSucceeded || build.Status.Phase == BuildFailed {
		return ctrl.Result{}, nil // done; the CLI deletes it, and everything it owns goes
	}
	if r.BuilderAddress == "" {
		return ctrl.Result{}, r.setStatus(ctx, build, BuildFailed, "",
			"this cluster has no image builder: install the operator's chart with builder.enabled=true")
	}

	if err := r.ensureIdentity(ctx, build); err != nil {
		return retryOnConflict(err)
	}
	image := build.Spec.Image
	if image == "" {
		image = r.ControllerImage
	}
	push := build.Spec.Registry
	if alias, ok := r.RegistryAliases[build.Spec.Registry]; ok {
		push = alias
	}
	want := builders.BuildJob(build, builders.BuildOptions{Image: image, BuilderAddress: r.BuilderAddress, PushRegistry: push})
	job := &batchv1.Job{ObjectMeta: objectMeta(want.ObjectMeta)}
	if err := ensureOwned(ctx, r.Client, r.Scheme, build, job, func() {
		job.Labels = want.Labels
		if job.CreationTimestamp.IsZero() {
			job.Spec = want.Spec // a Job's template cannot change once created
		}
	}); err != nil {
		return retryOnConflict(err)
	}

	phase, podName, message, images, err := r.progress(ctx, build, job)
	if err != nil {
		return ctrl.Result{}, err
	}
	build.Status.Images = images
	return ctrl.Result{}, r.setStatus(ctx, build, phase, podName, message)
}

// ensureIdentity gives the build its own ServiceAccount, bound to a Role allowing
// only what applying its project needs, all owned by the build.
func (r *CanyonBuildReconciler) ensureIdentity(ctx context.Context, build *canyonosv1alpha1.CanyonBuild) error {
	wantAccount := builders.BuildServiceAccount(build)
	account := &corev1.ServiceAccount{ObjectMeta: objectMeta(wantAccount.ObjectMeta)}
	if err := ensureOwned(ctx, r.Client, r.Scheme, build, account, func() { account.Labels = wantAccount.Labels }); err != nil {
		return err
	}
	wantRole := builders.BuildRole(build)
	role := &rbacv1.Role{ObjectMeta: objectMeta(wantRole.ObjectMeta)}
	if err := ensureOwned(ctx, r.Client, r.Scheme, build, role, func() {
		role.Labels = wantRole.Labels
		role.Rules = wantRole.Rules
	}); err != nil {
		return err
	}
	wantBinding := builders.BuildRoleBinding(build)
	binding := &rbacv1.RoleBinding{ObjectMeta: objectMeta(wantBinding.ObjectMeta)}
	return ensureOwned(ctx, r.Client, r.Scheme, build, binding, func() {
		binding.Labels = wantBinding.Labels
		binding.RoleRef = wantBinding.RoleRef
		binding.Subjects = wantBinding.Subjects
	})
}

// progress reads the build's state from its Job and pod: waiting for the upload,
// building, or finished, with the pushed images or the build's own error output.
func (r *CanyonBuildReconciler) progress(
	ctx context.Context, build *canyonosv1alpha1.CanyonBuild, job *batchv1.Job,
) (string, string, string, map[string]string, error) {
	// This Job's pods only, by its uid: a build deleted and made again under the same
	// name leaves a pod with the same build label while it terminates.
	ownPods := map[string]string{batchv1.ControllerUidLabel: string(job.UID)}
	pods := &corev1.PodList{}
	if err := r.List(ctx, pods, client.InNamespace(build.Namespace), client.MatchingLabels(ownPods)); err != nil {
		return "", "", "", nil, err
	}
	// A build has one pod: its Job never retries (backoffLimit 0).
	var pod *corev1.Pod
	podName := ""
	if len(pods.Items) > 0 {
		pod = &pods.Items[0]
		podName = pod.Name
	}
	for _, condition := range job.Status.Conditions {
		if condition.Status != corev1.ConditionTrue {
			continue
		}
		switch condition.Type {
		case batchv1.JobComplete:
			images := map[string]string{}
			if message := terminationMessage(pod, builders.BuildContainer); message != "" {
				var out struct{ Images map[string]string }
				if err := json.Unmarshal([]byte(message), &out); err == nil {
					images = out.Images
				}
			}
			return BuildSucceeded, podName, "", images, nil
		case batchv1.JobFailed:
			message := terminationMessage(pod, builders.BuildContainer)
			if message == "" {
				message = terminationMessage(pod, builders.BuildReceiver)
			}
			if message == "" {
				message = condition.Message
			}
			return BuildFailed, podName, strings.TrimSpace(message), nil, nil
		}
	}
	if pod == nil || pod.Status.Phase != corev1.PodRunning {
		problem, err := unschedulable(ctx, r.Client, build.Namespace, ownPods)
		return BuildPending, podName, problem, nil, err
	}
	for _, status := range pod.Status.ContainerStatuses {
		if status.Name == builders.BuildReceiver && status.State.Running != nil {
			return BuildReceiving, podName, "upload the project to port 8090 of " + podName, nil, nil
		}
	}
	return BuildBuilding, podName, "", nil, nil
}

// terminationMessage is what a pod's container left when it stopped.
func terminationMessage(pod *corev1.Pod, container string) string {
	if pod == nil {
		return ""
	}
	for _, status := range pod.Status.ContainerStatuses {
		if status.Name == container && status.State.Terminated != nil {
			return status.State.Terminated.Message
		}
	}
	return ""
}

func (r *CanyonBuildReconciler) setStatus(
	ctx context.Context, build *canyonosv1alpha1.CanyonBuild, phase, podName, message string,
) error {
	if build.Status.Phase == phase && build.Status.PodName == podName && build.Status.Message == message &&
		phase != BuildSucceeded {
		return nil
	}
	build.Status.Phase, build.Status.PodName, build.Status.Message = phase, podName, message
	return client.IgnoreNotFound(r.Status().Update(ctx, build))
}

// buildOfPod wakes the build a pod belongs to.
func (r *CanyonBuildReconciler) buildOfPod(_ context.Context, obj client.Object) []reconcile.Request {
	name := obj.GetLabels()[builders.LabelBuild]
	if name == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: client.ObjectKey{Namespace: obj.GetNamespace(), Name: name}}}
}

// SetupWithManager reconciles a build when it, its Job or its pod changes.
func (r *CanyonBuildReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&canyonosv1alpha1.CanyonBuild{}).
		Owns(&batchv1.Job{}).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.buildOfPod)).
		Named("canyonbuild").
		Complete(r)
}
