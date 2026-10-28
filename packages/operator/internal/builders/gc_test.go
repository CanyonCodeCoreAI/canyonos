/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

const (
	testImage     = "ghcr.io/canyoncodecoreai/canyonos-core:1.2.3"
	testEnvSecret = "acme-env"
)

func envOf(container corev1.Container) map[string]corev1.EnvVar {
	byName := map[string]corev1.EnvVar{}
	for _, env := range container.Env {
		byName[env.Name] = env
	}
	return byName
}

func TestTheGCRoleGrantsOnlyScalingAndReadingPods(t *testing.T) {
	rules := GCRole(project()).Rules
	want := map[string][]string{
		"canyonagents/scale": {"get", "patch"},
		"pods":               {"get", "list"},
	}
	for _, rule := range rules {
		for _, resource := range rule.Resources {
			if expected, ok := want[resource]; !ok || !slices.Equal(rule.Verbs, expected) {
				t.Errorf("unexpected grant %v on %s/%s", rule.Verbs, rule.APIGroups, resource)
			}
			if slices.Contains(rule.Verbs, "*") || slices.Contains(rule.Resources, "*") {
				t.Errorf("wildcard grant: %+v", rule)
			}
		}
	}
	if len(rules) != 3 {
		t.Errorf("want 3 rules (scale, pods, pod metrics), got %d", len(rules))
	}
}

func TestTheGCRunsRunGCWithTheOperatorContract(t *testing.T) {
	deployment := GCDeployment(project(), testImage, "http://canyonos-endpoint.acme.svc:8080")
	container := deployment.Spec.Template.Spec.Containers[0]

	if !slices.Contains(container.Command, "run-gc") || container.Image != testImage {
		t.Errorf("command %v image %s", container.Command, container.Image)
	}
	env := envOf(container)
	for name, value := range map[string]string{
		"CANYONOS_TARGET":       "kubernetes",
		"CANYONOS_DATA_DIR":     "/var/lib/canyonos",
		envHealthPort:           "8099",
		"CANYONOS_REDIS_HOST":   "canyonos-redis.acme.svc",
		"CANYONOS_REDIS_PORT":   "6379",
		"CANYONOS_ENDPOINT_URL": "http://canyonos-endpoint.acme.svc:8080",
	} {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
	if env["CANYONOS_NAMESPACE"].ValueFrom.FieldRef.FieldPath != "metadata.namespace" {
		t.Error("namespace must come from the downward API")
	}
	password := env["CANYONOS_REDIS_PASSWORD"]
	if password.Value != "" || password.ValueFrom.SecretKeyRef.Name != RedisName {
		t.Errorf("the Redis password must come from the Secret: %+v", password)
	}
}

func TestOnlyOneGCRunsAtATime(t *testing.T) {
	deployment := GCDeployment(project(), testImage, "")
	if *deployment.Spec.Replicas != 1 || deployment.Spec.Strategy.Type != "Recreate" {
		t.Errorf("replicas %d strategy %s", *deployment.Spec.Replicas, deployment.Spec.Strategy.Type)
	}
}

func TestTheGCIsRestrictedNonRootWithAReadOnlyImage(t *testing.T) {
	pod := GCDeployment(project(), testImage, "").Spec.Template.Spec
	if *pod.SecurityContext.RunAsUser != GCUID || *pod.SecurityContext.RunAsGroup != 0 {
		t.Error("the GC runs as UID 1001, group 0")
	}
	if !*pod.Containers[0].SecurityContext.ReadOnlyRootFilesystem {
		t.Error("the GC's root filesystem must be read-only")
	}
	mounts := map[string]bool{}
	for _, mount := range pod.Containers[0].VolumeMounts {
		mounts[mount.MountPath] = mount.ReadOnly
	}
	if readOnly, ok := mounts["/etc/canyonos/config"]; !ok || !readOnly {
		t.Error("the config must be mounted read-only")
	}
	if _, ok := mounts["/var/lib/canyonos"]; !ok {
		t.Error("the data folder must be mounted")
	}
}

func TestTheGCPodCanReachRedis(t *testing.T) {
	labels := GCDeployment(project(), testImage, "").Spec.Template.Labels
	if labels[LabelProject] != testProject {
		t.Error("the GC pod needs the project label, or Redis's NetworkPolicy blocks it")
	}
}

func TestAnExternalRedisLogsInFromTheCustomersSecret(t *testing.T) {
	p := project()
	p.Spec.Redis.Mode = "external"
	p.Spec.Redis.Host = "redis.example.internal"
	p.Spec.Redis.Port = 6380
	p.Spec.Redis.TLS = true
	p.Spec.Redis.PasswordSecretRef = "elasticache"

	env := map[string]corev1.EnvVar{}
	for _, e := range RedisEnv(p) {
		env[e.Name] = e
	}
	if env["CANYONOS_REDIS_HOST"].Value != "redis.example.internal" || env["CANYONOS_REDIS_PORT"].Value != "6380" {
		t.Errorf("address: %+v", env)
	}
	if env["CANYONOS_REDIS_TLS"].Value != "true" {
		t.Error("TLS not passed on")
	}
	if env["CANYONOS_REDIS_PASSWORD"].ValueFrom.SecretKeyRef.Name != "elasticache" {
		t.Error("password must come from the customer's Secret")
	}
	if !*env["CANYONOS_REDIS_USERNAME"].ValueFrom.SecretKeyRef.Optional {
		t.Error("the username key is optional")
	}
}

func TestTheAppSecretIsOptional(t *testing.T) {
	p := project()
	if appEnv(p) != nil {
		t.Error("no envSecretRef, no envFrom")
	}
	p.Spec.EnvSecretRef = testEnvSecret
	if appEnv(p)[0].SecretRef.Name != testEnvSecret {
		t.Error("envSecretRef not used")
	}
}

func TestTheGCKnowsItsProjectsName(t *testing.T) {
	p := project()
	env := envOf(GCDeployment(p, testImage, "").Spec.Template.Spec.Containers[0])
	if env["CANYONOS_PROJECT_NAME"].Value != testProject {
		t.Errorf("project name %q, want the CanyonProject's name", env["CANYONOS_PROJECT_NAME"].Value)
	}

	p.Spec.DisplayName = "Trading Agents"
	env = envOf(GCDeployment(p, testImage, "").Spec.Template.Spec.Containers[0])
	if env["CANYONOS_PROJECT_NAME"].Value != "Trading Agents" {
		t.Errorf("project name %q", env["CANYONOS_PROJECT_NAME"].Value)
	}
}
