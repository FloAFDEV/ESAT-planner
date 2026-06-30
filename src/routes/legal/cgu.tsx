import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/legal/cgu")({
  head: () => ({
    meta: [
      { title: "CGU — Coffret ERP" },
      { name: "description", content: "Conditions générales d'utilisation de l'application Coffret ERP." },
    ],
  }),
  component: CguPage,
});

function CguPage() {
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="max-w-2xl mx-auto space-y-6 text-sm">
        <div>
          <Link to="/login" className="text-xs text-muted-foreground hover:underline inline-block mb-6">← Retour</Link>
          <h1 className="text-2xl font-bold">Conditions générales d'utilisation</h1>
          <p className="text-xs text-muted-foreground mt-1">Version 1.0 — juillet 2026 · Application Coffret ERP · ESAT AGECET</p>
        </div>

        <Section title="1. Objet">
          <p>
            <strong>Coffret ERP</strong> est une application de gestion interne développée par <strong>AFDEV</strong> pour le compte de l'<strong>ESAT AGECET</strong>. Elle permet de gérer les ordres de fabrication, les stocks, les clients et les expéditions.
          </p>
          <p className="mt-2">
            Cette application est réservée à un <strong>usage interne exclusif</strong> de l'organisation. Elle n'est pas destinée à un usage commercial, public ou tiers.
          </p>
        </Section>

        <Section title="2. Accès et utilisateurs autorisés">
          <p>
            L'accès à l'application est réservé aux personnes disposant d'un compte activé par l'administrateur de l'ESAT AGECET. Tout compte est nominatif et non transférable.
          </p>
          <p className="mt-2">
            Chaque utilisateur est responsable de la confidentialité de ses identifiants. Le partage de compte entre plusieurs personnes est interdit. Tout accès non autorisé doit être signalé immédiatement à l'administrateur.
          </p>
          <p className="mt-2">
            La session est automatiquement fermée après 30 minutes d'inactivité.
          </p>
        </Section>

        <Section title="3. Responsabilité de l'utilisateur">
          <p>
            L'utilisateur est responsable des données qu'il saisit dans l'application : exactitude des informations clients, des quantités, des statuts et des références. L'éditeur ne vérifie pas la cohérence des données métier saisies.
          </p>
          <p className="mt-2">
            Les opérations irréversibles (suppression, clôture d'OF, mouvements de stock) engagent la responsabilité de l'utilisateur qui les effectue.
          </p>
        </Section>

        <Section title="4. Rôle de l'éditeur">
          <p>
            AFDEV fournit un <strong>outil technique</strong>. Sa responsabilité se limite à la disponibilité et au bon fonctionnement de l'application.
          </p>
          <p className="mt-2">
            AFDEV n'est pas responsable de l'usage qui est fait de l'application en interne, du contenu des données saisies, ni des conséquences d'un accès non autorisé résultant d'un partage de compte par l'organisation utilisatrice.
          </p>
        </Section>

        <Section title="5. Disponibilité du service">
          <p>
            L'application est fournie sans garantie de continuité de service. Des interruptions peuvent survenir pour maintenance, mise à jour ou incident technique. L'éditeur s'efforce de limiter ces interruptions et d'en informer les utilisateurs.
          </p>
          <p className="mt-2">
            Un export régulier des données est recommandé. L'export complet est disponible à tout moment depuis l'application (section "Exporter les données").
          </p>
        </Section>

        <Section title="6. Propriété des données">
          <p>
            Les données saisies dans l'application appartiennent intégralement à l'ESAT AGECET. L'éditeur n'en revendique aucun droit et ne les exploite à aucune fin commerciale ou tierce.
          </p>
          <p className="mt-2">
            L'organisation peut à tout moment exporter l'intégralité de ses données au format CSV, sans restriction.
          </p>
        </Section>

        <Section title="7. Évolution des CGU">
          <p>
            Ces conditions peuvent être mises à jour. Les utilisateurs en seront informés lors de leur prochaine connexion. L'utilisation continue de l'application vaut acceptation des nouvelles conditions.
          </p>
        </Section>

        <Section title="8. Contact">
          <p>
            Pour toute question ou signalement d'incident, contactez l'administrateur de l'ESAT AGECET ou AFDEV via{" "}
            <a href="https://afdev.fr/" target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">afdev.fr</a>.
          </p>
        </Section>

        <div className="pt-6 border-t border-border text-xs text-muted-foreground">
          <Link to="/legal/privacy" className="hover:underline">→ Politique de confidentialité</Link>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="font-semibold text-base">{title}</h2>
      <div className="text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
}
