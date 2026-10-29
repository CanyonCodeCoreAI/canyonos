/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
)

const (
	// DashboardProjectsSecret lists the projects for the cluster's dashboard, which
	// mounts it as a file (CANYONOS_PROJECTS_FILE).
	DashboardProjectsSecret = "canyonos-dashboard-projects"
	// DashboardProjectsKey is the file in it.
	DashboardProjectsKey = "projects.json"
)

// DashboardRegistryReconciler keeps the dashboard's list of projects: one Secret in
// the dashboard's namespace naming each project whose Redis is ready, with how to
// reach it and sign in. The dashboard then needs no permission on any project's
// Secrets; the operator already reads each Redis password by name.
type DashboardRegistryReconciler struct {
	client.Client
	// APIReader reads the list's Secret straight from the API server: Secrets are never cached.
	APIReader client.Reader
	// Redis reads each project's Redis login, as its pods use it.
	Redis *ProjectRedis
	// Namespace is the dashboard's.
	Namespace string
}

type registeredRedis struct {
	Host     string `json:"host"`
	Port     int32  `json:"port"`
	TLS      bool   `json:"tls"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type registeredProject struct {
	ProjectID string          `json:"project_id"`
	Name      string          `json:"name"`
	Redis     registeredRedis `json:"redis"`
}

// Its permissions: get and create on Secrets come with the operator's ClusterRole; update
// on this one Secret, by name, from the chart's Role in the dashboard's namespace.

// Reconcile writes the list of every project the operator runs.
func (r *DashboardRegistryReconciler) Reconcile(ctx context.Context, _ ctrl.Request) (ctrl.Result, error) {
	projects := &canyonosv1alpha1.CanyonProjectList{}
	if err := r.List(ctx, projects); err != nil {
		return ctrl.Result{}, err
	}
	listed := []registeredProject{}
	// Listed again on a timer too, as the project and agent controllers resync: an
	// external Redis's password Secret can change with no event the triggers below see,
	// and a project left out (its password unreadable) is tried again.
	result := ctrl.Result{RequeueAfter: resyncPeriod}
	for i := range projects.Items {
		project := &projects.Items[i]
		if !listable(project) {
			continue
		}
		entry, err := r.entry(ctx, project)
		if err != nil {
			// One project's missing Secret must not drop every other project.
			logf.FromContext(ctx).Info("Not listing a project for the dashboard yet",
				"project", client.ObjectKeyFromObject(project), "reason", err.Error())
			continue
		}
		listed = append(listed, entry)
	}
	slices.SortFunc(listed, func(a, b registeredProject) int { return strings.Compare(a.ProjectID, b.ProjectID) })
	content, err := json.MarshalIndent(map[string]any{"projects": listed}, "", "  ")
	if err != nil {
		return ctrl.Result{}, err
	}
	return result, r.write(ctx, content)
}

// listable is a project the dashboard can reach: its Redis is ready and it is not
// being deleted.
func listable(project *canyonosv1alpha1.CanyonProject) bool {
	return project.DeletionTimestamp == nil &&
		meta.IsStatusConditionTrue(project.Status.Conditions, ConditionRedisReady)
}

// entry is one project as the dashboard reaches its Redis.
func (r *DashboardRegistryReconciler) entry(
	ctx context.Context, project *canyonosv1alpha1.CanyonProject,
) (registeredProject, error) {
	options, err := r.Redis.options(ctx, project)
	if err != nil {
		return registeredProject{}, err
	}
	host, port := builders.RedisHostPort(project)
	name := project.Spec.DisplayName
	if name == "" {
		name = project.Name
	}
	return registeredProject{
		ProjectID: project.Spec.ProjectID,
		Name:      name,
		Redis: registeredRedis{
			Host: host, Port: port, TLS: options.TLSConfig != nil,
			Username: options.Username, Password: options.Password,
		},
	}, nil
}

// write creates or replaces the dashboard's Secret, only when its content changes.
func (r *DashboardRegistryReconciler) write(ctx context.Context, content []byte) error {
	key := client.ObjectKey{Namespace: r.Namespace, Name: DashboardProjectsSecret}
	secret := &corev1.Secret{}
	err := r.APIReader.Get(ctx, key, secret)
	if apierrors.IsNotFound(err) {
		secret = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name: key.Name, Namespace: key.Namespace,
				Labels: map[string]string{builders.LabelManagedBy: builders.ManagedBy, builders.LabelPartOf: "canyonos"},
			},
			Data: map[string][]byte{DashboardProjectsKey: content},
		}
		return client.IgnoreAlreadyExists(r.Create(ctx, secret))
	}
	if err != nil {
		return err
	}
	if string(secret.Data[DashboardProjectsKey]) == string(content) {
		return nil
	}
	secret.Data = map[string][]byte{DashboardProjectsKey: content}
	return r.Update(ctx, secret)
}

// listChanged is a project update that can change its entry in the list. Status
// updates of replicas and endpoints, the most frequent, do not.
func listChanged(e event.TypedUpdateEvent[client.Object]) bool {
	old, oldOK := e.ObjectOld.(*canyonosv1alpha1.CanyonProject)
	updated, newOK := e.ObjectNew.(*canyonosv1alpha1.CanyonProject)
	if !oldOK || !newOK {
		return true
	}
	return listable(old) != listable(updated) ||
		old.Spec.ProjectID != updated.Spec.ProjectID ||
		old.Spec.DisplayName != updated.Spec.DisplayName ||
		!equality.Semantic.DeepEqual(old.Spec.Redis, updated.Spec.Redis)
}

// passwordRotated is a project's Redis rolling to a new password: its config-hash
// annotation (its Secret's version) changes, while the project itself stays ready
// throughout. An external Redis has no StatefulSet; the minute's resync picks up a
// password changed in the customer's Secret.
func passwordRotated(e event.TypedUpdateEvent[client.Object]) bool {
	old, oldOK := e.ObjectOld.(*appsv1.StatefulSet)
	updated, newOK := e.ObjectNew.(*appsv1.StatefulSet)
	if !oldOK || !newOK || updated.Name != builders.RedisName {
		return false
	}
	return old.Spec.Template.Annotations[builders.ConfigHashAnnotation] !=
		updated.Spec.Template.Annotations[builders.ConfigHashAnnotation]
}

// SetupWithManager lists the projects again whenever one is added, removed, or
// changes what the list says about it, and when a project's Redis password rotates.
func (r *DashboardRegistryReconciler) SetupWithManager(mgr ctrl.Manager) error {
	one := reconcile.Request{NamespacedName: types.NamespacedName{Namespace: r.Namespace, Name: DashboardProjectsSecret}}
	toList := handler.EnqueueRequestsFromMapFunc(
		func(context.Context, client.Object) []reconcile.Request { return []reconcile.Request{one} })
	return ctrl.NewControllerManagedBy(mgr).
		Named("dashboardregistry").
		Watches(&canyonosv1alpha1.CanyonProject{}, toList,
			builder.WithPredicates(predicate.Funcs{UpdateFunc: listChanged})).
		Watches(&appsv1.StatefulSet{}, toList, builder.WithPredicates(predicate.Funcs{
			CreateFunc:  func(event.CreateEvent) bool { return false },
			DeleteFunc:  func(event.DeleteEvent) bool { return false },
			GenericFunc: func(event.GenericEvent) bool { return false },
			UpdateFunc:  passwordRotated,
		})).
		Complete(r)
}
