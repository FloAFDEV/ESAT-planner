import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Eye, EyeOff, Lock, Mail, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Connexion — Coffret ERP" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: LoginPage,
});

type LoginForm = { email: string; password: string };

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [showPwd, setShowPwd] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>();

  const onSubmit = async (values: LoginForm) => {
    if (attempts >= 5) {
      setAuthError("Trop de tentatives. Veuillez patienter quelques minutes.");
      return;
    }
    setAuthError(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: values.email.trim().toLowerCase(),
      password: values.password,
    });

    if (error) {
      setAttempts((n) => n + 1);
      setAuthError(
        error.message === "Invalid login credentials"
          ? "Email ou mot de passe incorrect."
          : error.message === "Email not confirmed"
          ? "Veuillez confirmer votre adresse email avant de vous connecter."
          : "Une erreur est survenue. Réessayez."
      );
      return;
    }

    await router.invalidate();
    navigate({ to: "/" });
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="p-2 bg-white rounded-2xl shadow-md border border-border">
            <img src={agecetLogo} alt="ESAT AGECET" className="h-14 w-14 rounded-xl object-contain" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-foreground">Coffret ERP</h1>
            <p className="text-sm text-muted-foreground mt-0.5">ESAT AGECET · Espace administration</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-5">
          <h2 className="text-base font-semibold text-foreground">Connexion</h2>

          {authError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Adresse email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="admin@exemple.fr"
                  className="pl-9"
                  aria-invalid={!!errors.email}
                  {...register("email", {
                    required: "L'adresse email est requise.",
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                      message: "Adresse email invalide.",
                    },
                  })}
                />
              </div>
              {errors.email && (
                <p className="text-xs text-destructive">{errors.email.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Mot de passe</Label>
                <a
                  href="/forgot-password"
                  className="text-xs text-accent hover:underline"
                  tabIndex={-1}
                >
                  Mot de passe oublié ?
                </a>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="password"
                  type={showPwd ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="pl-9 pr-10"
                  aria-invalid={!!errors.password}
                  {...register("password", {
                    required: "Le mot de passe est requis.",
                    minLength: { value: 6, message: "Minimum 6 caractères." },
                  })}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || attempts >= 5}
            >
              {isSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  Connexion…
                </span>
              ) : (
                "Se connecter"
              )}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/60">
          Développé par{" "}
          <a href="https://afdev.fr/" target="_blank" rel="noopener noreferrer" className="hover:underline">
            AFDEV
          </a>{" "}
          pour ESAT AGECET
        </p>
      </div>
    </div>
  );
}
