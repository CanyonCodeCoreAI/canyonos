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

{{- define "canyonos.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end }}
