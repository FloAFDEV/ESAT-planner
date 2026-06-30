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
      <div className="max-w-2xl mx-auto prose prose-sm dark:prose-invert">
        <Link to="/login" className="text-xs text-muted-foreground hover:underline mb-6 inline-block">← Retour</Link>
        <h1 className="text-2xl font-bold mb-2">Conditions Générales d'Utilisation</h1>
        <p className="text-xs text-muted-foreground mb-8">Version 1.0 — en vigueur au 1er juillet 2026</p>

        <h2 className="text-base font-semibold mt-6 mb-2">1. Objet</h2>
        <p className="text-sm text-muted-foreground">
          L'application <strong>Coffret ERP</strong> (ci-après « l'Application ») est un outil interne de gestion de production, de stock et d'expéditions, développé par AFDEV pour l'usage exclusif de l'ESAT AGECET et de son personnel autorisé.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">2. Accès et authentification</h2>
        <p className="text-sm text-muted-foreground">
          L'accès à l'Application est réservé aux collaborateurs disposant d'un compte activé par l'administrateur. Chaque utilisateur est responsable de la confidentialité de ses identifiants. Tout accès non autorisé doit être signalé immédiatement à l'administrateur.
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          Pour des raisons de sécurité, la session est automatiquement fermée après <strong>30 minutes d'inactivité</strong>.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">3. Utilisation autorisée</h2>
        <p className="text-sm text-muted-foreground">L'Application est mise à disposition pour les usages professionnels suivants :</p>
        <ul className="text-sm text-muted-foreground list-disc pl-5 mt-1 space-y-1">
          <li>Gestion des ordres de fabrication (OF)</li>
          <li>Suivi des stocks de composants et de coffrets</li>
          <li>Préparation et suivi des expéditions (Bons de Livraison)</li>
          <li>Gestion du référentiel clients</li>
        </ul>
        <p className="text-sm text-muted-foreground mt-2">
          Toute utilisation à des fins personnelles, commerciales ou frauduleuses est interdite.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">4. Responsabilités</h2>
        <p className="text-sm text-muted-foreground">
          L'ESAT AGECET s'efforce d'assurer la disponibilité et la fiabilité de l'Application. Toutefois, des interruptions ponctuelles peuvent survenir pour maintenance ou mise à jour. Les données saisies restent sous la responsabilité de l'utilisateur.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">5. Intégrité des données</h2>
        <p className="text-sm text-muted-foreground">
          Les opérations irréversibles (suppression d'OF, de clients, de mouvements de stock) doivent être réalisées avec discernement. L'Application conserve un historique des mouvements à des fins d'audit interne.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">6. Modification des CGU</h2>
        <p className="text-sm text-muted-foreground">
          Ces CGU peuvent être mises à jour à tout moment. Les utilisateurs en seront informés par voie interne. L'utilisation continue de l'Application après notification vaut acceptation des nouvelles conditions.
        </p>

        <h2 className="text-base font-semibold mt-6 mb-2">7. Contact</h2>
        <p className="text-sm text-muted-foreground">
          Pour toute question relative à ces CGU, contactez l'administrateur de l'Application ou AFDEV à l'adresse{" "}
          <a href="https://afdev.fr/" target="_blank" rel="noopener noreferrer" className="underline">afdev.fr</a>.
        </p>

        <div className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground">
          <Link to="/legal/privacy" className="hover:underline">→ Politique de confidentialité</Link>
        </div>
      </div>
    </div>
  );
}
