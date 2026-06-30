import { createRootRouteWithContext, Outlet, redirect, useLocation } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AppLayout } from "@/components/AppLayout";
import type { AuthContextType } from "@/contexts/AuthContext";

const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/legal/cgu", "/legal/privacy"];

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  auth: AuthContextType;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Coffret ERP — Gestion production" },
    ],
  }),
  beforeLoad: ({ context, location }) => {
    const isPublic = PUBLIC_PATHS.includes(location.pathname);
    if (!context.auth.session && !isPublic) {
      throw redirect({ to: "/login" });
    }
    if (context.auth.session && location.pathname === "/login") {
      throw redirect({ to: "/" });
    }
  },
  component: RootComponent,
});

function RootComponent() {
  // useLocation() from TanStack Router is reactive — updates synchronously when
  // navigate() is called, unlike window.location.pathname which only reflects
  // the browser's URL and causes sidebar flicker on login/logout.
  const { pathname } = useLocation();
  const isPublicPath = PUBLIC_PATHS.some((p) => pathname === p);

  if (isPublicPath) {
    return (
      <>
        <Outlet />
        <Toaster richColors position="top-right" />
      </>
    );
  }

  return (
    <>
      <AppLayout />
      <Toaster richColors position="top-right" />
    </>
  );
}
