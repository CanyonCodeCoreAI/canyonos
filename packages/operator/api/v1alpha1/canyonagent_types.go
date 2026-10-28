/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DatabaseSpec is how a `database` agent stores its data, as the stock image
// (postgres, for example) expects.
type DatabaseSpec struct {
	// port the database listens on.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +required
	Port int32 `json:"port"`

	// storage is the size of the database's disk.
	// +kubebuilder:default="1Gi"
	// +optional
	Storage *resource.Quantity `json:"storage,omitempty"`

	// storageClassName picks the disk type; empty uses the cluster's default.
	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`

	// mountPath is where the image keeps its data.
	// +kubebuilder:validation:MinLength=1
	// +required
	MountPath string `json:"mountPath"`

	// runAsUser and fsGroup run the image as the user it expects (postgres: 70).
	// +optional
	RunAsUser *int64 `json:"runAsUser,omitempty"`
	// +optional
	FSGroup *int64 `json:"fsGroup,omitempty"`
}

// CanyonAgentSpec is one agent of a project: one built from its code (its own
// image, with a LocalController) or a database (a stock image).
// +kubebuilder:validation:XValidation:rule="(has(self.type) && self.type == \"database\") == has(self.database)",message="spec.database is set for, and only for, type database"
type CanyonAgentSpec struct {
	// projectRef names the CanyonProject, in this namespace, the agent belongs to.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="projectRef cannot change"
	// +required
	ProjectRef string `json:"projectRef"`

	// agentName is the agent's name in the project's config (HelloAgent);
	// requests are routed by it. The object's own name is its DNS form (helloagent).
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="agentName cannot change"
	// +required
	AgentName string `json:"agentName"`

	// type is agent or database.
	// +kubebuilder:validation:Enum=agent;database
	// +kubebuilder:default=agent
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="type cannot change"
	// +optional
	Type string `json:"type,omitempty"`

	// image runs the agent; agent images are named by digest, so an unchanged
	// agent keeps its pods.
	// +kubebuilder:validation:MinLength=1
	// +required
	Image string `json:"image"`

	// replicas is how many pods run the agent. The CLI sets it from the config and
	// the global controller changes it through /scale; nothing else writes it.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:default=1
	// +optional
	Replicas *int32 `json:"replicas,omitempty"`

	// stateful keeps each conversation on one replica (sticky routing).
	// +optional
	Stateful bool `json:"stateful,omitempty"`

	// resources are the agent's CPU and memory requests and limits.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// env adds environment variables to the agent.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// terminationGracePeriodSeconds is how long a stopping replica may finish the
	// calls it accepted before it is killed.
	// +kubebuilder:validation:Minimum=20
	// +kubebuilder:validation:Maximum=3600
	// +kubebuilder:default=120
	// +optional
	TerminationGracePeriodSeconds *int64 `json:"terminationGracePeriodSeconds,omitempty"`

	// database is how a database agent stores its data.
	// +optional
	Database *DatabaseSpec `json:"database,omitempty"`

	// placement says where the agent's pods may run.
	// +optional
	Placement *Placement `json:"placement,omitempty"`
}

// CanyonAgentStatus is what the operator last observed of the agent.
type CanyonAgentStatus struct {
	// replicas is how many pods exist; /scale reads it.
	// +optional
	Replicas int32 `json:"replicas,omitempty"`

	// readyReplicas is how many pods are ready.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// selector selects the agent's pods, for /scale.
	// +optional
	Selector string `json:"selector,omitempty"`

	// endpoints are the replicas requests are routed to (host:port).
	// +listType=atomic
	// +optional
	Endpoints []string `json:"endpoints,omitempty"`

	// conditions: Ready, Routed.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// observedGeneration is the spec generation the status describes.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.replicas,selectorpath=.status.selector
// +kubebuilder:resource:shortName=cagent
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentName`
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`
// +kubebuilder:printcolumn:name="Desired",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// CanyonAgent is one agent of a CanyonOS project, run as a StatefulSet.
type CanyonAgent struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of CanyonAgent
	// +required
	Spec CanyonAgentSpec `json:"spec"`

	// status defines the observed state of CanyonAgent
	// +optional
	Status CanyonAgentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// CanyonAgentList contains a list of CanyonAgent
type CanyonAgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []CanyonAgent `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &CanyonAgent{}, &CanyonAgentList{})
		return nil
	})
}
