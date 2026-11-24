// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDownIcon, KeyRoundIcon, LogOutIcon } from 'lucide-react';

import { Avatar, AvatarFallback } from '@repo/ui/shadcn/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/shadcn/dropdown-menu';
import { SidebarSeparator } from '@repo/ui/shadcn/sidebar';
import { cn } from '@repo/ui/utils';
import { authSelectors, useAuthStore } from '@/modules/auth/auth.store';

export function UserMenu() {
  const navigate = useNavigate();
  const signedIn = useAuthStore(authSelectors.signedIn);
  if (!signedIn) return null;

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
            'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-[background-color,transform] duration-150',
            'hover:bg-foreground/[0.035] focus-visible:outline-none active:scale-[0.985]'
          )}
        >
          <KeyAvatar />
          <span className="app-sidebar-hide-when-collapsed min-w-0 flex-1">
            <span className="text-foreground block truncate text-[0.8125rem] font-semibold">
              API key
            </span>
            <span className="text-muted-foreground block truncate text-xs">Signed in</span>
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
            <KeyAvatar />
            <p className="min-w-0 truncate text-sm font-medium" data-testid="sidebar-signed-in">
              Signed in with an API key
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} variant="destructive" data-testid="sidebar-logout">
          <LogOutIcon />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KeyAvatar() {
  return (
    <Avatar>
      <AvatarFallback>
        <KeyRoundIcon className="size-4" aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}
