/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package v1alpha1

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// testdata/rendered.json is what core renders for sample projects that use every
// setting (packages/core/tests/kubernetes_contract.py rendered). Decoding it with
// unknown fields refused catches a field core sets that these types lack, or a value
// of the wrong type, before a cluster would.
func TestCoresRenderedObjectsFitTheseTypes(t *testing.T) {
	raw, err := os.ReadFile("testdata/rendered.json")
	if err != nil {
		t.Fatal(err)
	}
	var samples map[string][]json.RawMessage
	if err := json.Unmarshal(raw, &samples); err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for sample, objects := range samples {
		for _, object := range objects {
			var meta struct {
				Kind string `json:"kind"`
			}
			if err := json.Unmarshal(object, &meta); err != nil {
				t.Fatal(err)
			}
			var into any
			switch meta.Kind {
			case "CanyonProject":
				into = &CanyonProject{}
			case "CanyonAgent":
				into = &CanyonAgent{}
			case "ConfigMap":
				into = &corev1.ConfigMap{}
			default:
				t.Errorf("%s: core rendered a %q, which nothing here checks", sample, meta.Kind)
				continue
			}
			decoder := json.NewDecoder(bytes.NewReader(object))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(into); err != nil {
				t.Errorf("%s: core's %s does not fit the Go type: %v", sample, meta.Kind, err)
			}
			seen[meta.Kind]++
		}
	}
	if seen["CanyonProject"] == 0 || seen["CanyonAgent"] == 0 {
		t.Fatalf("testdata/rendered.json has nothing to check: %v", seen)
	}
}
