/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

// databaseVolume is the disk a database keeps its data on.
const databaseVolume = "data"

// IsDatabase says whether a CanyonAgent runs a stock database image rather than an
// agent.
func IsDatabase(agent *canyonosv1alpha1.CanyonAgent) bool {
	return agent.Spec.Type == TypeDatabase && agent.Spec.Database != nil
}

// ReplicaPort is where an agent's replicas take connections: the database's own
// port, or every agent's LocalController port.
func ReplicaPort(agent *canyonosv1alpha1.CanyonAgent) int32 {
	if IsDatabase(agent) {
		return agent.Spec.Database.Port
	}
	return AgentPort
}

// DatabaseStatefulSet runs a database agent's stock image as one replica on its own
// disk at mountPath, as Docker runs it on a named volume: the disk outlives the pod,
// a redeploy and the CanyonAgent (Retain), so data survives as it does on Docker.
// Updated by stopping the old pod first: a second one would have a disk of its own.
// No CanyonOS environment, no API token; the user IDs the image expects come from
// the spec (postgres: 70), which the restricted profile needs to be non-root.
func DatabaseStatefulSet(p *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent) *appsv1.StatefulSet {
	db := agent.Spec.Database
	labels := agentLabels(p, agent)
	storage := resource.MustParse("1Gi")
	if db.Storage != nil {
		storage = *db.Storage
	}
	probe := &corev1.Probe{
		ProbeHandler:  corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(db.Port)}},
		PeriodSeconds: 5, FailureThreshold: 3, TimeoutSeconds: 3,
	}

	pod := corev1.PodSpec{
		ServiceAccountName:            p.Spec.AgentServiceAccountName,
		AutomountServiceAccountToken:  new(false),
		ImagePullSecrets:              p.Spec.ImagePullSecrets,
		TerminationGracePeriodSeconds: agent.Spec.TerminationGracePeriodSeconds,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      db.RunAsUser,
			RunAsGroup:     db.RunAsUser,
			FSGroup:        db.FSGroup,
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:           "database",
			Image:          agent.Spec.Image,
			Env:            agent.Spec.Env,
			Ports:          []corev1.ContainerPort{{Name: "database", ContainerPort: db.Port}},
			ReadinessProbe: probe,
			StartupProbe:   &corev1.Probe{ProbeHandler: probe.ProbeHandler, PeriodSeconds: 5, FailureThreshold: 60},
			Resources:      agent.Spec.Resources,
			VolumeMounts:   []corev1.VolumeMount{{Name: databaseVolume, MountPath: db.MountPath}},
			// A stock image writes where it likes (its run and socket folders); not a
			// read-only root. Everything else of the restricted profile applies.
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: new(false),
				Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{dropAll}},
			},
		}},
	}
	applyPlacement(&pod, agent.Spec.Placement)

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: agent.Name, Namespace: agent.Namespace, Labels: labels},
		Spec: appsv1.StatefulSetSpec{
			ServiceName:    agent.Name,
			Replicas:       new(int32(1)),
			Selector:       &metav1.LabelSelector{MatchLabels: AgentSelector(agent)},
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.RollingUpdateStatefulSetStrategyType},
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: pod},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{{
				ObjectMeta: metav1.ObjectMeta{Name: databaseVolume, Labels: labels},
				Spec: corev1.PersistentVolumeClaimSpec{
					AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
					StorageClassName: db.StorageClassName,
					Resources: corev1.VolumeResourceRequirements{
						Requests: corev1.ResourceList{corev1.ResourceStorage: storage},
					},
				},
			}},
		},
	}
}
