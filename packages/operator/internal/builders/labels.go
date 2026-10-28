/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

// Package builders describes every object the operator creates as a pure function
// of its custom resource, so what gets created is easy to read and to test.
package builders

import (
	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	// ManagedBy marks every pod the operator runs; the global controller lists a
	// project's pods by it for machine metrics.
	ManagedBy = "canyonos-operator"

	LabelName      = "app.kubernetes.io/name"
	LabelManagedBy = "app.kubernetes.io/managed-by"
	LabelPartOf    = "app.kubernetes.io/part-of"
	// LabelProject marks a project's pods; its Redis admits only pods carrying it.
	LabelProject = "canyonos.canyoncode.ai/project"
)

// Names shared by the pods the operator runs.
const (
	portGRPC      = "grpc"
	portHealth    = "health"
	volumeTmp     = "tmp"
	envHealthPort = "CANYONOS_HEALTH_PORT"
	envHome       = "HOME"
	// dropAll drops every Linux capability (the restricted profile).
	dropAll = "ALL"
	// pythonCommand runs core's entry points in the canyonos-core image.
	pythonCommand = "python"
	verbGet       = "get"
	verbPatch     = "patch"
)

// TypeDatabase is an agent running a stock database image rather than its own code.
const TypeDatabase = "database"

// ProjectLabels are the labels of an object named `name` belonging to project p.
func ProjectLabels(p *canyonosv1alpha1.CanyonProject, name string) map[string]string {
	return map[string]string{
		LabelName:      name,
		LabelManagedBy: ManagedBy,
		LabelPartOf:    "canyonos",
		LabelProject:   p.Name,
	}
}
