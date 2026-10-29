/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

func TestTheEndpointRunsTheCoreImageAsDockerDoes(t *testing.T) {
	statefulSet := EndpointStatefulSet(endpointProject(), testImage)
	pod := statefulSet.Spec.Template.Spec
	container := pod.Containers[0]

	if container.Image != testImage || !slices.Equal(container.Command, []string{"python", "-m", "canyonos_core.endpoint"}) {
		t.Errorf("image %s command %v", container.Image, container.Command)
	}
	if *statefulSet.Spec.Replicas != 1 || statefulSet.Spec.ServiceName != EndpointWorkload {
		t.Errorf("replicas %d serviceName %s", *statefulSet.Spec.Replicas, statefulSet.Spec.ServiceName)
	}
	env := envOf(container)
	for name, value := range map[string]string{
		"CANYONOS_REPLICA_ID":             "endpoint-$(CANYONOS_REPLICA_INDEX)",
		"CANYONOS_AGENT_HOST":             "$(POD_NAME).endpoint.acme.svc",
		"CANYONOS_AGENT_PORT":             "50051",
		"CANYONOS_ENDPOINT_AGENT":         "Workflow",
		"CANYONOS_ENDPOINT_METHOD":        "run",
		"CANYONOS_ENDPOINT_ARGUMENTS":     "query,limit",
		envHealthPort:                     "8099",
		"CANYONOS_SHUTDOWN_GRACE_SECONDS": "120",
		"CANYONOS_REDIS_HOST":             "canyonos-redis.acme.svc",
	} {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
	if env["CANYONOS_REDIS_PASSWORD"].ValueFrom == nil {
		t.Error("the Redis password must come from the Secret")
	}
	for name := range gatewayEnv {
		if _, ok := env[name]; ok {
			t.Errorf("%s: no LLM gateway variables, the endpoint runs no agent", name)
		}
	}
	if len(container.EnvFrom) != 0 {
		t.Error("the endpoint gets no app Secret, as on Docker")
	}
}

func TestTheEndpointPodIsRestrictedAndHasNoAPIAccess(t *testing.T) {
	pod := EndpointStatefulSet(endpointProject(), testImage).Spec.Template.Spec
	container := pod.Containers[0]
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Error("the endpoint must not get a Kubernetes API token")
	}
	if !*pod.SecurityContext.RunAsNonRoot || !*container.SecurityContext.ReadOnlyRootFilesystem ||
		*container.SecurityContext.AllowPrivilegeEscalation {
		t.Errorf("not restricted: %+v %+v", pod.SecurityContext, container.SecurityContext)
	}
	if container.Lifecycle == nil || container.Lifecycle.PreStop.Sleep.Seconds != 5 {
		t.Error("a stopping endpoint must keep serving while callers stop sending to it")
	}
	if container.ReadinessProbe.HTTPGet.Path != "/readyz" || *pod.TerminationGracePeriodSeconds != 120 {
		t.Errorf("probe %s grace %d", container.ReadinessProbe.HTTPGet.Path, *pod.TerminationGracePeriodSeconds)
	}
}

func TestTheEndpointTakesTheProjectsResources(t *testing.T) {
	p := endpointProject()
	if got := EndpointStatefulSet(p, testImage).Spec.Template.Spec.Containers[0].Resources; got.Requests.Cpu().String() != "250m" {
		t.Errorf("default CPU request %s", got.Requests.Cpu())
	}
	p.Spec.Endpoint.Resources = &corev1.ResourceRequirements{
		Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2")},
	}
	if got := EndpointStatefulSet(p, testImage).Spec.Template.Spec.Containers[0].Resources; got.Limits.Cpu().String() != "2" {
		t.Errorf("CPU limit %s", got.Limits.Cpu())
	}
}

func TestTheEndpointServicesSelectOnlyItsPod(t *testing.T) {
	p := endpointProject()
	headless, callers := EndpointHeadlessService(p), EndpointService(p)
	if headless.Name != "endpoint" || headless.Spec.ClusterIP != corev1.ClusterIPNone || !headless.Spec.PublishNotReadyAddresses {
		t.Errorf("headless: %+v", headless.Spec)
	}
	if callers.Name != EndpointName || callers.Spec.ClusterIP != "" || callers.Spec.Ports[0].Port != EndpointPort {
		t.Errorf("callers: %+v", callers.Spec)
	}
	podLabels := EndpointStatefulSet(p, testImage).Spec.Template.Labels
	for _, service := range []*corev1.Service{headless, callers} {
		for key, value := range service.Spec.Selector {
			if podLabels[key] != value {
				t.Errorf("%s selects %s=%s, which the endpoint pod lacks", service.Name, key, value)
			}
		}
	}
	if _, ok := podLabels[LabelAgent]; ok {
		t.Error("the endpoint is not a CanyonAgent; its pods must not carry the agent label")
	}
}

// endpointProject serves Workflow.run, as the helloworld example does.
func endpointProject() *canyonosv1alpha1.CanyonProject {
	p := project()
	p.Spec.Endpoint = canyonosv1alpha1.EndpointSpec{
		Agent: "Workflow", Method: "run", Arguments: []string{"query", "limit"},
	}
	return p
}

func TestTheEndpointURLIsTheGivenOneElseTheIngressElseTheService(t *testing.T) {
	p := endpointProject()
	if got := EndpointURL(p); got != "http://canyonos-endpoint.acme.svc:8080" {
		t.Errorf("in-cluster: %s", got)
	}
	p.Spec.Endpoint.Ingress = &canyonosv1alpha1.EndpointIngress{Host: testHost}
	if got := EndpointURL(p); got != "http://"+testHost {
		t.Errorf("ingress: %s", got)
	}
	p.Spec.Endpoint.Ingress.TLSSecretName = testTLSSecret
	if got := EndpointURL(p); got != "https://"+testHost {
		t.Errorf("ingress with a certificate: %s", got)
	}
	p.Spec.Endpoint.URL = "https://api.example.com/acme"
	if got := EndpointURL(p); got != "https://api.example.com/acme" {
		t.Errorf("given: %s", got)
	}
}

func TestTheEndpointIngressRoutesItsHostToTheEndpointService(t *testing.T) {
	p := endpointProject()
	p.Spec.Endpoint.Ingress = &canyonosv1alpha1.EndpointIngress{
		Host: testHost, ClassName: new("alb"), TLSSecretName: testTLSSecret,
		Annotations: map[string]string{"alb.ingress.kubernetes.io/scheme": "internal"},
	}
	ingress := EndpointIngress(p)

	if *ingress.Spec.IngressClassName != "alb" || ingress.Annotations["alb.ingress.kubernetes.io/scheme"] != "internal" {
		t.Errorf("class %v annotations %v", ingress.Spec.IngressClassName, ingress.Annotations)
	}
	rule := ingress.Spec.Rules[0]
	backend := rule.HTTP.Paths[0].Backend.Service
	if rule.Host != testHost || backend.Name != EndpointName || backend.Port.Number != EndpointPort {
		t.Errorf("rule %+v backend %+v", rule, backend)
	}
	if len(ingress.Spec.TLS) != 1 || ingress.Spec.TLS[0].SecretName != testTLSSecret {
		t.Errorf("tls %+v", ingress.Spec.TLS)
	}

	p.Spec.Endpoint.Ingress.ClassName = nil
	p.Spec.Endpoint.Ingress.TLSSecretName = ""
	if ingress := EndpointIngress(p); ingress.Spec.IngressClassName != nil || ingress.Spec.TLS != nil {
		t.Error("no class means the cluster's default; no Secret means no TLS section")
	}
}

const (
	testHost      = "acme.apps.example.com"
	testTLSSecret = "acme-tls"
)
