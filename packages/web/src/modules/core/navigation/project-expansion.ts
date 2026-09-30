export interface ProjectExpansionState {
  readonly is_open: boolean;
  readonly is_active: boolean;
}

export type ProjectExpansionEvent =
  | { readonly type: 'activation_changed'; readonly is_active: boolean }
  | { readonly type: 'open_changed'; readonly is_open: boolean };

export function createProjectExpansionState(is_active: boolean): ProjectExpansionState {
  return { is_open: is_active, is_active };
}

export function reduceProjectExpansion(
  state: ProjectExpansionState,
  event: ProjectExpansionEvent
): ProjectExpansionState {
  if (event.type === 'open_changed') {
    return { ...state, is_open: event.is_open };
  }

  if (event.is_active === state.is_active) return state;
  return {
    is_active: event.is_active,
    is_open: event.is_active ? true : state.is_open,
  };
}
