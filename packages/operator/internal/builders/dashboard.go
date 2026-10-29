/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"fmt"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The cluster's dashboard, as the operator's Helm chart installs it.
const (
	DashboardAPIName = "canyonos-dashboard-api"
	DashboardAPIPort = 3000
)

// DashboardOTLPEndpoint is where a project's global controller sends its telemetry,
// for the dashboard in namespace.
func DashboardOTLPEndpoint(namespace string) string {
	return fmt.Sprintf("http://%s.%s.svc:%d", DashboardAPIName, namespace, DashboardAPIPort)
}

// dashboardAPIPeer is the dashboard's API pod, the one dashboard pod that reads a
// project's Redis.
func dashboardAPIPeer(namespace string) networkingv1.NetworkPolicyPeer {
	peer := namespacePeer(namespace)
	peer.PodSelector = &metav1.LabelSelector{MatchLabels: map[string]string{LabelName: DashboardAPIName}}
	return peer
}
