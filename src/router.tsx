import { Link, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";

function DefaultErrorComponent({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-foreground">
          Une erreur est survenue
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || "Erreur inattendue"}
        </p>

        <button
          onClick={reset}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}

function DefaultNotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-foreground">Page introuvable</h1>

        <p className="mt-2 text-sm text-muted-foreground">
          La route demandee ne correspond a aucune page de l'application.
        </p>

        <Link
          to="/"
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Retour au dashboard
        </Link>
      </div>
    </div>
  );
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

const basepath =
  import.meta.env.BASE_URL && import.meta.env.BASE_URL !== "/"
    ? import.meta.env.BASE_URL.replace(/\/$/, "")
    : undefined;

import type { AuthContextType } from "@/contexts/AuthContext";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
    auth: { session: null, user: null, signOut: async () => {} } satisfies AuthContextType,
  },
  basepath,
  scrollRestoration: true,
  defaultErrorComponent: DefaultErrorComponent,
  defaultNotFoundComponent: DefaultNotFoundComponent,
});