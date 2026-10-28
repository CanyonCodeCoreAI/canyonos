/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const (
	testNamespace   = "default"
	testProjectID   = "4eeed6f3-1c2b-4c1d-9d8e-0a1b2c3d4e5f"
	testProjectName = "acme"
	testAgentName   = "helloagent"
)

// validProject is the smallest CanyonProject the API server accepts.
func validProject(name string) *canyonosv1alpha1.CanyonProject {
	return &canyonosv1alpha1.CanyonProject{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: canyonosv1alpha1.CanyonProjectSpec{
			ProjectID: testProjectID,
			ConfigRef: "canyonos-config",
			Endpoint:  canyonosv1alpha1.EndpointSpec{Agent: "Workflow", Method: "main"},
		},
	}
}

// The CRD's validation runs in the API server, before any operator code; these
// tests run against a real one (envtest).
var _ = Describe("CanyonProject API", func() {
	var name string
	var counter int

	BeforeEach(func() {
		counter++
		name = fmt.Sprintf("api-%d", counter)
	})

	AfterEach(func() {
		_ = k8sClient.Delete(ctx, &canyonosv1alpha1.CanyonProject{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		})
	})

	It("fills in the defaults", func() {
		Expect(k8sClient.Create(ctx, validProject(name))).To(Succeed())

		created := &canyonosv1alpha1.CanyonProject{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, created)).To(Succeed())
		Expect(created.Spec.Redis.Mode).To(Equal("internal"))
		Expect(created.Spec.Redis.Port).To(Equal(int32(6379)))
		Expect(created.Spec.Redis.Storage.Cmp(resource.MustParse("1Gi"))).To(Equal(0))
		Expect(created.Spec.PollIntervalSeconds).To(Equal(int32(5)))
		Expect(*created.Spec.Logs).To(BeTrue())
	})

	It("refuses a project id that is not a UUID", func() {
		project := validProject(name)
		project.Spec.ProjectID = "my-project"
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
	})

	It("keeps the project id from ever changing", func() {
		Expect(k8sClient.Create(ctx, validProject(name))).To(Succeed())
		created := &canyonosv1alpha1.CanyonProject{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, created)).To(Succeed())

		created.Spec.ProjectID = "11111111-2222-3333-4444-555555555555"
		err := k8sClient.Update(ctx, created)
		Expect(err).To(MatchError(ContainSubstring("projectID cannot change")))
	})

	It("needs a host for an external Redis", func() {
		project := validProject(name)
		project.Spec.Redis.Mode = redisExternal
		err := k8sClient.Create(ctx, project)
		Expect(err).To(MatchError(ContainSubstring("an external Redis needs a host")))

		project.Spec.Redis.Host = testExternalRedisHost
		Expect(k8sClient.Create(ctx, project)).To(Succeed())
	})

	It("refuses an unknown Redis mode", func() {
		project := validProject(name)
		project.Spec.Redis.Mode = "sidecar"
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
	})

	It("needs the endpoint's agent and method", func() {
		project := validProject(name)
		project.Spec.Endpoint.Method = ""
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
	})

	It("takes an endpoint host and URL only in their own shape", func() {
		project := validProject(name)
		project.Spec.Endpoint.Ingress = &canyonosv1alpha1.EndpointIngress{Host: "Acme.Example.com"}
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
		project.Spec.Endpoint.Ingress.Host = "acme.apps.example.com"
		project.Spec.Endpoint.URL = "acme.example.com/run"
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
		project.Spec.Endpoint.URL = "https://acme.example.com/api"
		Expect(k8sClient.Create(ctx, project)).To(Succeed())
	})

	It("keeps the poll interval between 1 s and an hour", func() {
		project := validProject(name)
		project.Spec.PollIntervalSeconds = 7200
		Expect(k8sClient.Create(ctx, project)).NotTo(Succeed())
	})
})
