import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Mail, ArrowLeft, AlertCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Mot de passe oublié — Coffret ERP" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ForgotPasswordPage,
});

type ForgotForm = { email: string };

function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ForgotForm>();

  const onSubmit = async (values: ForgotForm) => {
    setErrorMsg(null);
    const { error } = await supabase.auth.resetPasswordForEmail(
      values.email.trim().toLowerCase(),
      { redirectTo: `${window.location.origin}/reset-password` }
    );

    if (error) {
      setErrorMsg("Une erreur est survenue. Vérifiez l'adresse email et réessayez.");
      return;
    }
    setSent(true);
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
          {sent ? (
            <div className="space-y-4 text-center">
              <div className="flex justify-center">
                <CheckCircle2 className="h-10 w-10 text-success" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Email envoyé</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Un lien de réinitialisation a été envoyé à{" "}
                  <span className="font-mono text-xs">{getValues("email")}</span>.
                  Vérifiez également vos spams.
                </p>
              </div>
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Retour à la connexion
              </Link>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-base font-semibold text-foreground">Réinitialiser le mot de passe</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Saisissez votre adresse email. Vous recevrez un lien pour choisir un nouveau mot de passe.
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

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      Envoi…
                    </span>
                  ) : (
                    "Envoyer le lien"
                  )}
                </Button>
              </form>

              <div className="text-center">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Retour à la connexion
                </Link>
              </div>
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
