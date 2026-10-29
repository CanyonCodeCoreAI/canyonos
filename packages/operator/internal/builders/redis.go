/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package builders

import (
	"fmt"
	"slices"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	RedisName        = "canyonos-redis"
	RedisPort        = 6379
	RedisImage       = "redis:7.4-alpine"
	RedisPasswordKey = "password"
	RedisConfigKey   = "redis.conf"
	// ConfigHashAnnotation on Redis's pod template is the SecretVersion of its config's
	// Secret, so a new password (the Secret deleted to rotate it) rolls the pod.
	ConfigHashAnnotation = "canyonos.canyoncode.ai/config-hash"
	// RedisLoginAnnotation on the pod template of every pod that signs in to the
	// project's Redis is the SecretVersion of the Secret with the password: their
	// environment holds it, so a rotated password must restart them too, not only Redis.
	RedisLoginAnnotation = "canyonos.canyoncode.ai/redis-login"

	redisUID       = 999     // the redis image's own user
	redisContainer = "redis" // container and port name

	volumeConfig = "config"
	volumeData   = "data"
	// tmpDir is HOME and scratch space for non-root CanyonOS processes.
	tmpDir        = "/tmp"
	redisDataPath = "/data"
	redisConfPath = "/etc/redis"
)

// RedisAddress is where the project's pods reach its internal Redis, independent
// of the cluster's DNS domain.
func RedisAddress(p *canyonosv1alpha1.CanyonProject) string {
	return fmt.Sprintf("%s.%s.svc:%d", RedisName, p.Namespace, RedisPort)
}

// RedisHostPort is the Redis the project's pods use, internal or external.
func RedisHostPort(p *canyonosv1alpha1.CanyonProject) (string, int32) {
	if p.Spec.Redis.Mode == "external" {
		return p.Spec.Redis.Host, p.Spec.Redis.Port
	}
	return fmt.Sprintf("%s.%s.svc", RedisName, p.Namespace), RedisPort
}

// RedisSelector selects the project's Redis pod.
func RedisSelector(p *canyonosv1alpha1.CanyonProject) map[string]string {
	return map[string]string{LabelName: RedisName, LabelProject: p.Name}
}

// RedisConfig is redis.conf: the password comes from this file, never a command
// line; AOF on its disk; and noeviction, since futures and routing must never be
// dropped to make room.
func RedisConfig(password string) string {
	return fmt.Sprintf(
		"requirepass %s\nappendonly yes\ndir %s\nmaxmemory-policy noeviction\n",
		password, redisDataPath,
	)
}

// SecretVersion names one version of a Secret: a new Secret (the old one deleted to
// rotate a password) or any change to it gets a new one. Taken from its metadata,
// never its contents: an annotation is readable by anyone who may view the
// workload, and a hash of a password would let them test guesses offline.
func SecretVersion(secret *corev1.Secret) string {
	return string(secret.UID) + "." + secret.ResourceVersion
}

// StampRedisLogin marks a pod template with the SecretVersion of the Redis login its
// pods use (RedisLoginAnnotation); nothing when login is empty.
func StampRedisLogin(template *corev1.PodTemplateSpec, login string) {
	if login == "" {
		return
	}
	if template.Annotations == nil {
		template.Annotations = map[string]string{}
	}
	template.Annotations[RedisLoginAnnotation] = login
}

// RedisSecret holds the generated password (for clients, as `password`) and the
// redis.conf that sets it.
func RedisSecret(p *canyonosv1alpha1.CanyonProject, password string) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      RedisName,
			Namespace: p.Namespace,
			Labels:    ProjectLabels(p, RedisName),
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			RedisPasswordKey: []byte(password),
			RedisConfigKey:   []byte(RedisConfig(password)),
		},
	}
}

// RedisStatefulSet runs one Redis pod with its data on a persistent volume, under
// the restricted Pod Security profile.
func RedisStatefulSet(p *canyonosv1alpha1.CanyonProject, image, secretVersion string) *appsv1.StatefulSet {
	labels := ProjectLabels(p, RedisName)
	ping := &corev1.ExecAction{Command: []string{"redis-cli", "ping"}}

	volumeClaim := corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: volumeData, Labels: labels},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: p.Spec.Redis.StorageClassName,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: redisStorage(p)},
			},
		},
	}

	pod := corev1.PodSpec{
		AutomountServiceAccountToken: new(false),
		ImagePullSecrets:             p.Spec.ImagePullSecrets,
		SecurityContext: &corev1.PodSecurityContext{
			RunAsNonRoot:   new(true),
			RunAsUser:      new(int64(redisUID)),
			RunAsGroup:     new(int64(redisUID)),
			FSGroup:        new(int64(redisUID)),
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
		Containers: []corev1.Container{{
			Name:  redisContainer,
			Image: image,
			Args:  []string{"redis-server", redisConfPath + "/" + RedisConfigKey},
			Ports: []corev1.ContainerPort{{Name: redisContainer, ContainerPort: RedisPort}},
			// redis-cli reads the password from REDISCLI_AUTH, so the probes never
			// put it on a command line.
			Env: []corev1.EnvVar{{
				Name: "REDISCLI_AUTH",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: RedisName},
					Key:                  RedisPasswordKey,
				}},
			}},
			VolumeMounts: []corev1.VolumeMount{
				{Name: volumeData, MountPath: redisDataPath},
				{Name: volumeConfig, MountPath: redisConfPath, ReadOnly: true},
			},
			ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{Exec: ping}, PeriodSeconds: 5},
			LivenessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{Exec: ping}, PeriodSeconds: 10, FailureThreshold: 6,
			},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("100m"),
					corev1.ResourceMemory: resource.MustParse("128Mi"),
				},
				Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("512Mi")},
			},
			SecurityContext: restrictedContainer(),
		}},
		Volumes: []corev1.Volume{{
			Name: volumeConfig,
			VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
				SecretName: RedisName,
				Items:      []corev1.KeyToPath{{Key: RedisConfigKey, Path: RedisConfigKey}},
			}},
		}},
	}
	applyPlacement(&pod, p.Spec.Placement)

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: RedisName, Namespace: p.Namespace, Labels: labels},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: RedisName,
			Replicas:    new(int32(1)),
			Selector:    &metav1.LabelSelector{MatchLabels: RedisSelector(p)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      labels,
					Annotations: map[string]string{ConfigHashAnnotation: secretVersion},
				},
				Spec: pod,
			},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{volumeClaim},
			// Redis's disk goes with the project; Kubernetes otherwise keeps it forever.
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.DeletePersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
		},
	}
}

// RedisService is the project's stable address for its Redis.
func RedisService(p *canyonosv1alpha1.CanyonProject) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name: RedisName, Namespace: p.Namespace, Labels: ProjectLabels(p, RedisName),
		},
		Spec: corev1.ServiceSpec{
			Selector: RedisSelector(p),
			Ports: []corev1.ServicePort{{
				Name: redisContainer, Port: RedisPort, TargetPort: intstr.FromString(redisContainer),
			}},
		},
	}
}

// RedisNetworkPolicy admits only the project's own pods, the operator, and the
// cluster dashboard's API (when there is one) to its Redis.
func RedisNetworkPolicy(
	p *canyonosv1alpha1.CanyonProject, operatorNamespace, dashboardNamespace string,
) *networkingv1.NetworkPolicy {
	peers := []networkingv1.NetworkPolicyPeer{
		{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{LabelProject: p.Name}}},
		namespacePeer(operatorNamespace),
	}
	if dashboardNamespace != "" {
		peers = append(peers, dashboardAPIPeer(dashboardNamespace))
	}
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name: RedisName, Namespace: p.Namespace, Labels: ProjectLabels(p, RedisName),
		},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: RedisSelector(p)},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: peers,
				Ports: []networkingv1.NetworkPolicyPort{{
					Protocol: new(corev1.ProtocolTCP),
					Port:     new(intstr.FromInt32(RedisPort)),
				}},
			}},
		},
	}
}

func redisStorage(p *canyonosv1alpha1.CanyonProject) resource.Quantity {
	if p.Spec.Redis.Storage != nil {
		return *p.Spec.Redis.Storage
	}
	return resource.MustParse("1Gi")
}

func namespacePeer(namespace string) networkingv1.NetworkPolicyPeer {
	return networkingv1.NetworkPolicyPeer{NamespaceSelector: &metav1.LabelSelector{
		MatchLabels: map[string]string{"kubernetes.io/metadata.name": namespace},
	}}
}

// restrictedContainer meets the restricted Pod Security profile.
func restrictedContainer() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: new(false),
		ReadOnlyRootFilesystem:   new(true),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{dropAll}},
	}
}

// evictionSeconds is how long a stateless CanyonOS pod stays on a node that stopped
// answering before Kubernetes evicts it (its default is 300 s).
const evictionSeconds = 30

// quickEviction lets a stateless pod (agents, the endpoint, the global controller)
// leave a lost node after 30 s instead of five minutes, unless the project's
// placement already says how long it tolerates that.
func quickEviction(pod *corev1.PodSpec) {
	for _, key := range []string{corev1.TaintNodeNotReady, corev1.TaintNodeUnreachable} {
		if slices.ContainsFunc(pod.Tolerations, func(t corev1.Toleration) bool { return t.Key == key }) {
			continue
		}
		pod.Tolerations = append(pod.Tolerations, corev1.Toleration{
			Key: key, Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoExecute,
			TolerationSeconds: new(int64(evictionSeconds)),
		})
	}
}

func applyPlacement(pod *corev1.PodSpec, placement *canyonosv1alpha1.Placement) {
	if placement == nil {
		return
	}
	pod.NodeSelector = placement.NodeSelector
	pod.Tolerations = placement.Tolerations
	pod.Affinity = placement.Affinity
}
