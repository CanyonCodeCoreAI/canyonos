/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

func canyonBuild() *canyonosv1alpha1.CanyonBuild {
	return &canyonosv1alpha1.CanyonBuild{
		ObjectMeta: metav1.ObjectMeta{Name: "acme-t1", Namespace: testProject},
		Spec: canyonosv1alpha1.CanyonBuildSpec{
			Project: "Trading_Agents", Config: ".canyon/config/global_controller.yaml",
			Registry: "localhost:5001", Tag: "t1", EnvSecretRef: testEnvSecret,
		},
	}
}

var buildOptions = BuildOptions{
	Image: testImage, BuilderAddress: "tcp://buildkitd.canyonos-build.svc:1234", PushRegistry: "kind-registry:5000",
}

func TestABuildReceivesThenBuildsOnTheBuilderAndApplies(t *testing.T) {
	job := BuildJob(canyonBuild(), buildOptions)
	pod := job.Spec.Template.Spec
	if len(pod.InitContainers) != 0 || len(pod.Containers) != 2 {
		t.Fatalf("a port-forward reaches only running pods: the receiver is a container, got %+v", pod)
	}
	script := pod.Containers[1].Command[2]
	for _, want := range []string{
		"[ -f /work/.canyonos-received ] && break",
		"--builder 'tcp://buildkitd.canyonos-build.svc:1234' --registry 'localhost:5001' --push-registry 'kind-registry:5000'",
		"apply-project -c '.canyon/config/global_controller.yaml'",
		"cp /tmp/images.json /dev/termination-log",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script lacks %q:\n%s", want, script)
		}
	}
	env := envOf(pod.Containers[1])
	if env["CANYONOS_DOCKER_PROJECT"].Value != "trading-agents" || env["CANYONOS_CORE_IMAGE"].Value != testImage {
		t.Errorf("env %v", env)
	}
	if pod.Containers[1].EnvFrom[0].SecretRef.Name != testEnvSecret {
		t.Error("the .env Secret resolves ${VAR} during the build")
	}
	if !*pod.AutomountServiceAccountToken || *job.Spec.BackoffLimit != 0 {
		t.Error("apply-project needs the API; a failed build is not retried blindly")
	}
	if job.Spec.Template.Labels[LabelBuild] != "acme-t1" {
		t.Error("only build pods may reach the builder")
	}
}

func TestWithoutAnUploadTheBuildFailsInsteadOfWaiting(t *testing.T) {
	script := BuildJob(canyonBuild(), buildOptions).Spec.Template.Spec.Containers[1].Command[2]
	// The receiver gives up after uploadTimeoutSeconds; the build must too, or the
	// CanyonBuild would show Building until the Job's deadline.
	if !strings.Contains(script, fmt.Sprintf("seq %d", uploadTimeoutSeconds)) ||
		!strings.Contains(script, "No project was uploaded") {
		t.Errorf("the wait for the upload must end: %s", script)
	}
	receiver := BuildJob(canyonBuild(), buildOptions).Spec.Template.Spec.Containers[0].Command
	if !slices.Contains(receiver, fmt.Sprint(uploadTimeoutSeconds)) {
		t.Errorf("the receiver must wait as long as the build: %v", receiver)
	}
}

func TestTheBuildAppliesItsProjectAfterPushing(t *testing.T) {
	script := BuildJob(canyonBuild(), buildOptions).Spec.Template.Spec.Containers[1].Command[2]
	build, apply := strings.Index(script, "cli build"), strings.Index(script, "cli apply-project")
	if build < 0 || apply < build {
		t.Errorf("want build, then apply-project:\n%s", script)
	}
}

func TestABuildMayOnlyApplyItsProject(t *testing.T) {
	for _, rule := range BuildRole(canyonBuild()).Rules {
		for _, resource := range rule.Resources {
			if !slices.Contains([]string{"configmaps", "canyonprojects", "canyonagents"}, resource) {
				t.Errorf("unexpected grant on %s", resource)
			}
		}
		if slices.Contains(rule.Verbs, "*") {
			t.Errorf("wildcard verbs: %+v", rule)
		}
	}
}

func TestABuildNamingNoPlatformBuildsForItsOwnNode(t *testing.T) {
	env := envOf(BuildJob(canyonBuild(), buildOptions).Spec.Template.Spec.Containers[1])
	if _, set := env["CANYONOS_DOCKER_PLATFORM"]; set {
		t.Error("an arm64 cluster must not get amd64 images by default")
	}
	build := canyonBuild()
	build.Spec.Platform = "linux/arm64"
	env = envOf(BuildJob(build, buildOptions).Spec.Template.Spec.Containers[1])
	if env["CANYONOS_DOCKER_PLATFORM"].Value != "linux/arm64" {
		t.Errorf("a named platform is built for, got %v", env)
	}
}
