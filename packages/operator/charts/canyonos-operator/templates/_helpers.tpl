{{/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/}}

{{- define "canyonos.labels" -}}
app.kubernetes.io/name: canyonos-operator
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "canyonos.selector" -}}
app.kubernetes.io/name: canyonos-operator
app.kubernetes.io/instance: {{ .Release.Name }}
control-plane: controller-manager
{{- end }}

{{/* Where CanyonOS's own images come from; empty would render "/canyonos-core:x" unnoticed. */}}
{{- define "canyonos.imageRegistry" -}}
{{ required "imageRegistry is required: the registry CanyonOS's images come from, such as ghcr.io/canyoncodecoreai" .Values.imageRegistry | trimSuffix "/" }}
{{- end }}

{{- define "canyonos.image" -}}
{{- $repository := .Values.image.repository | default (printf "%s/canyonos-operator" (include "canyonos.imageRegistry" .)) -}}
{{- if .Values.image.digest -}}
{{ $repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ $repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end }}

{{/* A CanyonOS image of this chart's release: (list . "core") is canyonos-core. */}}
{{- define "canyonos.releaseImage" -}}
{{- $root := index . 0 -}}
{{ include "canyonos.imageRegistry" $root }}/canyonos-{{ index . 1 }}:{{ $root.Chart.AppVersion }}
{{- end }}
