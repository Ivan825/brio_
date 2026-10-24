{{- define "brio.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "brio.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "brio.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "brio.image" -}}
{{- $reg := .root.Values.image.registry -}}
{{- if $reg -}}{{ printf "%s/%s:%s" $reg .name .root.Values.image.tag }}{{- else -}}{{ printf "%s:%s" .name .root.Values.image.tag }}{{- end -}}
{{- end -}}

{{- define "brio.secretName" -}}
{{- if .Values.existingSecret -}}{{ .Values.existingSecret }}{{- else -}}{{ include "brio.fullname" . }}{{- end -}}
{{- end -}}

{{/* Environment shared by the API, the runner and the migration Job. */}}
{{- define "brio.env" -}}
- name: NODE_ENV
  value: production
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range $k := list "DATABASE_URL" "BETTER_AUTH_SECRET" "BRIO_VAULT_LOCAL_KEK" "RESEND_API_KEY" "BRIO_SMTP_PASSWORD" "GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_SECRET" "BRIO_VAPID_PUBLIC_KEY" "BRIO_VAPID_PRIVATE_KEY" }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef:
      name: {{ include "brio.secretName" $ }}
      key: {{ $k }}
      optional: {{ has $k (list "DATABASE_URL" "BETTER_AUTH_SECRET") | not }}
{{- end }}
{{- end -}}
