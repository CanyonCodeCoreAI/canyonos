import { createFileRoute, Outlet, useMatches } from '@tanstack/react-router';

import { AuthLayout } from '@/modules/auth/components/AuthLayout';

export const Route = createFileRoute('/_brand')({ component: BrandLayout });

function BrandLayout() {
  const brand = useMatches({ select: (matches) => matches[matches.length - 1]?.staticData.brand });

  if (!brand) return <Outlet />;

  return (
    <AuthLayout brand={brand}>
      <Outlet />
    </AuthLayout>
  );
}
