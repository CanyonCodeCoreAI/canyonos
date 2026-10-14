// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useMatches } from '@tanstack/react-router';
import type { ComponentType } from 'react';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    headerSlot?: ComponentType;
    breadcrumbSlot?: ComponentType;
  }
}

function useDeepestSlot(key: 'headerSlot' | 'breadcrumbSlot'): ComponentType | undefined {
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const slot = matches[index]?.staticData[key];
    if (slot) return slot;
  }
  return undefined;
}

export function useHeaderSlot(): ComponentType | undefined {
  return useDeepestSlot('headerSlot');
}

export function useBreadcrumbSlot(): ComponentType | undefined {
  return useDeepestSlot('breadcrumbSlot');
}
