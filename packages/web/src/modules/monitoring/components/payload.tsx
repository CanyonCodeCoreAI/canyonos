export function Payload({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="mb-3">
      <div className="text-muted-foreground mb-1">{label}</div>
      <pre className="text-foreground break-words whitespace-pre-wrap">{value}</pre>
    </div>
  );
}
