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

{{/* A pod's labels: (list . (dict ...)) is its own, then podLabels, which never replace
them (they select the pod). Each value a string, as Kubernetes wants. */}}
{{- define "canyonos.podLabels" -}}
{{- $root := index . 0 -}}
{{- $labels := merge (deepCopy (index . 1)) (deepCopy ($root.Values.podLabels | default dict)) -}}
{{- range $key, $value := $labels }}
{{ $key }}: {{ $value | toString | quote }}
{{- end }}
{{- end }}

{{/* A pod's registry logins and priority, its own or else the top-level ones, and where
it runs: (list . .Values.builder) for the builder's. Only what is set is written. */}}
{{- define "canyonos.podExtras" -}}
{{- $root := index . 0 -}}
{{- $own := index . 1 -}}
{{- with $own.imagePullSecrets | default $root.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $own.priorityClassName | default $root.Values.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- with $own.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $own.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $own.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* A dashboard container's CPU and memory: (list . "db"), one of db, api, core and web.
An upgrade with --reuse-values from a release before dashboard.resources keeps that
release's values, which have none: the sizes values.yaml gives then (the Operator
workflow checks the two agree). */}}
{{- define "canyonos.dashboardResources" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $sizes := dict
  "db" (dict "requests" (dict "cpu" "50m" "memory" "128Mi") "limits" (dict "memory" "512Mi"))
  "api" (dict "requests" (dict "cpu" "50m" "memory" "256Mi") "limits" (dict "memory" "1Gi"))
  "core" (dict "requests" (dict "cpu" "50m" "memory" "128Mi") "limits" (dict "memory" "1Gi"))
  "web" (dict "requests" (dict "cpu" "10m" "memory" "32Mi") "limits" (dict "memory" "128Mi")) -}}
{{- toYaml (dig "resources" $name (index $sizes $name) ($root.Values.dashboard | default dict)) -}}
{{- end }}
