/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import corev1 "k8s.io/api/core/v1"

// UsePlatformUsers leaves a pod's user and group IDs to the platform instead of the
// ones CanyonOS's images expect: OpenShift's restricted-v2 runs each namespace's pods
// as a user ID from its own range, in group 0, and rejects pods that ask for others.
// The pod stays non-root, and what it writes is writable by group 0 (or is a disk the
// platform's fsGroup gives it).
func UsePlatformUsers(template *corev1.PodTemplateSpec) {
	if security := template.Spec.SecurityContext; security != nil {
		security.RunAsUser = nil
		security.RunAsGroup = nil
		security.FSGroup = nil
	}
}
