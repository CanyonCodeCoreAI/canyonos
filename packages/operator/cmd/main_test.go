/*
SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
SPDX-License-Identifier: AGPL-3.0-only
*/

package main

import (
	"maps"
	"slices"
	"testing"
)

func TestWatchNamespacesLimitTheCacheOrLeaveItClusterWide(t *testing.T) {
	if got := namespaceConfigs(""); got != nil {
		t.Errorf("empty: want every namespace (nil), got %v", got)
	}
	got := slices.Sorted(maps.Keys(namespaceConfigs(" team-a, team-b ,,")))
	if !slices.Equal(got, []string{"team-a", "team-b"}) {
		t.Errorf("got %v", got)
	}
}

func TestRegistryAliasesAreRepeatablePullEqualsPush(t *testing.T) {
	aliases := aliasFlag{}
	if err := aliases.Set("localhost:5001=kind-registry:5000"); err != nil {
		t.Fatal(err)
	}
	if aliases["localhost:5001"] != "kind-registry:5000" {
		t.Errorf("got %v", aliases)
	}
	if aliases.Set("no-equals") == nil {
		t.Error("an alias without = must be refused")
	}
}
