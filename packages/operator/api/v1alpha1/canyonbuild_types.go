/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// CanyonBuildSpec asks the operator to build a project's images in the cluster from
// the project the CLI uploads, push them, and apply the project's Kubernetes objects
// from its config.
type CanyonBuildSpec struct {
	// project is the project's name: its CanyonProject's, and its images' prefix.
	// +kubebuilder:validation:MinLength=1
	// +required
	Project string `json:"project"`

	// config is the path of global_controller.yaml in the upload.
	// +kubebuilder:validation:MinLength=1
	// +required
	Config string `json:"config"`

	// registry the images are pushed to, as the cluster's nodes pull from it.
	// +kubebuilder:validation:MinLength=1
	// +required
	Registry string `json:"registry"`

	// tag of the pushed images; pods run them by digest.
	// +kubebuilder:validation:MinLength=1
	// +required
	Tag string `json:"tag"`

	// platform the images are built for; empty builds for the architecture of the node
	// the build runs on, which on a cluster of one architecture is every node's.
	// +kubebuilder:validation:Enum=linux/amd64;linux/arm64
	// +optional
	Platform string `json:"platform,omitempty"`

	// image is the canyonos-core image that builds; the operator's matching one by
	// default. The project then runs it too.
	// +optional
	Image string `json:"image,omitempty"`

	// envSecretRef names the Secret with the project's .env, so ${VAR} in its config
	// resolve during the build. Never baked into an image.
	// +optional
	EnvSecretRef string `json:"envSecretRef,omitempty"`

	// registrySecretRef names a docker-registry Secret to push with, for a registry
	// that needs signing in.
	// +optional
	RegistrySecretRef string `json:"registrySecretRef,omitempty"`

	// imagePullSecrets to pull the core image with.
	// +optional
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`
}

// CanyonBuildStatus is how far the build got.
type CanyonBuildStatus struct {
	// phase: Pending, Receiving (upload the project now), Building, Succeeded or Failed.
	// +optional
	Phase string `json:"phase,omitempty"`

	// podName is the build's pod, which takes the upload on its port 8090.
	// +optional
	PodName string `json:"podName,omitempty"`

	// images are the pushed images by agent, pinned by digest.
	// +optional
	Images map[string]string `json:"images,omitempty"`

	// message says why the build failed, or what it is waiting for.
	// +optional
	Message string `json:"message,omitempty"`

	// operatorVersion is the CanyonOS release of the operator that runs the build (and
	// the project's pods), for the CLI to check it is the same as its own.
	// +optional
	OperatorVersion string `json:"operatorVersion,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=cbuild
// +kubebuilder:printcolumn:name="Project",type=string,JSONPath=`.spec.project`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// CanyonBuild is one in-cluster build of a CanyonOS project's images.
type CanyonBuild struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the build
	// +required
	Spec CanyonBuildSpec `json:"spec"`

	// status is how far it got
	// +optional
	Status CanyonBuildStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// CanyonBuildList contains a list of CanyonBuild
type CanyonBuildList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []CanyonBuild `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &CanyonBuild{}, &CanyonBuildList{})
		return nil
	})
}
