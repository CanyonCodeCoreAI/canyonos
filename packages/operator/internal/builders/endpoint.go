/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"fmt"
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	// EndpointName is the Service callers reach the endpoint at.
	EndpointName = "canyonos-endpoint"
	// EndpointPort is where the endpoint serves HTTP inside the cluster.
	EndpointPort = 8080
	// EndpointAgentName is the endpoint's agent name in replica records and
	// routing, as core names its replica spec (canyonos_core.endpoint.SERVICE_NAME).
	EndpointAgentName = "endpoint"
	// EndpointWorkload names the endpoint's StatefulSet and headless Service, by the
	// rule agents follow (ResourceName of its agent name): its replica is
	// endpoint-0.endpoint.<ns>.svc.
	EndpointWorkload = "endpoint"
	// endpointGrace is how long a stopping endpoint finishes its HTTP requests (its
	// gunicorn allows 30 s) and the calls it forwarded.
	endpointGrace = 120
	// endpointPreStop covers the time a Service's endpoints and an ingress controller
	// take to drop a stopping endpoint pod.
	endpointPreStop = 5
)

// EndpointServiceURL is the endpoint's address inside the cluster, published while
// it has no Route or Ingress.
func EndpointServiceURL(p *canyonosv1alpha1.CanyonProject) string {
	return fmt.Sprintf("http://%s.%s.svc:%d", EndpointName, p.Namespace, EndpointPort)
}

// EndpointURL is where callers reach the endpoint, published in the project's status
// and by the global controller: the URL the project gives, else its Ingress host
// (https with a certificate), else the in-cluster Service.
func EndpointURL(p *canyonosv1alpha1.CanyonProject) string {
	endpoint := p.Spec.Endpoint
	switch {
	case endpoint.URL != "":
		return endpoint.URL
	case endpoint.Ingress == nil:
		return EndpointServiceURL(p)
	case endpoint.Ingress.TLSSecretName != "":
		return "https://" + endpoint.Ingress.Host
	default:
		return "http://" + endpoint.Ingress.Host
	}
}

// EndpointIngress exposes the endpoint's Service at the project's host, through the
// ingress class it names (or the cluster's default). The ingress controller, its
// load balancer, DNS and certificates stay the customer's.
func EndpointIngress(p *canyonosv1alpha1.CanyonProject) *networkingv1.Ingress {
	spec := p.Spec.Endpoint.Ingress
	ingress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name: EndpointName, Namespace: p.Namespace,
			Labels: ProjectLabels(p, EndpointName), Annotations: spec.Annotations,
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: spec.ClassName,
			Rules: []networkingv1.IngressRule{{
				Host: spec.Host,
				IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{
					Paths: []networkingv1.HTTPIngressPath{{
						Path:     "/",
						PathType: new(networkingv1.PathTypePrefix),
						Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{
							Name: EndpointName, Port: networkingv1.ServiceBackendPort{Number: EndpointPort},
						}},
					}},
				}},
			}},
		},
	}
	if spec.TLSSecretName != "" {
		ingress.Spec.TLS = []networkingv1.IngressTLS{{Hosts: []string{spec.Host}, SecretName: spec.TLSSecretName}}
	}
	return ingress
}

// EndpointSelector selects the project's endpoint pod.
func EndpointSelector(p *canyonosv1alpha1.CanyonProject) map[string]string {
	return map[string]string{LabelName: EndpointWorkload, LabelProject: p.Name}
}

// EndpointService is where callers reach the endpoint's HTTP API, by a name that
// stays the same whichever pod serves it.
func EndpointService(p *canyonosv1alpha1.CanyonProject) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: EndpointName, Namespace: p.Namespace, Labels: ProjectLabels(p, EndpointName)},
		Spec: corev1.ServiceSpec{
			Selector: EndpointSelector(p),
			Ports: []corev1.ServicePort{{
				Name: "http", Port: EndpointPort, TargetPort: intstr.FromInt32(EndpointPort),
			}},
		},
	}
}

// EndpointHeadlessService gives the endpoint's pod its stable DNS name, the address
// replicas send each finished call's result back to. A replacement pod takes the
// same name, so results of calls it queued before a restart still arrive.
func EndpointHeadlessService(p *canyonosv1alpha1.CanyonProject) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name: EndpointWorkload, Namespace: p.Namespace, Labels: ProjectLabels(p, EndpointWorkload),
		},
		Spec: corev1.ServiceSpec{
			ClusterIP:                corev1.ClusterIPNone,
			PublishNotReadyAddresses: true,
			Selector:                 EndpointSelector(p),
			Ports: []corev1.ServicePort{{
				Name: portGRPC, Port: AgentPort, TargetPort: intstr.FromInt32(AgentPort),
			}},
		},
	}
}

// EndpointStatefulSet runs the endpoint from the canyonos-core image, as Docker
// does (`python -m canyonos_core.endpoint`): gunicorn serving the agent method on
// 8080, beside a LocalController with no agent that routes its calls. One replica,
// as on every target; no app image and no app Secret.
func EndpointStatefulSet(p *canyonosv1alpha1.CanyonProject, image string) *appsv1.StatefulSet {
	labels := ProjectLabels(p, EndpointWorkload)
	probe := func(path string, period, failures int32) *corev1.Probe {
		return &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
				Path: path, Port: intstr.FromInt32(HealthPort),
			}},
			PeriodSeconds: period, FailureThreshold: failures, TimeoutSeconds: 3,
		}
	}
	resources := corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("250m"),
			corev1.ResourceMemory: resource.MustParse("256Mi"),
		},
		Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("1Gi")},
	}
	if p.Spec.Endpoint.Resources != nil {
		resources = *p.Spec.Endpoint.Resources
	}

	pod := corev1.PodSpec{
		AutomountServiceAccountToken:  new(false),
		ImagePullSecrets:              p.Spec.ImagePullSecrets,
		TerminationGracePeriodSeconds: new(int64(endpointGrace)),
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      new(int64(GCUID)),
			RunAsGroup:     new(int64(0)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:    "endpoint",
			Image:   image,
			Command: []string{pythonCommand, "-m", "canyonos_core.endpoint"},
			Env:     endpointEnv(p),
			Ports: []corev1.ContainerPort{
				{Name: "http", ContainerPort: EndpointPort},
				{Name: portGRPC, ContainerPort: AgentPort},
				{Name: portHealth, ContainerPort: HealthPort},
			},
			// gunicorn keeps its worker heartbeats in /tmp.
			VolumeMounts:   []corev1.VolumeMount{{Name: volumeTmp, MountPath: tmpDir}},
			StartupProbe:   probe("/startupz", 5, 72),
			ReadinessProbe: probe("/readyz", 5, 2),
			LivenessProbe:  probe("/livez", 10, 6),
			// Keep serving HTTP until the Service and ingress stop sending here.
			Lifecycle:       preStopPause(endpointPreStop),
			Resources:       resources,
			SecurityContext: restrictedContainer(),
		}},
		Volumes: []corev1.Volume{
			{Name: volumeTmp, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
		},
	}
	applyPlacement(&pod, p.Spec.Placement)
	quickEviction(&pod)

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: EndpointWorkload, Namespace: p.Namespace, Labels: labels},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: EndpointWorkload,
			Replicas:    new(int32(1)),
			// The operator replaces its pod with a second one already serving (a surge
			// update), so an upgrade does not leave callers without an endpoint.
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.OnDeleteStatefulSetStrategyType},
			Selector:       &metav1.LabelSelector{MatchLabels: EndpointSelector(p)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec:       pod,
			},
		},
	}
}

// endpointEnv is what Docker gives the endpoint's container, with the pod's own
// address and the health and drain opt-ins. No LLM gateway variables: it runs no
// agent.
func endpointEnv(p *canyonosv1alpha1.CanyonProject) []corev1.EnvVar {
	return append([]corev1.EnvVar{
		{Name: "POD_NAME", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
		}},
		{Name: "CANYONOS_AGENT_HOST", Value: "$(POD_NAME)." + EndpointWorkload + "." + p.Namespace + ".svc"},
		{Name: "CANYONOS_AGENT_PORT", Value: strconv.Itoa(AgentPort)},
		{Name: "CANYONOS_ENDPOINT_AGENT", Value: p.Spec.Endpoint.Agent},
		{Name: "CANYONOS_ENDPOINT_METHOD", Value: p.Spec.Endpoint.Method},
		pollIntervalEnv(p),
		logsEnabledEnv(p),
		{Name: envHealthPort, Value: strconv.Itoa(HealthPort)},
		{Name: "CANYONOS_SHUTDOWN_GRACE_SECONDS", Value: strconv.Itoa(endpointGrace)},
		{Name: envHome, Value: tmpDir},
	}, append(replicaIDEnv(EndpointAgentName), RedisEnv(p)...)...)
}
