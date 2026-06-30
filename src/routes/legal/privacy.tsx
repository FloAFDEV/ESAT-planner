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
      <div className="max-w-2xl mx-auto space-y-6 text-sm">
        <div>
          <Link to="/login" className="text-xs text-muted-foreground hover:underline inline-block mb-6">← Retour</Link>
          <h1 className="text-2xl font-bold">Politique de confidentialité</h1>
          <p className="text-xs text-muted-foreground mt-1">Version 1.0 — juillet 2026 · Application Coffret ERP · ESAT AGECET</p>
        </div>

        <Section title="1. Qui traite vos données ?">
          <p>
            <strong>Responsable du traitement :</strong> ESAT AGECET, en tant qu'organisation utilisatrice de l'application.
          </p>
          <p className="mt-2">
            <strong>Prestataire technique :</strong> AFDEV, développeur et mainteneur de l'application, intervient en qualité de sous-traitant. AFDEV n'accède aux données qu'à des fins de maintenance technique et ne les exploite à aucune fin commerciale ou tierce.
          </p>
        </Section>

        <Section title="2. Données traitées">
          <p>L'application traite uniquement des données nécessaires à l'activité métier interne :</p>
          <table className="mt-3 w-full text-xs border border-border rounded overflow-hidden">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-2 font-medium">Catégorie</th>
                <th className="text-left p-2 font-medium">Données</th>
                <th className="text-left p-2 font-medium">Usage</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Utilisateurs", "Adresse email", "Authentification et accès"],
                ["Clients", "Raison sociale, adresse, contact, téléphone, email", "Gestion des livraisons et BL"],
                ["Production", "Ordres de fabrication, stocks, mouvements", "Suivi de production interne"],
                ["Expéditions", "Références, poids, palettes, statuts", "Suivi logistique"],
              ].map(([cat, data, usage]) => (
                <tr key={cat} className="border-t border-border">
                  <td className="p-2 text-muted-foreground align-top">{cat}</td>
                  <td className="p-2 text-muted-foreground align-top">{data}</td>
                  <td className="p-2 text-muted-foreground align-top">{usage}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3">
            Aucune donnée sensible (santé, opinions, etc.) n'est collectée. Aucune donnée n'est utilisée à des fins de profilage, publicité ou analyse commerciale.
          </p>
        </Section>

        <Section title="3. Usage strictement interne">
          <p>
            Les données traitées dans l'application le sont <strong>exclusivement pour les besoins opérationnels de l'ESAT AGECET</strong>. Elles ne sont ni vendues, ni partagées avec des tiers, ni utilisées à d'autres fins.
          </p>
          <p className="mt-2">
            L'accès est limité aux utilisateurs authentifiés disposant d'un compte activé par l'administrateur de l'organisation. Chaque session est protégée et se ferme automatiquement après 30 minutes d'inactivité.
          </p>
        </Section>

        <Section title="4. Hébergement">
          <p>
            Les données sont hébergées par deux prestataires conformes au RGPD :
          </p>
          <ul className="mt-2 space-y-1 list-disc pl-5">
            <li><strong>Supabase</strong> — base de données PostgreSQL, infrastructure hébergée en Europe (UE)</li>
            <li><strong>Vercel</strong> — hébergement de l'application frontend</li>
          </ul>
          <p className="mt-2">Ces prestataires agissent en tant que sous-traitants techniques et ne peuvent utiliser les données qu'à des fins d'hébergement et de fourniture du service.</p>
        </Section>

        <Section title="5. Durée de conservation">
          <p>
            Les données sont conservées <strong>tant que l'application est en service</strong> et que l'organisation l'utilise activement.
          </p>
          <p className="mt-2">
            Les comptes utilisateurs sont supprimés dès la fin d'habilitation de la personne. Les données clients et les historiques opérationnels (production, expéditions) sont conservés pour les besoins de suivi et de comptabilité interne.
          </p>
          <p className="mt-2">
            En cas d'arrêt définitif du service, l'organisation peut exporter l'intégralité de ses données avant résiliation. Sur demande explicite, des suppressions ciblées peuvent être effectuées par l'administrateur ou le prestataire technique.
          </p>
        </Section>

        <Section title="6. Vos droits">
          <p>
            Conformément au RGPD, toute personne dont les données sont traitées peut demander :
          </p>
          <ul className="mt-2 space-y-1 list-disc pl-5">
            <li>L'accès à ses données</li>
            <li>La rectification de données incorrectes</li>
            <li>La suppression de ses données</li>
            <li>L'export de ses données (disponible directement dans l'application)</li>
          </ul>
          <p className="mt-2">
            Ces demandes s'adressent à l'administrateur de l'ESAT AGECET. En cas de litige, vous pouvez contacter la{" "}
            <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80">CNIL</a>.
          </p>
        </Section>

        <Section title="7. Propriété des données">
          <p>
            Les données saisies dans l'application appartiennent intégralement à l'ESAT AGECET. L'éditeur (AFDEV) n'en revendique aucun droit. L'export complet est disponible à tout moment depuis la page "Exporter les données".
          </p>
        </Section>

        <div className="pt-6 border-t border-border text-xs text-muted-foreground">
          <Link to="/legal/cgu" className="hover:underline">→ Conditions générales d'utilisation</Link>
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
