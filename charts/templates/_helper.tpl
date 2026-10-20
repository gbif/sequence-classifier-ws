{{/*
Functions that create an single arg list that can be passed to vsearch
*/}}
{{- define "helpers.argsStringifier" -}}
{{- $tempString := "" }}
{{- range $k, $v := . }}
  {{- if kindIs "float64" $v }}
    {{- $tempString = (printf "%s --%s %s" $tempString $k (regexReplaceAll "(\\.\\d*?)0+" ($v | toString) "${1}" | trimSuffix ".")) }}
  {{- else if kindIs "string" $v }}
    {{- $tempString = (printf "%s --%s %s" $tempString $k $v) }}
  {{- end }}
{{- end }}
{{- printf "%s" $tempString }}
{{- end }}

{{/*
Expand the name of the chart.
*/}}
{{- define "helpers.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "helpers.releaseName" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "helpers.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "helpers.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "helpers.labels" -}}
helm.sh/chart: {{ include "helpers.chart" . }}
{{ include "helpers.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{ include "helpers.yunikornLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "helpers.commonLabels" -}}
helm.sh/chart: {{ include "helpers.chart" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "helpers.selectorLabels" -}}
app.kubernetes.io/name: {{ include "helpers.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "helpers.yunikornName" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 54 | trimSuffix "-" }}
{{- else }}
{{- .Values.appName | trunc 54 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Function to generate the image section for stackable objects
*/}}
{{- define "helpers.yunikornLabels" -}}
applicationId: {{ .Values.yunikorn.appId }}
queue: {{ .Values.yunikorn.queue }}
{{- end -}}