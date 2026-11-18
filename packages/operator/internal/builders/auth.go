/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	// EnvAPIKeyHash is the variable core reads the API key's hash from
	// (canyonos_core/auth.py); empty or unset, the endpoint answers anyone.
	EnvAPIKeyHash = "CANYONOS_API_KEY_HASH"
	// APIKeyName is the project's Secret holding spec.auth.apiKeyHash for its global
	// controller, under APIKeyHashKey; empty when the project has no key.
	APIKeyName    = "canyonos-api-key"
	APIKeyHashKey = "hash"
	// APIKeyAnnotation on the global controller's pod template is the SecretVersion of
	// that Secret: its environment holds the hash, so a new key must restart it.
	APIKeyAnnotation = "canyonos.canyoncode.ai/api-key"
)

// APIKeyHash is the hash of the API key a CanyonOS process verifies, "" for none.
func APIKeyHash(auth *canyonosv1alpha1.AuthSpec) string {
	if auth == nil {
		return ""
	}
	return auth.APIKeyHash
}

// APIKeySecret holds the project's API key hash, which its global controller reads
// from here rather than from its pod spec.
func APIKeySecret(p *canyonosv1alpha1.CanyonProject) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      APIKeyName,
			Namespace: p.Namespace,
			Labels:    ProjectLabels(p, APIKeyName),
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{APIKeyHashKey: []byte(APIKeyHash(p.Spec.Auth))},
	}
}

// StampAPIKey marks a pod template with the SecretVersion of the API key Secret its
// pods read (APIKeyAnnotation); nothing when version is empty.
func StampAPIKey(template *corev1.PodTemplateSpec, version string) {
	if version == "" {
		return
	}
	if template.Annotations == nil {
		template.Annotations = map[string]string{}
	}
	template.Annotations[APIKeyAnnotation] = version
}
