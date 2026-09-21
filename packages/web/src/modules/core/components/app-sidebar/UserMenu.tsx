import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Building2Icon,
  ChevronsUpDownIcon,
  LogOutIcon,
  RefreshCwIcon,
  UserIcon,
} from 'lucide-react';

import type { Company } from '@cc-forge/api/companies';

import { Avatar, AvatarFallback } from '@repo/ui/shadcn/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/shadcn/dropdown-menu';
import { SidebarSeparator } from '@repo/ui/shadcn/sidebar';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { authSelectors, useAuthStore } from '@/modules/auth/auth.store';

export function UserMenu() {
  const navigate = useNavigate();
  const user = useAuthStore(authSelectors.user);
  const companyId = user?.company_id;
  const {
    data: company,
    isPending: isCompanyPending,
    isError: isCompanyError,
    refetch: refetchCompany,
  } = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => {
      if (!companyId) throw new Error('Company ID is missing');
      return apiCall<Company>(() => forgeAuthApi.companies[companyId]!.get());
    },
    enabled: Boolean(companyId),
    staleTime: 5 * 60 * 1000,
  });

  if (!user) return null;

  const displayName = user.name?.trim() || user.email;
  const initials = (user.name || user.email)
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  let companyLabel = company?.name ?? 'Company unavailable';
  if (!companyId) companyLabel = 'No company linked';
  else if (isCompanyPending) companyLabel = 'Loading company…';
  else if (isCompanyError) companyLabel = 'Unable to load company';

  const logout = () => {
    useAuthStore.getState().logout();
    void navigate({ to: '/login' });
  };

  return (
    <DropdownMenu>
      <SidebarSeparator className="mb-2" />
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          data-testid="sidebar-user-menu"
          className={cn(
            'app-sidebar-collapse-to-icon',
            'flex min-h-11 w-full items-center gap-2.5 rounded-[0.5625rem] px-2 py-1.5 text-left transition-[background-color,transform] duration-150',
            'hover:bg-foreground/[0.035] focus-visible:outline-none active:scale-[0.985]'
          )}
        >
          <Avatar>
            <AvatarFallback>{initials || <UserIcon className="size-4" />}</AvatarFallback>
          </Avatar>
          <span className="app-sidebar-hide-when-collapsed min-w-0 flex-1">
            <span className="text-foreground block truncate text-[0.8125rem] font-semibold">
              {displayName}
            </span>
            {user.name ? (
              <span className="text-muted-foreground block truncate text-[0.6875rem]">
                {user.email}
              </span>
            ) : null}
          </span>
          <ChevronsUpDownIcon
            className="app-sidebar-hide-when-collapsed text-muted-foreground size-3.5 shrink-0"
            strokeWidth={2.4}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg"
        data-testid="sidebar-user-menu-content"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-2">
            <Avatar>
              <AvatarFallback>{initials || <UserIcon className="size-4" />}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{displayName}</p>
              <p className="text-muted-foreground truncate text-xs">{user.email}</p>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel
            className="text-muted-foreground flex items-center gap-2 text-xs font-normal"
            data-testid="sidebar-company"
          >
            <Building2Icon className="size-3.5" />
            {companyLabel}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {isCompanyError ? (
          <DropdownMenuItem onSelect={() => void refetchCompany()}>
            <RefreshCwIcon />
            Retry company lookup
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} variant="destructive" data-testid="sidebar-logout">
          <LogOutIcon />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
