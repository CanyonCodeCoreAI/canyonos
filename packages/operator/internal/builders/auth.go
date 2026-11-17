/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"encoding/json"

	corev1 "k8s.io/api/core/v1"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

// The variables core reads the trusted keys from (canyonos_core/auth.py).
const (
	envTrustedKeys  = "CANYONOS_TRUSTED_KEYS"
	envAuthDisabled = "CANYONOS_AUTH_DISABLED"
)

// authEnv hands a CanyonOS process spec.auth: the trusted keys as a JSON list and, when
// verification is off, CANYONOS_AUTH_DISABLED=true. Without spec.auth it sets neither,
// so a resource an older CLI wrote never reads as verification off.
func authEnv(auth *canyonosv1alpha1.AuthSpec) []corev1.EnvVar {
	if auth == nil {
		return nil
	}
	keys := auth.TrustedKeys
	if keys == nil {
		keys = []string{}
	}
	encoded, _ := json.Marshal(keys) // a list of strings always encodes
	env := []corev1.EnvVar{{Name: envTrustedKeys, Value: string(encoded)}}
	if auth.Disabled {
		env = append(env, corev1.EnvVar{Name: envAuthDisabled, Value: "true"})
	}
	return env
}
