/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"encoding/json"
	"maps"
	"os"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

func agent() *canyonosv1alpha1.CanyonAgent {
	return &canyonosv1alpha1.CanyonAgent{
		ObjectMeta: metav1.ObjectMeta{Name: "helloagent", Namespace: testProject},
		Spec: canyonosv1alpha1.CanyonAgentSpec{
			ProjectRef: testProject, AgentName: "HelloAgent", Image: "img@sha256:abc",
			Replicas: new(int32(2)), TerminationGracePeriodSeconds: new(int64(90)),
		},
	}
}

func TestResourceNameFollowsThePythonRule(t *testing.T) {
	// The same cases as core's controller/kubernetes_api.py resource_name.
	for in, want := range map[string]string{
		"HelloAgent":            "helloagent",
		"Portfolio_Agent":       "portfolio-agent",
		"--Odd  Name--":         "odd-name",
		strings.Repeat("x", 70): strings.Repeat("x", 63),
	} {
		if got := ResourceName(in); got != want {
			t.Errorf("ResourceName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTheHeadlessServiceKeepsDrainingReplicasResolvable(t *testing.T) {
	service := AgentService(project(), agent())
	if service.Spec.ClusterIP != corev1.ClusterIPNone || !service.Spec.PublishNotReadyAddresses {
		t.Errorf("want headless with not-ready addresses published: %+v", service.Spec)
	}
}

func TestAReplicaKnowsItsOwnNameAndAddress(t *testing.T) {
	env := envOf(AgentStatefulSet(project(), agent()).Spec.Template.Spec.Containers[0])
	if env["POD_NAME"].ValueFrom.FieldRef.FieldPath != "metadata.name" {
		t.Error("POD_NAME must come from the downward API")
	}
	if env["CANYONOS_REPLICA_INDEX"].ValueFrom.FieldRef.FieldPath != "metadata.labels['apps.kubernetes.io/pod-index']" {
		t.Error("the replica's slot must be its pod's StatefulSet index")
	}
	for name, value := range map[string]string{
		// core's replica ID, <agent>-<slot>: the key the operator writes its record under.
		"CANYONOS_REPLICA_ID":             "HelloAgent-$(CANYONOS_REPLICA_INDEX)",
		"CANYONOS_AGENT_HOST":             "$(POD_NAME).helloagent.acme.svc",
		"CANYONOS_AGENT_PORT":             "50051",
		envHealthPort:                     "8099",
		"CANYONOS_SHUTDOWN_GRACE_SECONDS": "84", // 90 s grace minus the 6 s preStop pause
		"CANYONOS_POLL_INTERVAL":          "5",
		"CANYONOS_LOGS_ENABLED":           "true",
	} {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
}

func TestEveryLLMCallGoesThroughTheGateway(t *testing.T) {
	env := envOf(AgentStatefulSet(project(), agent()).Spec.Template.Spec.Containers[0])
	for name, value := range gatewayEnv {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
	if env["HTTPS_PROXY"].Value != "http://127.0.0.1:8082" || env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"].Value != "http://127.0.0.1:8081/bedrock" {
		t.Errorf("proxy %q, Bedrock %q", env["HTTPS_PROXY"].Value, env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"].Value)
	}
}

func TestTheGatewayVariablesAreExactlyCoresList(t *testing.T) {
	raw, err := os.ReadFile("../redisstate/testdata/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		LLMGatewayEnv map[string]string `json:"llm_gateway_env"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(gatewayEnv, contract.LLMGatewayEnv) {
		t.Errorf("operator %v\ncore     %v", gatewayEnv, contract.LLMGatewayEnv)
	}
}

func TestTheServicesOwnEnvCannotOverrideThePlatform(t *testing.T) {
	a := agent()
	a.Spec.Env = []corev1.EnvVar{{Name: "HTTPS_PROXY", Value: "http://corporate-proxy:3128"}}
	env := AgentEnv(project(), a)
	// Kubernetes keeps the last of two variables with one name.
	var last string
	for _, e := range env {
		if e.Name == "HTTPS_PROXY" {
			last = e.Value
		}
	}
	if last != gatewayEnv["HTTPS_PROXY"] {
		t.Errorf("the gateway must win, got %q", last)
	}
}

func TestAReplicaIsRestrictedWithNoAPIAccessAndCanReachRedis(t *testing.T) {
	statefulSet := AgentStatefulSet(project(), agent())
	pod := statefulSet.Spec.Template.Spec
	if *pod.AutomountServiceAccountToken || !*pod.SecurityContext.RunAsNonRoot {
		t.Error("agents run non-root with no Kubernetes API token")
	}
	if *pod.TerminationGracePeriodSeconds != 90 {
		t.Error("grace period not passed on")
	}
	if statefulSet.Spec.Template.Labels[LabelProject] != testProject {
		t.Error("without the project label, Redis's NetworkPolicy blocks the replica")
	}
	if *statefulSet.Spec.Replicas != 2 || statefulSet.Spec.PodManagementPolicy != "Parallel" {
		t.Errorf("replicas %d policy %s", *statefulSet.Spec.Replicas, statefulSet.Spec.PodManagementPolicy)
	}
	for _, probe := range []*corev1.Probe{
		pod.Containers[0].StartupProbe, pod.Containers[0].ReadinessProbe, pod.Containers[0].LivenessProbe,
	} {
		if probe.HTTPGet.Port.IntValue() != HealthPort {
			t.Error("probes must use the health port")
		}
	}
}

func TestAZeroPollIntervalFallsBackToTheDefault(t *testing.T) {
	p := project() // no API defaults applied
	env := envOf(corev1.Container{Env: AgentEnv(p, agent())})
	if env["CANYONOS_POLL_INTERVAL"].Value != "5" {
		t.Errorf("poll interval %q", env["CANYONOS_POLL_INTERVAL"].Value)
	}
}

func TestAStoppingReplicaServesUntilRoutingCatchesUp(t *testing.T) {
	p := project()
	p.Spec.PollIntervalSeconds = 3
	container := AgentStatefulSet(p, agent()).Spec.Template.Spec.Containers[0]
	if container.Lifecycle == nil || container.Lifecycle.PreStop.Sleep.Seconds != 4 {
		t.Errorf("preStop must cover one routing refresh (3 s) plus a second: %+v", container.Lifecycle)
	}
}

func TestTheDrainEndsWithinTheGracePeriodEvenWithALongPause(t *testing.T) {
	p := project()
	p.Spec.PollIntervalSeconds = 600 // a pause past the whole 90 s grace period
	env := envOf(corev1.Container{Env: AgentEnv(p, agent())})
	if env["CANYONOS_SHUTDOWN_GRACE_SECONDS"].Value != "1" {
		t.Errorf("drain %q", env["CANYONOS_SHUTDOWN_GRACE_SECONDS"].Value)
	}
}

func TestStatelessPodsLeaveALostNodeQuicklyUnlessThePlacementSaysOtherwise(t *testing.T) {
	tolerations := AgentStatefulSet(project(), agent()).Spec.Template.Spec.Tolerations
	for _, key := range []string{corev1.TaintNodeNotReady, corev1.TaintNodeUnreachable} {
		found := false
		for _, toleration := range tolerations {
			if toleration.Key == key && *toleration.TolerationSeconds == 30 {
				found = true
			}
		}
		if !found {
			t.Errorf("no 30 s toleration for %s: %+v", key, tolerations)
		}
	}

	a := agent()
	a.Spec.Placement = &canyonosv1alpha1.Placement{Tolerations: []corev1.Toleration{{
		Key: corev1.TaintNodeUnreachable, Operator: corev1.TolerationOpExists,
		Effect: corev1.TaintEffectNoExecute, TolerationSeconds: new(int64(600)),
	}}}
	for _, toleration := range AgentStatefulSet(project(), a).Spec.Template.Spec.Tolerations {
		if toleration.Key == corev1.TaintNodeUnreachable && *toleration.TolerationSeconds != 600 {
			t.Error("the project's own toleration must win")
		}
	}
	if RedisStatefulSet(project(), RedisImage, "h").Spec.Template.Spec.Tolerations != nil {
		t.Error("Redis keeps Kubernetes' defaults: its disk is tied to its node")
	}
}

func TestADatabaseRunsItsStockImageOnADiskThatOutlivesIt(t *testing.T) {
	a := agent()
	a.Spec.Type, a.Spec.Image = "database", "postgres:16-alpine"
	a.Spec.Database = &canyonosv1alpha1.DatabaseSpec{
		Port: 5432, MountPath: "/var/lib/postgresql/data", RunAsUser: new(int64(70)), FSGroup: new(int64(70)),
	}
	statefulSet := DatabaseStatefulSet(project(), a)
	pod := statefulSet.Spec.Template.Spec
	container := pod.Containers[0]

	if container.Image != "postgres:16-alpine" || container.Ports[0].ContainerPort != 5432 {
		t.Errorf("image %s ports %v", container.Image, container.Ports)
	}
	if *pod.SecurityContext.RunAsUser != 70 || *pod.SecurityContext.FSGroup != 70 || !*pod.SecurityContext.RunAsNonRoot {
		t.Errorf("security %+v", pod.SecurityContext)
	}
	if container.VolumeMounts[0].MountPath != "/var/lib/postgresql/data" || len(statefulSet.Spec.VolumeClaimTemplates) != 1 {
		t.Errorf("disk %v", container.VolumeMounts)
	}
	if statefulSet.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		t.Error("a database's data must outlive the CanyonAgent, as a Docker volume outlives its container")
	}
	for _, env := range container.Env {
		if strings.HasPrefix(env.Name, "CANYONOS_") {
			t.Errorf("a stock image gets no CanyonOS environment: %s", env.Name)
		}
	}
	if ReplicaPort(a) != 5432 || ReplicaPort(agent()) != AgentPort {
		t.Error("a database is reached on its own port")
	}
}
