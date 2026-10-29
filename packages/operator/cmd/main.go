/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"os"
	"strings"

	// Import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, etc.)
	// to ensure that exec-entrypoint and run can make use of them.
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/builders"
	"github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(canyonosv1alpha1.AddToScheme(scheme))
}

func main() {
	var metricsAddr, metricsCertPath, metricsCertName, metricsCertKey string
	var probeAddr, controllerImage, redisImage, watchNamespaces, builderAddress, dashboardNamespace string
	var canyonosVersion string
	registryAliases := aliasFlag{}
	var enableLeaderElection, secureMetrics, enableHTTP2 bool
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate; empty for a self-signed one.")
	flag.StringVar(&metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&enableHTTP2, "enable-http2", false, "If set, HTTP/2 will be enabled for the metrics server")
	flag.StringVar(&controllerImage, "controller-image", "",
		"The canyonos-core image matching this operator's release, pinned (required).")
	flag.StringVar(&canyonosVersion, "canyonos-version", "",
		"The CanyonOS release this operator belongs to (the chart's appVersion), reported on "+
			"each CanyonBuild so the CLI can check it matches its own.")
	flag.StringVar(&redisImage, "redis-image", builders.RedisImage,
		"Image for internal Redis, e.g. from a registry mirror.")
	flag.StringVar(&builderAddress, "builder-address", "",
		"The cluster's BuildKit for in-cluster builds (tcp://buildkitd.canyonos-build.svc:1234); empty for none.")
	flag.Var(registryAliases, "registry-alias",
		"pull=push: a registry the builder reaches by another name than nodes pull it by (repeatable).")
	flag.StringVar(&dashboardNamespace, "dashboard-namespace", "",
		"Namespace of the cluster's CanyonOS dashboard, which lists every project and takes its telemetry; "+
			"empty for none.")
	flag.StringVar(&watchNamespaces, "watch-namespaces", "",
		"Comma-separated namespaces to run projects in, for an install granted only those; empty for all.")
	// Production logging by default; --zap-devel switches to development logs.
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	if controllerImage == "" {
		setupLog.Error(nil, "--controller-image is required: the canyonos-core image of this release")
		os.Exit(1)
	}

	// HTTP/2 stays off unless asked for: it is exposed to the HTTP/2 Stream
	// Cancellation and Rapid Reset CVEs (GHSA-qppj-fm5r-hxr3, GHSA-4374-p667-p6c8).
	var tlsOpts []func(*tls.Config)
	if !enableHTTP2 {
		tlsOpts = append(tlsOpts, func(c *tls.Config) {
			setupLog.Info("Disabling HTTP/2")
			c.NextProtos = []string{"http/1.1"}
		})
	}

	metricsServerOptions := metricsserver.Options{
		BindAddress:   metricsAddr,
		SecureServing: secureMetrics,
		TLSOpts:       tlsOpts,
	}
	if secureMetrics {
		// Only callers allowed by Kubernetes RBAC may read the metrics endpoint.
		metricsServerOptions.FilterProvider = filters.WithAuthenticationAndAuthorization
	}
	if len(metricsCertPath) > 0 {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", metricsCertPath, "metrics-cert-name", metricsCertName, "metrics-cert-key", metricsCertKey)

		metricsServerOptions.CertDir = metricsCertPath
		metricsServerOptions.CertName = metricsCertName
		metricsServerOptions.KeyName = metricsCertKey
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		// Never cache Secrets: a cache lists and watches every Secret the operator
		// may read. Reads of a Secret go to the API server, by name.
		Client: client.Options{Cache: &client.CacheOptions{
			DisableFor: []client.Object{&corev1.Secret{}},
		}},
		Cache: cache.Options{
			// Only the namespaces this install may use, when it is limited to some.
			DefaultNamespaces: namespaceConfigs(watchNamespaces),
			// Watch only the pods the operator runs, never the rest of the cluster's.
			ByObject: map[client.Object]cache.ByObject{
				&corev1.Pod{}: {Label: labels.SelectorFromSet(labels.Set{builders.LabelManagedBy: builders.ManagedBy})},
			},
		},
		Metrics:                metricsServerOptions,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "72a93284.canyoncode.ai",
	})
	if err != nil {
		setupLog.Error(err, "Failed to start manager")
		os.Exit(1)
	}

	// One client per project's Redis, shared by the controllers.
	projectRedis := &controller.ProjectRedis{Reader: mgr.GetAPIReader()}
	if err := (&controller.CanyonProjectReconciler{
		Client:             mgr.GetClient(),
		Scheme:             mgr.GetScheme(),
		APIReader:          mgr.GetAPIReader(),
		OperatorNamespace:  operatorNamespace(),
		DashboardNamespace: dashboardNamespace,
		RedisImage:         redisImage,
		ControllerImage:    controllerImage,
		RedisFor:           projectRedis.For,
		RedisLogin:         projectRedis.Login,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "canyonproject")
		os.Exit(1)
	}
	if err := (&controller.CanyonAgentReconciler{
		Client:     mgr.GetClient(),
		Scheme:     mgr.GetScheme(),
		RedisFor:   projectRedis.For,
		RedisLogin: projectRedis.Login,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "canyonagent")
		os.Exit(1)
	}
	if err := (&controller.CanyonBuildReconciler{
		Client:          mgr.GetClient(),
		Scheme:          mgr.GetScheme(),
		ControllerImage: controllerImage,
		BuilderAddress:  builderAddress,
		RegistryAliases: registryAliases,
		Version:         canyonosVersion,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "canyonbuild")
		os.Exit(1)
	}
	if dashboardNamespace != "" {
		if err := (&controller.DashboardRegistryReconciler{
			Client:    mgr.GetClient(),
			APIReader: mgr.GetAPIReader(),
			Redis:     projectRedis,
			Namespace: dashboardNamespace,
		}).SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "Failed to create controller", "controller", "dashboardregistry")
			os.Exit(1)
		}
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}

// operatorNamespace is the namespace the operator runs in (POD_NAMESPACE, from the
// downward API), which every project's Redis admits.
func operatorNamespace() string {
	if namespace := os.Getenv("POD_NAMESPACE"); namespace != "" {
		return namespace
	}
	return "canyonos-system"
}

// namespaceConfigs turns --watch-namespaces into the cache's namespaces: nil (every
// namespace) when empty.
func namespaceConfigs(list string) map[string]cache.Config {
	var namespaces map[string]cache.Config
	for namespace := range strings.SplitSeq(list, ",") {
		if namespace = strings.TrimSpace(namespace); namespace != "" {
			if namespaces == nil {
				namespaces = map[string]cache.Config{}
			}
			namespaces[namespace] = cache.Config{}
		}
	}
	return namespaces
}

// aliasFlag collects repeated --registry-alias pull=push flags.
type aliasFlag map[string]string

func (a aliasFlag) String() string { return fmt.Sprint(map[string]string(a)) }

func (a aliasFlag) Set(value string) error {
	pull, push, ok := strings.Cut(value, "=")
	if !ok || pull == "" || push == "" {
		return fmt.Errorf("want pull=push, got %q", value)
	}
	a[pull] = push
	return nil
}
