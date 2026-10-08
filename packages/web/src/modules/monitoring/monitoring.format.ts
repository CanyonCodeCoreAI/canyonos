export const formatTokens = (value: number | null) =>
  value === null ? '—' : value.toLocaleString();

export const formatCost = (value: number | null) => (value === null ? '—' : `$${value.toFixed(4)}`);
