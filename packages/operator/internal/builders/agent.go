/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	// AgentPort is where every replica's LocalController serves gRPC.
	AgentPort = 50051
	// LabelAgent selects one agent's pods.
	LabelAgent = "canyonos.canyoncode.ai/agent"
	// AgentUID runs agent images as a non-root user; group 0 for OpenShift.
	AgentUID = 1001
)

var notDNS = regexp.MustCompile(`[^a-z0-9-]+`)

// ResourceName is the Kubernetes name of an agent: lowercase, anything but letters,
// digits and hyphens turned into hyphens, at most 63 characters. The CLI and the
// global controller use the same rule (controller/kubernetes_api.py resource_name).
func ResourceName(agentName string) string {
	name := strings.Trim(notDNS.ReplaceAllString(strings.ToLower(agentName), "-"), "-")
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	return name
}

// The LLM gateway every replica runs beside its agent, its proxy, and the CA the proxy
// re-encrypts HTTPS calls with.
const (
	gatewayHost   = "http://127.0.0.1:8081"
	gatewayProxy  = "http://127.0.0.1:8082"
	proxyCABundle = "/tmp/canyonos-proxy/ca-bundle.pem"
)

// gatewayEnv routes the agent's LLM calls through the replica's own LLM gateway:
// Bedrock by its base URL, every other HTTP(S) call through the gateway's proxy. It
// mirrors core's reconciler/providers/shared_utils/llm_gateway_env.py.
var gatewayEnv = map[string]string{
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME": gatewayHost + "/bedrock",
	// Uppercase only: gRPC reads just the lowercase names, so calls between replicas skip it.
	"HTTP_PROXY":  gatewayProxy,
	"HTTPS_PROXY": gatewayProxy,
	"NO_PROXY":    "127.0.0.1,localhost,169.254.169.254,169.254.170.2",
	// Clients trust the proxy's certificates.
	"SSL_CERT_FILE":      proxyCABundle,
	"REQUESTS_CA_BUNDLE": proxyCABundle,
	"AWS_CA_BUNDLE":      proxyCABundle,
}

// AgentSelector selects one agent's pods.
func AgentSelector(agent *canyonosv1alpha1.CanyonAgent) map[string]string {
	return map[string]string{LabelAgent: agent.Name}
}

func agentLabels(p *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent) map[string]string {
	labels := ProjectLabels(p, agent.Name)
	labels[LabelAgent] = agent.Name
	return labels
}

// AgentService is headless: it gives each replica a stable DNS name
// (helloagent-0.helloagent.<ns>.svc), the address routing and results use. A
// draining replica stays resolvable, so results still reach the calls it finishes.
func AgentService(p *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: agent.Name, Namespace: agent.Namespace, Labels: agentLabels(p, agent)},
		Spec: corev1.ServiceSpec{
			ClusterIP:                corev1.ClusterIPNone,
			PublishNotReadyAddresses: true,
			Selector:                 AgentSelector(agent),
			Ports: []corev1.ServicePort{{
				Name: portGRPC, Port: ReplicaPort(agent), TargetPort: intstr.FromInt32(ReplicaPort(agent)),
			}},
		},
	}
}

// AgentStatefulSet runs one pod per replica, each with a LocalController and the
// agent's code. StatefulSet: each replica keeps its name and address across
// restarts, and the highest number goes first on scale-down, as CanyonOS expects.
func AgentStatefulSet(p *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent) *appsv1.StatefulSet {
	labels := agentLabels(p, agent)
	probe := func(path string, period, failures int32) *corev1.Probe {
		return &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
				Path: path, Port: intstr.FromInt32(HealthPort),
			}},
			PeriodSeconds: period, FailureThreshold: failures, TimeoutSeconds: 3,
		}
	}

	pod := corev1.PodSpec{
		ServiceAccountName:            p.Spec.AgentServiceAccountName,
		AutomountServiceAccountToken:  new(false),
		ImagePullSecrets:              p.Spec.ImagePullSecrets,
		TerminationGracePeriodSeconds: agent.Spec.TerminationGracePeriodSeconds,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      new(int64(AgentUID)),
			RunAsGroup:     new(int64(0)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:    "agent",
			Image:   agent.Spec.Image,
			Env:     AgentEnv(p, agent),
			EnvFrom: appEnv(p),
			Ports: []corev1.ContainerPort{
				{Name: portGRPC, ContainerPort: AgentPort},
				{Name: portHealth, ContainerPort: HealthPort},
			},
			StartupProbe:   probe("/startupz", 5, 72),
			ReadinessProbe: probe("/readyz", 5, 2),
			LivenessProbe:  probe("/livez", 10, 6),
			Lifecycle:      preStopPause(agentPreStop(p)),
			Resources:      agent.Spec.Resources,
			// Not a read-only root: the agent is the customer's code and may write
			// where it runs. Everything else of the restricted profile applies.
			SecurityContext: &corev1.SecurityContext{
				AllowPrivilegeEscalation: new(false),
				Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{dropAll}},
			},
		}},
	}
	applyPlacement(&pod, agent.Spec.Placement)
	quickEviction(&pod)

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: agent.Name, Namespace: agent.Namespace, Labels: labels},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: agent.Name,
			Replicas:    agent.Spec.Replicas,
			// Replicas start and stop together, not one after another.
			PodManagementPolicy: appsv1.ParallelPodManagement,
			// The operator replaces pods itself, with a replica to spare (a surge update).
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.OnDeleteStatefulSetStrategyType},
			Selector:       &metav1.LabelSelector{MatchLabels: AgentSelector(agent)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec:       pod,
			},
		},
	}
}

// AgentEnv is the replica's side of the contract with the operator: its identity and
// address, its Redis, the project's settings, the LLM gateway, and the opt-ins for
// health checks and the SIGTERM drain. The agent's own env comes first, so it
// cannot override the platform's, as `-e` beats `--env-file` on Docker.
func AgentEnv(p *canyonosv1alpha1.CanyonProject, agent *canyonosv1alpha1.CanyonAgent) []corev1.EnvVar {
	grace := int64(120)
	if agent.Spec.TerminationGracePeriodSeconds != nil {
		grace = *agent.Spec.TerminationGracePeriodSeconds
	}
	// Kubernetes counts the grace period from the deletion, the preStop pause included;
	// the replica counts its drain from the SIGTERM that follows the pause.
	drain := max(grace-agentPreStop(p), 1)

	env := append([]corev1.EnvVar{}, agent.Spec.Env...)
	env = append(env,
		corev1.EnvVar{Name: "POD_NAME", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
		}},
		corev1.EnvVar{Name: "CANYONOS_AGENT_HOST", Value: "$(POD_NAME)." + agent.Name + "." + agent.Namespace + ".svc"},
		corev1.EnvVar{Name: "CANYONOS_AGENT_PORT", Value: strconv.Itoa(AgentPort)},
		pollIntervalEnv(p),
		logsEnabledEnv(p),
		corev1.EnvVar{Name: envHealthPort, Value: strconv.Itoa(HealthPort)},
		corev1.EnvVar{Name: "CANYONOS_SHUTDOWN_GRACE_SECONDS", Value: strconv.FormatInt(drain, 10)},
		corev1.EnvVar{Name: envHome, Value: tmpDir},
	)
	env = append(env, replicaIDEnv(agent.Spec.AgentName)...)
	env = append(env, RedisEnv(p)...)
	for _, name := range sortedKeys(gatewayEnv) {
		env = append(env, corev1.EnvVar{Name: name, Value: gatewayEnv[name]})
	}
	return env
}

// agentPreStop is how long a stopping replica keeps taking calls before its SIGTERM:
// until the other replicas reload routing without it.
func agentPreStop(p *canyonosv1alpha1.CanyonProject) int64 {
	return int64(pollInterval(p)) + 1
}

// pollIntervalEnv is how often a replica reports its metrics and reloads routing.
func pollIntervalEnv(p *canyonosv1alpha1.CanyonProject) corev1.EnvVar {
	return corev1.EnvVar{Name: "CANYONOS_POLL_INTERVAL", Value: strconv.Itoa(int(pollInterval(p)))}
}

// pollInterval is how often replicas report metrics and reload routing, in seconds.
func pollInterval(p *canyonosv1alpha1.CanyonProject) int32 {
	if p.Spec.PollIntervalSeconds < 1 {
		return 5 // the API's default; 0 would spin every replica's metrics loop
	}
	return p.Spec.PollIntervalSeconds
}

// replicaIDEnv names the replica as core does, <agent>-<slot> (HelloAgent-0), from the
// start: its slot is the pod's StatefulSet index, which Kubernetes labels each pod with.
func replicaIDEnv(agentName string) []corev1.EnvVar {
	return []corev1.EnvVar{
		{Name: "CANYONOS_REPLICA_INDEX", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.labels['" + appsv1.PodIndexLabel + "']"},
		}},
		{Name: "CANYONOS_REPLICA_ID", Value: agentName + "-$(CANYONOS_REPLICA_INDEX)"},
	}
}

// preStopPause keeps a stopping pod serving for `seconds` before its SIGTERM: those
// still sending to it (a Service's endpoints, an ingress controller, replicas with
// cached routing) learn it is gone a few seconds after it starts stopping.
func preStopPause(seconds int64) *corev1.Lifecycle {
	return &corev1.Lifecycle{PreStop: &corev1.LifecycleHandler{Sleep: &corev1.SleepAction{Seconds: seconds}}}
}

// logsEnabledEnv is whether a replica ships its logs.
func logsEnabledEnv(p *canyonosv1alpha1.CanyonProject) corev1.EnvVar {
	return corev1.EnvVar{Name: "CANYONOS_LOGS_ENABLED", Value: strconv.FormatBool(p.Spec.Logs == nil || *p.Spec.Logs)}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
