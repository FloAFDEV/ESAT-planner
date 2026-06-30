import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/legal/privacy")({
  head: () => ({
    meta: [
      { title: "Politique de confidentialité — Coffret ERP" },
      { name: "description", content: "Politique de confidentialité et traitement des données personnelles." },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="max-w-2xl mx-auto prose prose-sm dark:prose-invert">
        <Link to="/login" className="text-xs text-muted-foreground hover:underline mb-6 inline-block">← Retour</Link>
        <h1 className="text-2xl font-bold mb-2">Politique de confidentialité</h1>
        <p className="text-xs text-muted-foreground mb-8">Conforme RGPD — Version 1.0 — juillet 2026</p>

        <h2 className="text-base font-semibold mt-6 mb-2">1. Responsable du traitement</h2>
        <p className="text-sm text-muted-foreground">
          Le responsable du traitement des données est l'<strong>ESAT AGECET</strong>, en qualité d'exploitant de l'Application Coffret ERP. AFDEV intervient en qualité de sous-traitant technique (développement et hébergement).
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">2. Données collectées</h2>
        <p className="text-sm text-muted-foreground">L'Application traite les catégories de données suivantes :</p>
        <div className="mt-2 overflow-x-auto">
          <table className="text-sm w-full border border-border rounded">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-2 font-medium">Catégorie</th>
                <th className="text-left p-2 font-medium">Données</th>
                <th className="text-left p-2 font-medium">Finalité</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="p-2 text-muted-foreground">Utilisateurs</td>
                <td className="p-2 text-muted-foreground">Adresse email</td>
                <td className="p-2 text-muted-foreground">Authentification</td>
              </tr>
              <tr className="border-t border-border">
                <td className="p-2 text-muted-foreground">Clients</td>
                <td className="p-2 text-muted-foreground">Raison sociale, adresse, contact, téléphone, email</td>
                <td className="p-2 text-muted-foreground">Gestion des expéditions et BL</td>
              </tr>
              <tr className="border-t border-border">
                <td className="p-2 text-muted-foreground">Expéditions</td>
                <td className="p-2 text-muted-foreground">Références, poids, palettes, statut</td>
                <td className="p-2 text-muted-foreground">Suivi logistique</td>
              </tr>
              <tr className="border-t border-border">
                <td className="p-2 text-muted-foreground">Production</td>
                <td className="p-2 text-muted-foreground">Ordres de fabrication, mouvements de stock</td>
                <td className="p-2 text-muted-foreground">Gestion de production interne</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          Aucune donnée sensible au sens de l'article 9 du RGPD n'est collectée.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">3. Base légale</h2>
        <p className="text-sm text-muted-foreground">
          Le traitement est fondé sur l'<strong>intérêt légitime</strong> de l'ESAT AGECET pour la gestion de son activité de production et de logistique, ainsi que sur l'<strong>exécution du contrat</strong> avec ses clients professionnels.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">4. Hébergement et sous-traitants</h2>
        <p className="text-sm text-muted-foreground">
          Les données sont hébergées sur <strong>Supabase</strong> (infrastructure PostgreSQL, région EU) et <strong>Vercel</strong> (front-end). Ces prestataires agissent en qualité de sous-traitants et sont soumis à des obligations contractuelles de sécurité conformes au RGPD.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">5. Durée de conservation</h2>
        <ul className="text-sm text-muted-foreground list-disc pl-5 mt-1 space-y-1">
          <li>Données clients actifs : durée de la relation commerciale + 3 ans</li>
          <li>Historique des mouvements de stock : 5 ans (obligation comptable)</li>
          <li>Comptes utilisateurs : supprimés dès la fin d'habilitation</li>
          <li>Sessions : 30 minutes d'inactivité maximum (déconnexion automatique)</li>
        </ul>

        <h2 className="text-base font-semibold mt-6 mb-2">6. Sécurité</h2>
        <p className="text-sm text-muted-foreground">
          Les mesures de sécurité mises en place comprennent : authentification par mot de passe, RLS (Row Level Security) sur toutes les tables de la base de données, chiffrement des données en transit (HTTPS), déconnexion automatique après inactivité, et limitation du nombre de tentatives de connexion.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">7. Droits des personnes</h2>
        <p className="text-sm text-muted-foreground">
          Conformément au RGPD, toute personne dont les données sont traitées dispose des droits d'accès, de rectification, d'effacement, de limitation et de portabilité. Ces droits s'exercent auprès de l'administrateur de l'ESAT AGECET ou via{" "}
          <a href="https://afdev.fr/" target="_blank" rel="noopener noreferrer" className="underline">afdev.fr</a>.
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          En cas de litige, vous pouvez saisir la <strong>CNIL</strong> (Commission Nationale de l'Informatique et des Libertés) à l'adresse{" "}
          <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="underline">cnil.fr</a>.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">8. Propriété des données</h2>
        <p className="text-sm text-muted-foreground">
          Les données saisies dans l'application (clients, expéditions, ordres de fabrication, stocks) appartiennent intégralement à l'<strong>ESAT AGECET</strong>. L'application est un outil de traitement mis à disposition — elle ne revendique aucun droit sur ces données.
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          L'organisation peut à tout moment exporter l'intégralité de ses données au format CSV via la fonctionnalité <strong>"Exporter les données"</strong> disponible dans l'application. Cet export inclut : clients, expéditions, lignes d'expédition et ordres de fabrication. Aucune restriction technique ne limite cet accès.
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          En cas d'arrêt du service, les données restent accessibles dans la base Supabase associée au projet pendant la durée de conservation de la plateforme (30 jours après suppression du projet). Un export préalable est recommandé avant toute résiliation.
        </p>

        <div className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground">
          <Link to="/legal/cgu" className="hover:underline">→ Conditions générales d'utilisation</Link>
        </div>
      </div>
    </div>
  );
}
