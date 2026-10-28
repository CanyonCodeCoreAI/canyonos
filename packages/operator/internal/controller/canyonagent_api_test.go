/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package controller

import (
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	canyonosv1alpha1 "github.com/CanyonCodeCoreAI/canyonos-internal/packages/operator/api/v1alpha1"
)

const testAgentImage = "localhost:5001/canyonos-helloworld-helloagent@sha256:" +
	"0000000000000000000000000000000000000000000000000000000000000000"

// validAgent is the smallest CanyonAgent the API server accepts.
func validAgent(name string) *canyonosv1alpha1.CanyonAgent {
	return &canyonosv1alpha1.CanyonAgent{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: canyonosv1alpha1.CanyonAgentSpec{
			ProjectRef: testProjectName,
			AgentName:  "HelloAgent",
			Image:      testAgentImage,
		},
	}
}

var _ = Describe("CanyonAgent API", func() {
	var name string
	var counter int

	BeforeEach(func() {
		counter++
		name = fmt.Sprintf("agent-api-%d", counter)
	})
	AfterEach(func() {
		_ = k8sClient.Delete(ctx, &canyonosv1alpha1.CanyonAgent{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		})
	})

	It("fills in the defaults", func() {
		Expect(k8sClient.Create(ctx, validAgent(name))).To(Succeed())
		created := &canyonosv1alpha1.CanyonAgent{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, created)).To(Succeed())
		Expect(created.Spec.Type).To(Equal("agent"))
		Expect(*created.Spec.Replicas).To(Equal(int32(1)))
		Expect(*created.Spec.TerminationGracePeriodSeconds).To(Equal(int64(120)))
	})

	It("changes the replica count through /scale, as the global controller does", func() {
		agent := validAgent(name)
		Expect(k8sClient.Create(ctx, agent)).To(Succeed())

		scale := &autoscalingv1.Scale{}
		Expect(k8sClient.SubResource("scale").Get(ctx, agent, scale)).To(Succeed())
		scale.Spec.Replicas = 3
		Expect(k8sClient.SubResource("scale").Update(ctx, agent, client.WithSubResourceBody(scale))).To(Succeed())

		updated := &canyonosv1alpha1.CanyonAgent{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, updated)).To(Succeed())
		Expect(*updated.Spec.Replicas).To(Equal(int32(3)))
	})

	It("needs database settings for, and only for, a database", func() {
		database := validAgent(name)
		database.Spec.Type = "database"
		Expect(k8sClient.Create(ctx, database)).To(MatchError(ContainSubstring("only for, type database")))

		database.Spec.Database = &canyonosv1alpha1.DatabaseSpec{Port: 5432, MountPath: testDatabaseMount}
		Expect(k8sClient.Create(ctx, database)).To(Succeed())

		agent := validAgent(name + "-x")
		agent.Spec.Database = &canyonosv1alpha1.DatabaseSpec{Port: 5432, MountPath: "/data"}
		Expect(k8sClient.Create(ctx, agent)).NotTo(Succeed())
	})

	It("keeps the agent name, project and type from changing", func() {
		Expect(k8sClient.Create(ctx, validAgent(name))).To(Succeed())
		for field, mutate := range map[string]func(*canyonosv1alpha1.CanyonAgent){
			"agentName":  func(a *canyonosv1alpha1.CanyonAgent) { a.Spec.AgentName = "Other" },
			"projectRef": func(a *canyonosv1alpha1.CanyonAgent) { a.Spec.ProjectRef = "other" },
		} {
			agent := &canyonosv1alpha1.CanyonAgent{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, agent)).To(Succeed())
			mutate(agent)
			Expect(k8sClient.Update(ctx, agent)).To(MatchError(ContainSubstring(field + " cannot change")))
		}
	})

	It("refuses a negative replica count and a too short grace period", func() {
		agent := validAgent(name)
		agent.Spec.Replicas = new(int32(-1))
		Expect(k8sClient.Create(ctx, agent)).NotTo(Succeed())

		agent = validAgent(name)
		agent.Spec.TerminationGracePeriodSeconds = new(int64(5))
		Expect(k8sClient.Create(ctx, agent)).NotTo(Succeed())
	})
})
