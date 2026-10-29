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

// RedisSpec says which Redis the project's replicas and global controller share.
// +kubebuilder:validation:XValidation:rule="!has(self.mode) || self.mode != \"external\" || (has(self.host) && size(self.host) > 0)",message="an external Redis needs a host"
type RedisSpec struct {
	// mode is internal (the operator runs Redis in the project's namespace) or
	// external (a Redis the cluster already has, such as ElastiCache).
	// +kubebuilder:validation:Enum=internal;external
	// +kubebuilder:default=internal
	// +optional
	Mode string `json:"mode,omitempty"`

	// storage is the size of an internal Redis's disk.
	// +kubebuilder:default="1Gi"
	// +optional
	Storage *resource.Quantity `json:"storage,omitempty"`

	// storageClassName picks the disk type of an internal Redis; empty uses the
	// cluster's default class.
	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`

	// host of an external Redis.
	// +optional
	Host string `json:"host,omitempty"`

	// port of an external Redis.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +kubebuilder:default=6379
	// +optional
	Port int32 `json:"port,omitempty"`

	// tls connects to an external Redis over TLS.
	// +optional
	TLS bool `json:"tls,omitempty"`

	// passwordSecretRef names a Secret in the namespace whose `password` key
	// (and optional `username` key) logs in to an external Redis. An internal
	// Redis always gets a password the operator generates.
	// +optional
	PasswordSecretRef string `json:"passwordSecretRef,omitempty"`
}

// EndpointSpec is the agent method the project serves over HTTP.
type EndpointSpec struct {
	// agent is the name of the agent whose method the endpoint serves, as in the
	// project's config (for example Workflow).
	// +kubebuilder:validation:MinLength=1
	// +required
	Agent string `json:"agent"`

	// method is the agent function served at POST /<method>.
	// +kubebuilder:validation:MinLength=1
	// +required
	Method string `json:"method"`

	// arguments are the method's argument names, which the endpoint reads from a
	// request's JSON body.
	// +listType=atomic
	// +optional
	Arguments []string `json:"arguments,omitempty"`

	// resources of the endpoint's pod; by default it requests 250m CPU and 256Mi
	// and may use up to 1Gi of memory.
	// +optional
	Resources *corev1.ResourceRequirements `json:"resources,omitempty"`

	// ingress exposes the endpoint outside the cluster through an Ingress of the
	// cluster's own ingress class. On OpenShift the router serves it as a Route.
	// Without it the endpoint is reachable inside the cluster only.
	// +optional
	Ingress *EndpointIngress `json:"ingress,omitempty"`

	// url is where callers reach the endpoint, when it is exposed some other way
	// (Gateway API, a service mesh, a Route made by hand) or its Ingress is served
	// at another address (TLS terminated by the router). Published as given; the
	// operator creates nothing for it.
	// +kubebuilder:validation:Pattern=`^https?://[^\s/?#]+(/[^\s?#]*)?$`
	// +optional
	URL string `json:"url,omitempty"`
}

// EndpointIngress is the Ingress the operator creates for the endpoint, served at
// http(s)://<host>/<method>.
type EndpointIngress struct {
	// host callers use, which the cluster's DNS and ingress controller must serve.
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	// +kubebuilder:validation:MaxLength=253
	// +required
	Host string `json:"host"`

	// className is the IngressClass to use; empty uses the cluster's default class.
	// +optional
	ClassName *string `json:"className,omitempty"`

	// tlsSecretName names a Secret in the namespace holding the host's certificate;
	// with it the endpoint is served over https.
	// +optional
	TLSSecretName string `json:"tlsSecretName,omitempty"`

	// annotations for the Ingress, for the ingress controller in use (for example
	// alb.ingress.kubernetes.io/scheme or route.openshift.io/termination).
	// +optional
	Annotations map[string]string `json:"annotations,omitempty"`
}

// Placement says where the project's own pods (Redis, global controller,
// endpoint) may run. Agents carry their own placement.
type Placement struct {
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	// +optional
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`
	// +optional
	Affinity *corev1.Affinity `json:"affinity,omitempty"`
}

// CanyonProjectSpec is one CanyonOS project, which runs in its own namespace.
type CanyonProjectSpec struct {
	// projectID names the project in telemetry and the dashboard. The CLI writes
	// it into the project's config once; it never changes.
	// +kubebuilder:validation:Pattern=`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="projectID cannot change"
	// +required
	ProjectID string `json:"projectID"`

	// displayName is the name the dashboard shows.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// configRef names the ConfigMap holding the project's config/*.yaml files.
	// +kubebuilder:validation:MinLength=1
	// +required
	ConfigRef string `json:"configRef"`

	// envSecretRef names the Secret holding the project's environment (API keys
	// from its .env), given to the global controller and every agent.
	// +optional
	EnvSecretRef string `json:"envSecretRef,omitempty"`

	// endpoint is the agent method served over HTTP.
	// +required
	Endpoint EndpointSpec `json:"endpoint"`

	// redis is the Redis the project's replicas and global controller share.
	// +kubebuilder:default={}
	// +optional
	Redis RedisSpec `json:"redis,omitzero"`

	// controllerImage overrides the canyonos-core image (global controller,
	// endpoint, builds), for a registry mirror; by default the operator uses the
	// image matching its own version.
	// +optional
	ControllerImage string `json:"controllerImage,omitempty"`

	// imagePullSecrets pull the project's images from a private registry.
	// +optional
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`

	// agentServiceAccountName runs the agents as an existing ServiceAccount, for
	// cloud credentials such as EKS Pod Identity. Empty: a ServiceAccount with no
	// Kubernetes API access.
	// +optional
	AgentServiceAccountName string `json:"agentServiceAccountName,omitempty"`

	// placement says where the project's own pods may run.
	// +optional
	Placement *Placement `json:"placement,omitempty"`

	// pollIntervalSeconds is how often replicas report and the global controller
	// polls (the config's poll_interval).
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=3600
	// +kubebuilder:default=5
	// +optional
	PollIntervalSeconds int32 `json:"pollIntervalSeconds,omitempty"`

	// logs streams failure and log detail into each future (the config's logs).
	// +kubebuilder:default=true
	// +optional
	Logs *bool `json:"logs,omitempty"`
}

// CanyonProjectStatus is what the operator last observed of the project.
type CanyonProjectStatus struct {
	// conditions: Ready, RedisReady, ControllerReady, EndpointReady.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// redisAddress is host:port of the project's Redis.
	// +optional
	RedisAddress string `json:"redisAddress,omitempty"`

	// endpointURL is where callers reach the endpoint.
	// +optional
	EndpointURL string `json:"endpointURL,omitempty"`

	// observedGeneration is the spec generation the status describes.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=cproj
// +kubebuilder:printcolumn:name="Project ID",type=string,JSONPath=`.spec.projectID`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.status.endpointURL`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// CanyonProject is one CanyonOS project: its Redis, global controller and endpoint.
type CanyonProject struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of CanyonProject
	// +required
	Spec CanyonProjectSpec `json:"spec"`

	// status defines the observed state of CanyonProject
	// +optional
	Status CanyonProjectStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// CanyonProjectList contains a list of CanyonProject
type CanyonProjectList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []CanyonProject `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &CanyonProject{}, &CanyonProjectList{})
		return nil
	})
}
