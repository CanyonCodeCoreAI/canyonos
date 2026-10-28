/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"fmt"
	"slices"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

// CanyonAgentReconciler runs each CanyonAgent as a StatefulSet behind a headless
// Service.
type CanyonAgentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// RedisFor opens a project's Redis, where its replicas and routing are written.
	RedisFor RedisFor
	// RedisLogin fingerprints the login of a project's Redis, so the agent's pods
	// restart when the password rotates; nil leaves them as they are.
	RedisLogin RedisLogin
}

// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents/finalizers,verbs=update
// Delete: a surge update replaces the agent's old pods one at a time.
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch;delete
// Read only, to report an HPA that would fight the global controller.
// +kubebuilder:rbac:groups=autoscaling,resources=horizontalpodautoscalers,verbs=get;list;watch

// Reconcile makes a CanyonAgent's StatefulSet and Service match it, once its
// project's Redis is ready, writes its ready replicas and the project's routing
// into that Redis, and reports how many replicas run.
func (r *CanyonAgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	agent := &canyonosv1alpha1.CanyonAgent{}
	if err := r.Get(ctx, req.NamespacedName, agent); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if agent.DeletionTimestamp != nil {
		result, err := r.finalizeAgent(ctx, agent)
		if err != nil {
			return retryOnConflict(err)
		}
		return result, nil
	}
	if err := addFinalizer(ctx, r.Client, agent); err != nil {
		return retryOnConflict(err)
	}

	ready, reason, message, err := r.reconcileAgent(ctx, agent)
	if err != nil {
		return retryOnConflict(err)
	}
	scalers, err := r.otherScalers(ctx, agent)
	if err != nil {
		return ctrl.Result{}, err
	}
	agent.Status.ObservedGeneration = agent.Generation
	setCondition(&agent.Status.Conditions, agent.Generation, ConditionReady, ready, reason, message)
	setScalingConflict(agent, scalers)
	if err := r.Status().Update(ctx, agent); err != nil {
		return retryOnConflict(err)
	}
	next, err := nextCheck(ctx, r.Client, agent.Namespace, builders.AgentSelector(agent))
	if err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: next}, nil
}

// reconcileAgent returns whether every wanted replica is ready, and why not.
func (r *CanyonAgentReconciler) reconcileAgent(
	ctx context.Context, agent *canyonosv1alpha1.CanyonAgent,
) (bool, string, string, error) {
	// Routing and the global controller name an agent's objects by this rule.
	if want := builders.ResourceName(agent.Spec.AgentName); agent.Name != want {
		return false, "NameMismatch", fmt.Sprintf(
			"a CanyonAgent for agent %q must be named %q", agent.Spec.AgentName, want), nil
	}
	if agent.Spec.Type == typeDatabase && agent.Spec.Database == nil {
		return false, "Unsupported", "a database agent needs spec.database", nil
	}

	project := &canyonosv1alpha1.CanyonProject{}
	err := r.Get(ctx, types.NamespacedName{Namespace: agent.Namespace, Name: agent.Spec.ProjectRef}, project)
	if apierrors.IsNotFound(err) {
		return false, "ProjectNotFound", fmt.Sprintf(
			"CanyonProject %q does not exist in this namespace", agent.Spec.ProjectRef), nil
	}
	if err != nil {
		return false, "", "", err
	}
	// A replica started before Redis would only wait for it.
	if !meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady) {
		return false, "WaitingForProject", "starts once the project's Redis is ready", nil
	}

	wantService := builders.AgentService(project, agent)
	service := &corev1.Service{ObjectMeta: objectMeta(wantService.ObjectMeta)}
	if err := r.ensure(ctx, agent, service, func() {
		service.Labels = wantService.Labels
		service.Spec.ClusterIP = wantService.Spec.ClusterIP // fixed once created; always None here
		service.Spec.PublishNotReadyAddresses = true
		service.Spec.Selector = wantService.Spec.Selector
		service.Spec.Ports = wantService.Spec.Ports
	}); err != nil {
		return false, "", "", err
	}

	desired := int32(1)
	if agent.Spec.Replicas != nil {
		desired = *agent.Spec.Replicas
	}
	replicas := agentPods{
		name: agent.Spec.AgentName, workload: agent.Name, selector: builders.AgentSelector(agent),
		port: builders.ReplicaPort(agent),
	}
	database := builders.IsDatabase(agent)
	if database {
		desired = min(desired, 1) // one copy of its data
	}

	// A database's pod is never force-deleted: a node that is only unreachable may
	// still run it, and a second copy would write the same disk. It waits for the
	// node, as Kubernetes does for any stateful pod.
	if !database {
		if err := releaseLost(ctx, r.Client, agent.Namespace, replicas.selector); err != nil {
			return false, "", "", err
		}
	}
	want := builders.AgentStatefulSet(project, agent)
	if database {
		want = builders.DatabaseStatefulSet(project, agent)
	}
	if r.RedisLogin != nil {
		login, err := r.RedisLogin(ctx, project)
		if err != nil {
			return false, "", "", err
		}
		builders.StampRedisLogin(&want.Spec.Template, login)
	}
	statefulSet := &appsv1.StatefulSet{}
	err = r.Get(ctx, client.ObjectKeyFromObject(want), statefulSet)
	if client.IgnoreNotFound(err) != nil {
		return false, "", "", err
	}
	plan := rollout{replicas: desired} // a database: stopped, then started again
	if !database {
		if plan, err = planWorkload(ctx, r.Client, statefulSet, replicas, desired); err != nil {
			return false, "", "", err
		}
	}
	statefulSet = &appsv1.StatefulSet{ObjectMeta: objectMeta(want.ObjectMeta)}
	if err := r.ensure(ctx, agent, statefulSet, func() {
		statefulSet.Labels = want.Labels
		if statefulSet.CreationTimestamp.IsZero() {
			statefulSet.Spec = want.Spec
			return
		}
		// Only the count, the update strategy and the pod template may change.
		statefulSet.Spec.Replicas = &plan.replicas
		statefulSet.Spec.UpdateStrategy = want.Spec.UpdateStrategy
		statefulSet.Spec.Template = want.Spec.Template
	}); err != nil {
		return false, "", "", err
	}
	if err := replaceNext(ctx, r.Client, plan); err != nil {
		return false, "", "", err
	}
	setUpdated(&agent.Status.Conditions, agent.Generation, plan)
	// Why pods cannot run, read once: it explains both a stalled update and missing
	// ready replicas.
	problem := ""
	if plan.pending > 0 || statefulSet.Status.ReadyReplicas < desired {
		if problem, err = unschedulable(ctx, r.Client, agent.Namespace, builders.AgentSelector(agent)); err != nil {
			return false, "", "", err
		}
	}
	if plan.pending > 0 && problem != "" {
		// A new revision with no node to run on stalls the update; say why.
		updated := meta.FindStatusCondition(agent.Status.Conditions, ConditionUpdated)
		updated.Reason, updated.Message = reasonUnschedulable, problem
	}

	if err := publishReplicas(ctx, r.Client, r.RedisFor, project, replicas, desired); err != nil {
		return false, "", "", fmt.Errorf("writing replicas to the project's Redis: %w", err)
	}

	agent.Status.Replicas = statefulSet.Status.Replicas
	agent.Status.ReadyReplicas = statefulSet.Status.ReadyReplicas
	agent.Status.Selector = labels.SelectorFromSet(builders.AgentSelector(agent)).String()
	if agent.Status.ReadyReplicas < desired {
		if problem != "" {
			return false, reasonUnschedulable, problem, nil
		}
		return false, reasonStarting, fmt.Sprintf("%d of %d replicas ready", agent.Status.ReadyReplicas, desired), nil
	}
	return true, "", "", nil
}

// otherScalers are the HorizontalPodAutoscalers (KEDA makes them too) that scale the
// agent or its StatefulSet, beside the global controller.
func (r *CanyonAgentReconciler) otherScalers(ctx context.Context, agent *canyonosv1alpha1.CanyonAgent) ([]string, error) {
	hpas := &autoscalingv2.HorizontalPodAutoscalerList{}
	if err := r.List(ctx, hpas, client.InNamespace(agent.Namespace)); err != nil {
		return nil, err
	}
	var names []string
	for _, hpa := range hpas.Items {
		if scaledAgent(hpa.Spec.ScaleTargetRef) == agent.Name {
			names = append(names, hpa.Name)
		}
	}
	slices.Sort(names)
	return names, nil
}

// scaledAgent is the name of the agent an HPA scales, through its CanyonAgent or its
// StatefulSet (both carry the agent's name), or "".
func scaledAgent(target autoscalingv2.CrossVersionObjectReference) string {
	group, _, _ := strings.Cut(target.APIVersion, "/")
	switch {
	case target.Kind == "CanyonAgent" && group == canyonosv1alpha1.GroupVersion.Group,
		target.Kind == "StatefulSet" && group == appsv1.GroupName:
		return target.Name
	}
	return ""
}

// setScalingConflict reports, never fixes, an HPA scaling the agent: the global
// controller is its only scaler, and two scalers undo each other's counts.
func setScalingConflict(agent *canyonosv1alpha1.CanyonAgent, scalers []string) {
	condition := metav1.Condition{
		Type: ConditionScalingConflict, Status: metav1.ConditionFalse,
		Reason: "NoOtherScaler", ObservedGeneration: agent.Generation,
	}
	if len(scalers) > 0 {
		condition.Status = metav1.ConditionTrue
		condition.Reason = "HorizontalPodAutoscaler"
		condition.Message = fmt.Sprintf("HorizontalPodAutoscaler %s also scales this agent; CanyonOS's global "+
			"controller already scales it, so remove the HPA", strings.Join(scalers, ", "))
	}
	meta.SetStatusCondition(&agent.Status.Conditions, condition)
}

// agentOfHPA wakes the agent an HPA scales, so a conflict shows up at once.
func (r *CanyonAgentReconciler) agentOfHPA(_ context.Context, obj client.Object) []reconcile.Request {
	hpa, ok := obj.(*autoscalingv2.HorizontalPodAutoscaler)
	if !ok {
		return nil
	}
	name := scaledAgent(hpa.Spec.ScaleTargetRef)
	if name == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: obj.GetNamespace(), Name: name}}}
}

// ensure creates obj or brings it in line with `desired`, owned by the agent.
func (r *CanyonAgentReconciler) ensure(
	ctx context.Context, agent *canyonosv1alpha1.CanyonAgent, obj client.Object, desired func(),
) error {
	return ensureOwned(ctx, r.Client, r.Scheme, agent, obj, desired)
}

// agentsOfProject wakes every CanyonAgent of a project when the project changes:
// its Redis turning ready starts them, and its settings reach their pods.
func (r *CanyonAgentReconciler) agentsOfProject(ctx context.Context, obj client.Object) []reconcile.Request {
	agents := &canyonosv1alpha1.CanyonAgentList{}
	if err := r.List(ctx, agents, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var requests []reconcile.Request
	for _, agent := range agents.Items {
		if agent.Spec.ProjectRef == obj.GetName() {
			requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&agent)})
		}
	}
	return requests
}

// agentOfPod wakes the agent a pod belongs to, so a replica turning ready or
// terminating reaches routing at once.
func (r *CanyonAgentReconciler) agentOfPod(_ context.Context, obj client.Object) []reconcile.Request {
	name := obj.GetLabels()[builders.LabelAgent]
	if name == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: obj.GetNamespace(), Name: name}}}
}

// SetupWithManager reconciles an agent when it, its StatefulSet, Service or pods,
// or its project changes.
func (r *CanyonAgentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&canyonosv1alpha1.CanyonAgent{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Watches(&canyonosv1alpha1.CanyonProject{}, handler.EnqueueRequestsFromMapFunc(r.agentsOfProject)).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.agentOfPod)).
		Watches(&autoscalingv2.HorizontalPodAutoscaler{}, handler.EnqueueRequestsFromMapFunc(r.agentOfHPA)).
		Named("canyonagent").
		Complete(r)
}
