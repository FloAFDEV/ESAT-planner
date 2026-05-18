import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Eye, EyeOff, Lock, AlertCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Nouveau mot de passe — Coffret ERP" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ResetPasswordPage,
});

type ResetForm = { password: string; confirm: string };

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Supabase JS automatically detects the recovery token in the URL
    // (both ?code= PKCE flow and #access_token= implicit flow)
    // and fires PASSWORD_RECOVERY via onAuthStateChange.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setReady(true);
      if (event === "USER_UPDATED") {
        setDone(true);
        setTimeout(() => navigate({ to: "/login" }), 3000);
      }
    });

    // If user already has a valid session from a previous recovery link click
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>();

  const onSubmit = async (values: ResetForm) => {
    setErrorMsg(null);
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      setErrorMsg("Impossible de mettre à jour le mot de passe. Le lien a peut-être expiré.");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="p-2 bg-white rounded-2xl shadow-md border border-border">
            <img src={agecetLogo} alt="ESAT AGECET" className="h-14 w-14 rounded-xl object-contain" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-foreground">Coffret ERP</h1>
            <p className="text-sm text-muted-foreground mt-0.5">ESAT AGECET · Espace administration</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-5">
          {done ? (
            <div className="space-y-4 text-center">
              <div className="flex justify-center">
                <CheckCircle2 className="h-10 w-10 text-success" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Mot de passe mis à jour</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Redirection vers la connexion…
                </p>
              </div>
            </div>
          ) : !ready ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <p className="text-sm text-muted-foreground">Vérification du lien…</p>
              <p className="text-xs text-muted-foreground/70 text-center">
                Si rien ne se passe, le lien est peut-être expiré.{" "}
                <a href="/forgot-password" className="text-accent hover:underline">
                  Demander un nouveau lien
                </a>
              </p>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-base font-semibold text-foreground">Nouveau mot de passe</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Choisissez un mot de passe fort (minimum 8 caractères).
                </p>
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="password">Nouveau mot de passe</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      id="password"
                      type={showPwd ? "text" : "password"}
                      autoComplete="new-password"
                      autoFocus
                      placeholder="••••••••"
                      className="pl-9 pr-10"
                      aria-invalid={!!errors.password}
                      {...register("password", {
                        required: "Le mot de passe est requis.",
                        minLength: { value: 8, message: "Minimum 8 caractères." },
                      })}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={showPwd ? "Masquer" : "Afficher"}
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

                <div className="space-y-1.5">
                  <Label htmlFor="confirm">Confirmer le mot de passe</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      id="confirm"
                      type={showPwd ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="pl-9"
                      aria-invalid={!!errors.confirm}
                      {...register("confirm", {
                        required: "La confirmation est requise.",
                        validate: (v) =>
                          v === watch("password") || "Les mots de passe ne correspondent pas.",
                      })}
                    />
                  </div>
                  {errors.confirm && (
                    <p className="text-xs text-destructive">{errors.confirm.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      Mise à jour…
                    </span>
                  ) : (
                    "Enregistrer le mot de passe"
                  )}
                </Button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/60">
          Développé par{" "}
          <a href="mailto:contact@afdev.fr" className="hover:underline">AFDEV</a>{" "}
          pour ESAT AGECET
        </p>
      </div>
    </div>
  );
}
