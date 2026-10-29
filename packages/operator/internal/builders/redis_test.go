/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const testProject = "acme"

func project() *canyonosv1alpha1.CanyonProject {
	return &canyonosv1alpha1.CanyonProject{
		ObjectMeta: metav1.ObjectMeta{Name: testProject, Namespace: testProject},
	}
}

func TestRedisConfigSetsThePasswordAndKeepsData(t *testing.T) {
	config := RedisConfig("s3cret")
	for _, line := range []string{"requirepass s3cret", "appendonly yes", "maxmemory-policy noeviction"} {
		if !strings.Contains(config, line) {
			t.Errorf("redis.conf lacks %q:\n%s", line, config)
		}
	}
}

func TestThePasswordNeverReachesACommandLine(t *testing.T) {
	statefulSet := RedisStatefulSet(project(), RedisImage, SecretVersion(RedisSecret(project(), "s3cret")))
	container := statefulSet.Spec.Template.Spec.Containers[0]

	if strings.Contains(strings.Join(container.Args, " "), "s3cret") {
		t.Errorf("password on the command line: %v", container.Args)
	}
	for _, env := range container.Env {
		if env.Value != "" {
			t.Errorf("env %s carries a literal value; secrets come from secretKeyRef", env.Name)
		}
	}
	auth := container.Env[0]
	if auth.Name != "REDISCLI_AUTH" || auth.ValueFrom.SecretKeyRef.Key != RedisPasswordKey {
		t.Errorf("probes cannot authenticate: %+v", auth)
	}
}

func TestRedisMeetsTheRestrictedPodSecurityProfile(t *testing.T) {
	pod := RedisStatefulSet(project(), RedisImage, "h").Spec.Template.Spec
	security := pod.Containers[0].SecurityContext

	if !*pod.SecurityContext.RunAsNonRoot || *pod.AutomountServiceAccountToken {
		t.Error("Redis must run as non-root with no service account token")
	}
	if *security.AllowPrivilegeEscalation || !*security.ReadOnlyRootFilesystem {
		t.Error("Redis must not escalate and must have a read-only root filesystem")
	}
	if len(security.Capabilities.Drop) != 1 || security.Capabilities.Drop[0] != "ALL" {
		t.Errorf("capabilities not all dropped: %v", security.Capabilities)
	}
	if pod.SecurityContext.SeccompProfile.Type != "RuntimeDefault" {
		t.Error("seccomp profile must be RuntimeDefault")
	}
}

func TestStorageSizeAndClassComeFromTheProject(t *testing.T) {
	p := project()
	p.Spec.Redis.Storage = new(resource.MustParse("5Gi"))
	p.Spec.Redis.StorageClassName = new("gp3")

	claim := RedisStatefulSet(p, RedisImage, "h").Spec.VolumeClaimTemplates[0]
	if size := claim.Spec.Resources.Requests.Storage(); size.Cmp(resource.MustParse("5Gi")) != 0 {
		t.Errorf("storage = %v", size)
	}
	if *claim.Spec.StorageClassName != "gp3" {
		t.Errorf("storage class = %v", *claim.Spec.StorageClassName)
	}
}

func TestANewOrChangedSecretRollsRedis(t *testing.T) {
	secret := func(uid, version, password string) *corev1.Secret {
		s := RedisSecret(project(), password)
		s.UID, s.ResourceVersion = types.UID(uid), version
		return s
	}
	annotation := func(s *corev1.Secret) string {
		return RedisStatefulSet(project(), RedisImage, SecretVersion(s)).
			Spec.Template.Annotations[ConfigHashAnnotation]
	}
	first := annotation(secret("a", "1", "old"))
	if first == annotation(secret("b", "1", "new")) {
		t.Error("a new Secret (the old one deleted to rotate the password) must roll Redis")
	}
	if first == annotation(secret("a", "2", "new")) {
		t.Error("a changed Secret must roll Redis")
	}
}

func TestTheAnnotationTellsNothingAboutThePassword(t *testing.T) {
	// The same Secret version with another password: nothing of it may show, or anyone
	// who may view the StatefulSet could test password guesses against it.
	withPassword := func(password string) string {
		s := RedisSecret(project(), password)
		s.UID, s.ResourceVersion = "a", "1"
		return SecretVersion(s)
	}
	if withPassword("hunter2") != withPassword("correct horse battery staple") {
		t.Error("SecretVersion must not depend on the Secret's contents")
	}
}

func TestOnlyTheProjectAndTheOperatorReachRedis(t *testing.T) {
	peers := RedisNetworkPolicy(project(), "canyonos-system", "").Spec.Ingress[0].From

	if len(peers) != 2 {
		t.Fatalf("want 2 peers, got %d", len(peers))
	}
	if peers[0].PodSelector.MatchLabels[LabelProject] != testProject {
		t.Errorf("first peer must be the project's own pods: %+v", peers[0])
	}
	if got := peers[1].NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"]; got != "canyonos-system" {
		t.Errorf("second peer = %q, want the operator's namespace", got)
	}
}

func TestARedisLoginMarksThePodTemplate(t *testing.T) {
	template := &corev1.PodTemplateSpec{}
	StampRedisLogin(template, "")
	if template.Annotations != nil {
		t.Errorf("no login, no annotation: %v", template.Annotations)
	}
	StampRedisLogin(template, "abc")
	if template.Annotations[RedisLoginAnnotation] != "abc" {
		t.Errorf("annotations %v", template.Annotations)
	}
}

func TestOnlyTheDashboardsAPIJoinsThem(t *testing.T) {
	peers := RedisNetworkPolicy(project(), "canyonos-system", "canyonos-dashboard").Spec.Ingress[0].From

	if len(peers) != 3 {
		t.Fatalf("want 3 peers, got %d", len(peers))
	}
	dashboard := peers[2]
	if dashboard.NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"] != "canyonos-dashboard" ||
		dashboard.PodSelector == nil || dashboard.PodSelector.MatchLabels[LabelName] != DashboardAPIName {
		t.Errorf("the dashboard peer must be its API pod alone, not its whole namespace: %+v", dashboard)
	}
}

func TestPlacementReachesThePod(t *testing.T) {
	p := project()
	p.Spec.Placement = &canyonosv1alpha1.Placement{NodeSelector: map[string]string{"pool": "data"}}
	if RedisStatefulSet(p, RedisImage, "h").Spec.Template.Spec.NodeSelector["pool"] != "data" {
		t.Error("node selector not applied")
	}
}
