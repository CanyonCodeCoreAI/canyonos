/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

const (
	ConditionReady           = "Ready"
	ConditionRedisReady      = "RedisReady"
	ConditionControllerReady = "ControllerReady"
	ConditionEndpointReady   = "EndpointReady"
	// ConditionScalingConflict on a CanyonAgent: something besides the global
	// controller scales it.
	ConditionScalingConflict = "ScalingConflict"

	// reasonStarting: created, its pods not ready yet.
	reasonStarting = "Starting"
	// typeDatabase is a CanyonAgent running a database rather than an agent.
	typeDatabase = builders.TypeDatabase
	// redisExternal is a project using a Redis the cluster already has.
	redisExternal = "external"
)

// CanyonProjectReconciler keeps each project's own pieces as its CanyonProject says.
type CanyonProjectReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// APIReader reads Secrets straight from the API server: the operator never
	// caches them, which would mean listing and watching every Secret it can see.
	APIReader         client.Reader
	OperatorNamespace string
	RedisImage        string
	// ControllerImage is the canyonos-core image matching this operator's release.
	ControllerImage string
	// RedisFor opens a project's Redis, where the endpoint's replica is written.
	RedisFor RedisFor
	// RedisLogin fingerprints the login of a project's Redis, so its pods restart
	// when the password rotates; nil leaves them as they are.
	RedisLogin RedisLogin
}

// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonprojects,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonprojects/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonprojects/finalizers,verbs=update
// Delete: a deletion stops the endpoint, an agent's pods and a project's agents first.
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents,verbs=delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch
// The endpoint's Ingress is removed when a project stops asking for one.
// +kubebuilder:rbac:groups=networking.k8s.io,resources=ingresses,verbs=get;list;watch;create;update;patch;delete
// Secrets and ConfigMaps: read by name only -- no list or watch.
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;create
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch
// The global controller's Role grants these; Kubernetes lets the operator grant only
// what it holds itself.
// +kubebuilder:rbac:groups=canyonos.canyoncode.ai,resources=canyonagents/scale,verbs=get;patch
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;delete
// +kubebuilder:rbac:groups=metrics.k8s.io,resources=pods,verbs=get;list

// Reconcile makes the project's Redis, global controller and endpoint match its
// CanyonProject. It is called with only the project's name and looks at everything
// afresh each time, so running it again changes nothing that is already right.
func (r *CanyonProjectReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	project := &canyonosv1alpha1.CanyonProject{}
	if err := r.Get(ctx, req.NamespacedName, project); err != nil {
		// Gone: the objects it owned went with it (owner references).
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if project.DeletionTimestamp != nil {
		result, err := r.finalizeProject(ctx, project)
		if err != nil {
			return retryOnConflict(err)
		}
		return result, nil
	}
	if err := addFinalizer(ctx, r.Client, project); err != nil {
		return retryOnConflict(err)
	}

	redisReady, err := r.reconcileRedis(ctx, project)
	if err != nil {
		return retryOnConflict(err)
	}
	login, err := r.redisLogin(ctx, project, redisReady)
	if err != nil {
		return ctrl.Result{}, err
	}
	gc, err := r.reconcileGC(ctx, project, redisReady, login)
	if err != nil {
		return retryOnConflict(err)
	}
	endpoint, err := r.reconcileEndpoint(ctx, project, redisReady, login)
	if err != nil {
		return retryOnConflict(err)
	}

	project.Status.ObservedGeneration = project.Generation
	redisWait := partState{reason: "NotReady", message: "Redis is not ready yet"}
	if !redisReady && project.Spec.Redis.Mode != redisExternal {
		if redisWait, err = r.starting(ctx, project, builders.RedisSelector(project), redisWait.message); err != nil {
			return ctrl.Result{}, err
		}
		if redisWait.reason == reasonStarting {
			redisWait.reason = "NotReady"
		}
	}
	setCondition(&project.Status.Conditions, project.Generation, ConditionRedisReady, redisReady, redisWait.reason, redisWait.message)
	setCondition(&project.Status.Conditions, project.Generation, ConditionControllerReady, gc.ready, gc.reason, gc.message)
	setCondition(&project.Status.Conditions, project.Generation, ConditionEndpointReady,
		endpoint.ready, endpoint.reason, endpoint.message)
	setCondition(&project.Status.Conditions, project.Generation, ConditionReady,
		redisReady && gc.ready && endpoint.ready, "NotReady",
		"waiting for Redis, the global controller and the endpoint")
	if err := r.Status().Update(ctx, project); err != nil {
		return retryOnConflict(err)
	}
	log.V(1).Info("reconciled", "redisReady", redisReady, "controllerReady", gc.ready, "endpointReady", endpoint.ready)
	next, err := nextCheck(ctx, r.Client, project.Namespace, builders.EndpointSelector(project))
	if err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: next}, nil
}

// retryOnConflict turns a write made from a stale copy (someone, often Kubernetes
// itself, changed the object since it was read) into a quiet retry; anything else is
// a real error.
func retryOnConflict(err error) (ctrl.Result, error) {
	if apierrors.IsConflict(err) {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	return ctrl.Result{}, err
}

// partState is whether a part of the project (the global controller, the endpoint)
// runs, and why not when it doesn't.
type partState struct {
	ready           bool
	reason, message string
}

// reconcileGC runs the project's global controller once its Redis is ready: started
// earlier, it would only wait for Redis.
// redisLogin is the fingerprint of the project's Redis login, once Redis is ready.
func (r *CanyonProjectReconciler) redisLogin(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, redisReady bool,
) (string, error) {
	if !redisReady || r.RedisLogin == nil {
		return "", nil
	}
	return r.RedisLogin(ctx, project)
}

func (r *CanyonProjectReconciler) reconcileGC(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, redisReady bool, login string,
) (partState, error) {
	if !redisReady {
		return partState{reason: "WaitingForRedis", message: "starts once Redis is ready"}, nil
	}

	wantAccount := builders.GCServiceAccount(project)
	account := &corev1.ServiceAccount{ObjectMeta: objectMeta(wantAccount.ObjectMeta)}
	if err := r.ensure(ctx, project, account, func() { account.Labels = wantAccount.Labels }); err != nil {
		return partState{}, err
	}
	wantRole := builders.GCRole(project)
	role := &rbacv1.Role{ObjectMeta: objectMeta(wantRole.ObjectMeta)}
	if err := r.ensure(ctx, project, role, func() {
		role.Labels = wantRole.Labels
		role.Rules = wantRole.Rules
	}); err != nil {
		return partState{}, err
	}
	wantBinding := builders.GCRoleBinding(project)
	binding := &rbacv1.RoleBinding{ObjectMeta: objectMeta(wantBinding.ObjectMeta)}
	if err := r.ensure(ctx, project, binding, func() {
		binding.Labels = wantBinding.Labels
		binding.RoleRef = wantBinding.RoleRef // fixed after creation; always the same here
		binding.Subjects = wantBinding.Subjects
	}); err != nil {
		return partState{}, err
	}

	want := builders.GCDeployment(project, r.controllerImage(project), builders.EndpointURL(project))
	builders.StampRedisLogin(&want.Spec.Template, login)
	deployment := &appsv1.Deployment{ObjectMeta: objectMeta(want.ObjectMeta)}
	if err := r.ensure(ctx, project, deployment, func() {
		deployment.Labels = want.Labels
		deployment.Spec.Replicas = want.Spec.Replicas
		deployment.Spec.Strategy = want.Spec.Strategy
		deployment.Spec.Template = want.Spec.Template
		if deployment.CreationTimestamp.IsZero() {
			deployment.Spec.Selector = want.Spec.Selector // cannot change once created
		}
	}); err != nil {
		return partState{}, err
	}

	// The pod waits for its ConfigMap; say so instead of leaving it a mystery.
	err := r.APIReader.Get(ctx, client.ObjectKey{Namespace: project.Namespace, Name: project.Spec.ConfigRef},
		&corev1.ConfigMap{})
	if apierrors.IsNotFound(err) {
		return partState{reason: "ConfigMissing", message: fmt.Sprintf(
			"ConfigMap %q (spec.configRef) does not exist", project.Spec.ConfigRef)}, nil
	}
	if err != nil {
		return partState{}, err
	}
	if deployment.Status.AvailableReplicas < 1 {
		return r.starting(ctx, project, builders.GCSelector(project), "the global controller is starting")
	}
	return partState{ready: true}, nil
}

// reconcileEndpoint runs the endpoint once Redis is ready, and writes its replica
// and routing entry there, as for an agent.
func (r *CanyonProjectReconciler) reconcileEndpoint(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, redisReady bool, login string,
) (partState, error) {
	if !redisReady {
		return partState{reason: "WaitingForRedis", message: "starts once Redis is ready"}, nil
	}

	for _, wantService := range []*corev1.Service{
		builders.EndpointHeadlessService(project), builders.EndpointService(project),
	} {
		service := &corev1.Service{ObjectMeta: objectMeta(wantService.ObjectMeta)}
		if err := r.ensure(ctx, project, service, func() {
			service.Labels = wantService.Labels
			service.Spec.PublishNotReadyAddresses = wantService.Spec.PublishNotReadyAddresses
			service.Spec.Selector = wantService.Spec.Selector
			service.Spec.Ports = wantService.Spec.Ports
			if service.CreationTimestamp.IsZero() {
				service.Spec.ClusterIP = wantService.Spec.ClusterIP // cannot change once created
			}
		}); err != nil {
			return partState{}, err
		}
	}

	target := agentPods{
		name: builders.EndpointAgentName, workload: builders.EndpointWorkload,
		selector: builders.EndpointSelector(project),
	}
	if err := releaseLost(ctx, r.Client, project.Namespace, target.selector); err != nil {
		return partState{}, err
	}
	want := builders.EndpointStatefulSet(project, r.controllerImage(project))
	builders.StampRedisLogin(&want.Spec.Template, login)
	statefulSet := &appsv1.StatefulSet{}
	err := r.Get(ctx, client.ObjectKeyFromObject(want), statefulSet)
	if client.IgnoreNotFound(err) != nil {
		return partState{}, err
	}
	plan, err := planWorkload(ctx, r.Client, statefulSet, target, *want.Spec.Replicas)
	if err != nil {
		return partState{}, err
	}
	statefulSet = &appsv1.StatefulSet{ObjectMeta: objectMeta(want.ObjectMeta)}
	if err := r.ensure(ctx, project, statefulSet, func() {
		statefulSet.Labels = want.Labels
		if statefulSet.CreationTimestamp.IsZero() {
			statefulSet.Spec = want.Spec
			return
		}
		statefulSet.Spec.Replicas = &plan.replicas
		statefulSet.Spec.UpdateStrategy = want.Spec.UpdateStrategy
		statefulSet.Spec.Template = want.Spec.Template
	}); err != nil {
		return partState{}, err
	}
	if err := replaceNext(ctx, r.Client, plan); err != nil {
		return partState{}, err
	}

	if err := publishReplicas(ctx, r.Client, r.RedisFor, project, target, 1); err != nil {
		return partState{}, fmt.Errorf("writing the endpoint's replica to the project's Redis: %w", err)
	}

	if err := r.reconcileEndpointIngress(ctx, project); err != nil {
		return partState{}, err
	}

	project.Status.EndpointURL = builders.EndpointURL(project)
	if statefulSet.Status.ReadyReplicas < 1 {
		return r.starting(ctx, project, builders.EndpointSelector(project), "the endpoint is starting")
	}
	return partState{ready: true}, nil
}

// starting says why a part of the project is not ready yet: no node for its pod, or
// still starting.
func (r *CanyonProjectReconciler) starting(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, selector map[string]string, message string,
) (partState, error) {
	problem, err := unschedulable(ctx, r.Client, project.Namespace, selector)
	if err != nil || problem != "" {
		return partState{reason: reasonUnschedulable, message: problem}, err
	}
	return partState{reason: reasonStarting, message: message}, nil
}

// controllerImage is the canyonos-core image the project's own pods run: the
// project's mirror override, else the one matching this operator.
func (r *CanyonProjectReconciler) controllerImage(project *canyonosv1alpha1.CanyonProject) string {
	if project.Spec.ControllerImage != "" {
		return project.Spec.ControllerImage
	}
	return r.ControllerImage
}

// reconcileEndpointIngress creates the endpoint's Ingress when the project asks for
// one, and removes the one it created when the project no longer does.
func (r *CanyonProjectReconciler) reconcileEndpointIngress(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) error {
	if project.Spec.Endpoint.Ingress == nil {
		// Only the one it made: someone else's Ingress of that name is not ours.
		return deleteControlled(ctx, r.Client, project, &networkingv1.Ingress{}, builders.EndpointName)
	}

	want := builders.EndpointIngress(project)
	ingress := &networkingv1.Ingress{ObjectMeta: objectMeta(want.ObjectMeta)}
	return r.ensure(ctx, project, ingress, func() {
		ingress.Labels = want.Labels
		ingress.Annotations = want.Annotations
		ingress.Spec = want.Spec
	})
}

// endpointOfPod wakes the project whose endpoint a pod is, so the endpoint turning
// ready or stopping reaches routing at once.
func (r *CanyonProjectReconciler) endpointOfPod(_ context.Context, obj client.Object) []reconcile.Request {
	labels := obj.GetLabels()
	if labels[builders.LabelName] != builders.EndpointWorkload || labels[builders.LabelProject] == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{
		Namespace: obj.GetNamespace(), Name: labels[builders.LabelProject],
	}}}
}

// reconcileRedis returns whether the project's Redis is ready to use.
func (r *CanyonProjectReconciler) reconcileRedis(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) (bool, error) {
	if project.Spec.Redis.Mode == redisExternal {
		// Nothing to run: the customer's Redis, reached at the address they gave.
		project.Status.RedisAddress = fmt.Sprintf(
			"%s:%d", project.Spec.Redis.Host, project.Spec.Redis.Port,
		)
		return true, nil
	}

	secret, err := r.ensureRedisSecret(ctx, project)
	if err != nil {
		return false, err
	}
	want := builders.RedisStatefulSet(project, r.RedisImage, builders.SecretVersion(secret))
	statefulSet := &appsv1.StatefulSet{ObjectMeta: objectMeta(want.ObjectMeta)}
	if err := r.ensure(ctx, project, statefulSet, func() {
		statefulSet.Labels = want.Labels
		if statefulSet.CreationTimestamp.IsZero() {
			statefulSet.Spec = want.Spec
			return
		}
		// The selector and volume claims cannot change once created.
		statefulSet.Spec.Replicas = want.Spec.Replicas
		statefulSet.Spec.Template = want.Spec.Template
		statefulSet.Spec.PersistentVolumeClaimRetentionPolicy = want.Spec.PersistentVolumeClaimRetentionPolicy
	}); err != nil {
		return false, err
	}

	wantService := builders.RedisService(project)
	service := &corev1.Service{ObjectMeta: objectMeta(wantService.ObjectMeta)}
	if err := r.ensure(ctx, project, service, func() {
		service.Labels = wantService.Labels
		service.Spec.Selector = wantService.Spec.Selector
		service.Spec.Ports = wantService.Spec.Ports
	}); err != nil {
		return false, err
	}

	wantPolicy := builders.RedisNetworkPolicy(project, r.OperatorNamespace)
	policy := &networkingv1.NetworkPolicy{ObjectMeta: objectMeta(wantPolicy.ObjectMeta)}
	if err := r.ensure(ctx, project, policy, func() {
		policy.Labels = wantPolicy.Labels
		policy.Spec = wantPolicy.Spec
	}); err != nil {
		return false, err
	}

	project.Status.RedisAddress = builders.RedisAddress(project)
	return statefulSet.Status.ReadyReplicas >= 1, nil
}

// ensureRedisSecret returns the project's Redis Secret, creating it with a new
// random password the first time. An existing password is never replaced; deleting
// the Secret rotates it, and the config hash then rolls Redis.
func (r *CanyonProjectReconciler) ensureRedisSecret(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) (*corev1.Secret, error) {
	secret := &corev1.Secret{}
	key := client.ObjectKey{Namespace: project.Namespace, Name: builders.RedisName}
	err := r.APIReader.Get(ctx, key, secret)
	if err == nil {
		return secret, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}

	password, err := randomPassword()
	if err != nil {
		return nil, err
	}
	secret = builders.RedisSecret(project, password)
	if err := controllerutil.SetControllerReference(project, secret, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Create(ctx, secret); err != nil {
		return nil, err
	}
	return secret, nil
}

// ensure creates obj or brings it in line with `desired`, owned by the project.
func (r *CanyonProjectReconciler) ensure(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject, obj client.Object, desired func(),
) error {
	return ensureOwned(ctx, r.Client, r.Scheme, project, obj, desired)
}

// ensureOwned creates obj or brings it in line with `desired`, controlled by owner,
// so Kubernetes removes it with its owner. An object of that name that CanyonOS did
// not create is the customer's: it is never adopted or changed.
func ensureOwned(
	ctx context.Context, c client.Client, scheme *runtime.Scheme, owner, obj client.Object, desired func(),
) error {
	_, err := controllerutil.CreateOrUpdate(ctx, c, obj, func() error {
		if created := obj.GetCreationTimestamp(); !created.IsZero() && !metav1.IsControlledBy(obj, owner) {
			return fmt.Errorf("%s %q already exists and is not managed by CanyonOS; rename or remove it",
				obj.GetObjectKind().GroupVersionKind().Kind, obj.GetName())
		}
		desired()
		return controllerutil.SetControllerReference(owner, obj, scheme)
	})
	return err
}

// SetupWithManager reconciles a project when it changes, when anything it owns
// changes (a deleted Service is put back; Redis turning ready updates the status),
// and when its endpoint's pod does.
// Secrets are not watched: that would cache every Secret the operator can see.
func (r *CanyonProjectReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&canyonosv1alpha1.CanyonProject{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&networkingv1.Ingress{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&rbacv1.Role{}).
		Owns(&rbacv1.RoleBinding{}).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.endpointOfPod)).
		Named("canyonproject").
		Complete(r)
}

// setCondition records one condition: True/Ready, or False with why not.
func setCondition(
	conditions *[]metav1.Condition, generation int64, kind string, ok bool, reason, message string,
) {
	condition := metav1.Condition{
		Type:               kind,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: generation,
	}
	if ok {
		condition.Status = metav1.ConditionTrue
		condition.Reason = "Ready"
		condition.Message = ""
	}
	meta.SetStatusCondition(conditions, condition)
}

func objectMeta(from metav1.ObjectMeta) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: from.Name, Namespace: from.Namespace}
}

func randomPassword() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
