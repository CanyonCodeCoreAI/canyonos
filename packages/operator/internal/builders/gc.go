/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	GCName = "canyonos-gc"
	// HealthPort serves /startupz, /readyz and /livez in every CanyonOS pod.
	HealthPort = 8099
	// GCUID runs the canyonos-core image, which defaults to root, as a non-root user;
	// group 0 keeps it writable on OpenShift's arbitrary UIDs.
	GCUID = 1001

	gcConfigPath = "/etc/canyonos/config"
	gcDataPath   = "/var/lib/canyonos"
	apiGroup     = "canyonos.canyoncode.ai"
)

// GCServiceAccount is the global controller's identity, the only CanyonOS pod with
// Kubernetes API access.
func GCServiceAccount(p *canyonosv1alpha1.CanyonProject) *corev1.ServiceAccount {
	return &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: GCName, Namespace: p.Namespace, Labels: ProjectLabels(p, GCName)},
	}
}

// GCRole is everything the global controller may do, in its own namespace only:
// change a CanyonAgent's replica count, and read its pods and their usage for
// machine metrics.
func GCRole(p *canyonosv1alpha1.CanyonProject) *rbacv1.Role {
	readOnly := []string{verbGet, "list"}
	return &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: GCName, Namespace: p.Namespace, Labels: ProjectLabels(p, GCName)},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{apiGroup}, Resources: []string{"canyonagents/scale"}, Verbs: []string{verbGet, verbPatch}},
			{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: readOnly},
			{APIGroups: []string{"metrics.k8s.io"}, Resources: []string{"pods"}, Verbs: readOnly},
		},
	}
}

// GCRoleBinding grants GCRole to the global controller's ServiceAccount.
func GCRoleBinding(p *canyonosv1alpha1.CanyonProject) *rbacv1.RoleBinding {
	return &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: GCName, Namespace: p.Namespace, Labels: ProjectLabels(p, GCName)},
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: GCName},
		Subjects: []rbacv1.Subject{
			{Kind: rbacv1.ServiceAccountKind, Name: GCName, Namespace: p.Namespace},
		},
	}
}

// GCSelector selects the project's global controller pod.
func GCSelector(p *canyonosv1alpha1.CanyonProject) map[string]string {
	return map[string]string{LabelName: GCName, LabelProject: p.Name}
}

// GCDeployment runs `run-gc` from the canyonos-core image. Recreate: two global
// controllers at once would scale, clean up and export telemetry twice.
// dashboardNamespace is the cluster dashboard's, empty for none.
func GCDeployment(p *canyonosv1alpha1.CanyonProject, image, endpointURL, dashboardNamespace string) *appsv1.Deployment {
	labels := ProjectLabels(p, GCName)
	probe := func(path string, period, failures int32) *corev1.Probe {
		return &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
				Path: path, Port: intstr.FromInt32(HealthPort),
			}},
			PeriodSeconds: period, FailureThreshold: failures, TimeoutSeconds: 3,
		}
	}

	pod := corev1.PodSpec{
		ServiceAccountName: GCName,
		ImagePullSecrets:   p.Spec.ImagePullSecrets,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      new(int64(GCUID)),
			RunAsGroup:     new(int64(0)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:    "global-controller",
			Image:   image,
			Command: []string{pythonCommand, "-m", "canyonos_core.cli", "run-gc", "-c", gcConfigPath + "/global_controller.yaml"},
			Env:     gcEnv(p, endpointURL, dashboardNamespace),
			EnvFrom: appEnv(p),
			Ports:   []corev1.ContainerPort{{Name: portHealth, ContainerPort: HealthPort}},
			VolumeMounts: []corev1.VolumeMount{
				{Name: volumeConfig, MountPath: gcConfigPath, ReadOnly: true},
				{Name: volumeData, MountPath: gcDataPath},
				{Name: volumeTmp, MountPath: tmpDir},
			},
			StartupProbe:   probe("/startupz", 5, 72),
			ReadinessProbe: probe("/readyz", 5, 2),
			LivenessProbe:  probe("/livez", 10, 6),
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("100m"),
					corev1.ResourceMemory: resource.MustParse("256Mi"),
				},
				Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("1Gi")},
			},
			SecurityContext: restrictedContainer(),
		}},
		Volumes: []corev1.Volume{
			{Name: volumeConfig, VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: p.Spec.ConfigRef},
			}}},
			// The telemetry queue and refreshed prices (CANYONOS_DATA_DIR); scratch, not
			// a disk: a volume bound to one zone would pin the pod and block Recreate.
			{Name: volumeData, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{
				SizeLimit: new(resource.MustParse("1Gi")),
			}}},
			{Name: volumeTmp, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
		},
	}
	applyPlacement(&pod, p.Spec.Placement)
	quickEviction(&pod)

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: GCName, Namespace: p.Namespace, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Replicas: new(int32(1)),
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Selector: &metav1.LabelSelector{MatchLabels: GCSelector(p)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec:       pod,
			},
		},
	}
}

// gcEnv is the global controller's side of the contract with the operator: where it
// runs, its project, its Redis, its writable data folder, and the cluster dashboard
// to send telemetry to when there is one.
func gcEnv(p *canyonosv1alpha1.CanyonProject, endpointURL, dashboardNamespace string) []corev1.EnvVar {
	name := p.Spec.DisplayName
	if name == "" {
		name = p.Name
	}
	env := []corev1.EnvVar{
		{Name: "CANYONOS_TARGET", Value: "kubernetes"},
		{Name: "CANYONOS_NAMESPACE", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.namespace"},
		}},
		{Name: "CANYONOS_DATA_DIR", Value: gcDataPath},
		{Name: envHealthPort, Value: strconv.Itoa(HealthPort)},
		{Name: "CANYONOS_ENDPOINT_URL", Value: endpointURL},
		// The name the dashboard shows for the project.
		{Name: "CANYONOS_PROJECT_NAME", Value: name},
		{Name: envHome, Value: tmpDir},
	}
	if dashboardNamespace != "" {
		env = append(env, corev1.EnvVar{
			Name: "CANYONOS_DASHBOARD_OTLP_ENDPOINT", Value: DashboardOTLPEndpoint(dashboardNamespace),
		})
	}
	return append(env, RedisEnv(p)...)
}

// RedisEnv tells a CanyonOS process which Redis to use and how to log in to it
// (the CANYONOS_REDIS_* variables the core reads); the password always comes from a
// Secret, never the pod spec.
func RedisEnv(p *canyonosv1alpha1.CanyonProject) []corev1.EnvVar {
	host, port := RedisHostPort(p)
	env := []corev1.EnvVar{
		{Name: "CANYONOS_REDIS_HOST", Value: host},
		{Name: "CANYONOS_REDIS_PORT", Value: strconv.Itoa(int(port))},
	}
	if p.Spec.Redis.Mode == "external" {
		if p.Spec.Redis.TLS {
			env = append(env, corev1.EnvVar{Name: "CANYONOS_REDIS_TLS", Value: "true"})
		}
		if secret := p.Spec.Redis.PasswordSecretRef; secret != "" {
			env = append(env,
				secretEnv("CANYONOS_REDIS_PASSWORD", secret, RedisPasswordKey, false),
				secretEnv("CANYONOS_REDIS_USERNAME", secret, "username", true),
			)
		}
		return env
	}
	return append(env, secretEnv("CANYONOS_REDIS_PASSWORD", RedisName, RedisPasswordKey, false))
}

// appEnv gives a pod the project's environment Secret (API keys from its .env).
func appEnv(p *canyonosv1alpha1.CanyonProject) []corev1.EnvFromSource {
	if p.Spec.EnvSecretRef == "" {
		return nil
	}
	return []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{
		LocalObjectReference: corev1.LocalObjectReference{Name: p.Spec.EnvSecretRef},
	}}}
}

func secretEnv(name, secret, key string, optional bool) corev1.EnvVar {
	return corev1.EnvVar{Name: name, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secret},
		Key:                  key,
		Optional:             new(optional),
	}}}
}
