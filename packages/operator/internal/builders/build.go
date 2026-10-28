/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"fmt"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	// LabelBuild marks a build's pod; only such pods may reach the builder.
	LabelBuild = "canyonos.canyoncode.ai/build"
	// UploadPort is where a build pod takes the project's upload.
	UploadPort = 8090
	// BuildReceiver and BuildContainer are a build pod's two containers.
	BuildReceiver  = "receive"
	BuildContainer = "build"

	buildWork  = "/work"
	volumeWork = "work"
	// uploadTimeoutSeconds is how long a build waits for the project's upload.
	uploadTimeoutSeconds = 900
	// buildDeadlineSeconds bounds a whole build, upload included.
	buildDeadlineSeconds = 3600
)

// BuildOptions is what the operator knows about the cluster's builder.
type BuildOptions struct {
	// Image is the canyonos-core image to build with (the spec's, or the operator's).
	Image string
	// BuilderAddress is the BuildKit daemon (tcp://buildkitd.canyonos-build.svc:1234).
	BuilderAddress string
	// PushRegistry is the registry as the builder reaches it, when the nodes name it
	// differently (kind: kind-registry:5000 for localhost:5001); else the spec's.
	PushRegistry string
}

func buildLabels(build *canyonosv1alpha1.CanyonBuild) map[string]string {
	return map[string]string{
		LabelName: "canyonos-build", LabelManagedBy: ManagedBy, LabelPartOf: "canyonos", LabelBuild: build.Name,
	}
}

// BuildRole is what a build may do, in its namespace only, to apply the project it
// built: its ConfigMap, its CanyonProject and its CanyonAgents, nothing else.
func BuildRole(build *canyonosv1alpha1.CanyonBuild) *rbacv1.Role {
	write := []string{verbGet, "create", "update", verbPatch}
	return &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: build.Name, Namespace: build.Namespace, Labels: buildLabels(build)},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: write},
			{APIGroups: []string{apiGroup}, Resources: []string{"canyonprojects"}, Verbs: write},
			{APIGroups: []string{apiGroup}, Resources: []string{"canyonagents"},
				Verbs: []string{verbGet, "list", "create", "update", verbPatch, "delete"}},
		},
	}
}

// BuildServiceAccount is the build's identity, bound to BuildRole.
func BuildServiceAccount(build *canyonosv1alpha1.CanyonBuild) *corev1.ServiceAccount {
	return &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: build.Name, Namespace: build.Namespace, Labels: buildLabels(build)},
	}
}

// BuildRoleBinding grants BuildRole to BuildServiceAccount.
func BuildRoleBinding(build *canyonosv1alpha1.CanyonBuild) *rbacv1.RoleBinding {
	return &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: build.Name, Namespace: build.Namespace, Labels: buildLabels(build)},
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: build.Name},
		Subjects:   []rbacv1.Subject{{Kind: rbacv1.ServiceAccountKind, Name: build.Name, Namespace: build.Namespace}},
	}
}

// buildScript waits for the upload, builds and pushes on the builder, applies the
// project, and leaves the images as the container's termination message (the
// operator reads them from there: the build needs no access to its CanyonBuild).
func buildScript(build *canyonosv1alpha1.CanyonBuild, opts BuildOptions) string {
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	steps := []string{
		// As long as the receiver waits: without an upload it stops, and the build must
		// fail then, not wait for the Job's deadline.
		fmt.Sprintf("for _ in $(seq %d); do [ -f %s/.canyonos-received ] && break; sleep 1; done", uploadTimeoutSeconds, buildWork),
		fmt.Sprintf("[ -f %s/.canyonos-received ] || { echo 'No project was uploaded within %d seconds.' >&2; exit 1; }",
			buildWork, uploadTimeoutSeconds),
		fmt.Sprintf("python -m canyonos_core.cli build -c %s --builder %s --registry %s --push-registry %s "+
			"--tag %s --output-json /tmp/images.json",
			quote(build.Spec.Config), quote(opts.BuilderAddress), quote(build.Spec.Registry),
			quote(opts.PushRegistry), quote(build.Spec.Tag)),
		fmt.Sprintf(
			"python -m canyonos_core.cli apply-project -c %s --images /tmp/images.json --project %s --env-secret %s",
			quote(build.Spec.Config), quote(build.Spec.Project), quote(build.Spec.EnvSecretRef)),
		"cp /tmp/images.json /dev/termination-log",
	}
	return "set -e\n" + strings.Join(steps, "\n")
}

// BuildJob runs one build: a receiver that takes the upload (a port-forward reaches
// only running pods, so it cannot be an init container) and the build beside it,
// starting once the project is in. Restricted like every CanyonOS pod; the building
// itself happens on the builder.
func BuildJob(build *canyonosv1alpha1.CanyonBuild, opts BuildOptions) *batchv1.Job {
	labels := buildLabels(build)
	env := []corev1.EnvVar{
		{Name: envHome, Value: tmpDir},
		// Images are named after the project, so projects sharing a registry keep apart.
		{Name: "CANYONOS_DOCKER_PROJECT", Value: ResourceName(build.Spec.Project)},
		// The project runs the core image it was built with.
		{Name: "CANYONOS_CORE_IMAGE", Value: opts.Image},
	}
	if build.Spec.Platform != "" {
		// Unset, the build takes its own node's architecture.
		env = append(env, corev1.EnvVar{Name: "CANYONOS_DOCKER_PLATFORM", Value: build.Spec.Platform})
	}
	var envFrom []corev1.EnvFromSource
	if build.Spec.EnvSecretRef != "" {
		envFrom = []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: build.Spec.EnvSecretRef}, Optional: new(true),
		}}}
	}
	mounts := []corev1.VolumeMount{{Name: volumeWork, MountPath: buildWork}, {Name: volumeTmp, MountPath: tmpDir}}
	volumes := []corev1.Volume{
		{Name: volumeWork, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
		{Name: volumeTmp, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
	}
	if build.Spec.RegistrySecretRef != "" {
		// docker reads $HOME/.docker/config.json; the builder pushes with it.
		mounts = append(mounts, corev1.VolumeMount{Name: "registry", MountPath: tmpDir + "/.docker", ReadOnly: true})
		volumes = append(volumes, corev1.Volume{Name: "registry", VolumeSource: corev1.VolumeSource{
			Secret: &corev1.SecretVolumeSource{
				SecretName: build.Spec.RegistrySecretRef,
				Items:      []corev1.KeyToPath{{Key: corev1.DockerConfigJsonKey, Path: "config.json"}},
			},
		}})
	}

	pod := corev1.PodSpec{
		RestartPolicy:                corev1.RestartPolicyNever,
		ServiceAccountName:           build.Name,
		AutomountServiceAccountToken: new(true), // apply-project calls the API
		ImagePullSecrets:             build.Spec.ImagePullSecrets,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      new(int64(GCUID)),
			RunAsGroup:     new(int64(0)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{
			{
				Name:  BuildReceiver,
				Image: opts.Image,
				Command: []string{pythonCommand, "-m", "canyonos_core.cli", "receive",
					"--dest", buildWork, "--port", fmt.Sprint(UploadPort), "--timeout", fmt.Sprint(uploadTimeoutSeconds)},
				Ports:           []corev1.ContainerPort{{Name: "upload", ContainerPort: UploadPort}},
				VolumeMounts:    []corev1.VolumeMount{{Name: volumeWork, MountPath: buildWork}},
				SecurityContext: restrictedContainer(),
			},
			{
				Name:                     BuildContainer,
				Image:                    opts.Image,
				Command:                  []string{"sh", "-c", buildScript(build, opts)},
				WorkingDir:               buildWork,
				Env:                      env,
				EnvFrom:                  envFrom,
				VolumeMounts:             mounts,
				TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
				SecurityContext:          restrictedContainer(),
			},
		},
		Volumes: volumes,
	}

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: build.Name, Namespace: build.Namespace, Labels: labels},
		Spec: batchv1.JobSpec{
			BackoffLimit:          new(int32(0)),
			ActiveDeadlineSeconds: new(int64(buildDeadlineSeconds)),
			Template:              corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: pod},
		},
	}
}
