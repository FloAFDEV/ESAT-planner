import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Factory, Boxes, Truck, Layers, Users, Archive, Sun, Moon, LogOut } from "lucide-react";
import { UI } from "@/lib/uiLabels";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/contexts/AuthContext";
import agecetLogo from "@/assets/logo_agecet_hands.jpg";

const NAV = [
  { to: "/", label: UI.dashboard, icon: LayoutDashboard },
  { to: "/production", label: UI.production_orders, icon: Factory },
  { to: "/stock", label: UI.stock, icon: Boxes },
  { to: "/livraisons", label: UI.livraisons, icon: Truck },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/coffrets", label: "Coffrets", icon: Layers },
  { to: "/archives", label: "Archives", icon: Archive },
] as const;

export function AppLayout() {
  const { dark, toggle } = useTheme();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden md:flex fixed top-0 left-0 h-screen w-56 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border z-40">
        <div className="px-4 py-4 border-b border-sidebar-border flex items-center gap-2">
<div className="p-1 bg-white rounded-xl shadow-sm">
  <img
    src={agecetLogo}
    alt="ESAT AGECET"
    className="h-12 w-12 rounded-lg object-contain"
  />
</div>
          <div>
            <div className="font-semibold leading-tight text-sm">
              Coffret ERP
            </div>
            <div className="text-[11px] text-sidebar-foreground/60 uppercase tracking-wider">
              Production
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV.map(({ to, label, icon: Icon }) => {
            return (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === "/" }}
                className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-sm text-xs transition-colors"
                activeProps={{ className: "flex items-center gap-2.5 px-2.5 py-1.5 rounded-sm text-xs transition-colors bg-sidebar-accent text-foreground font-semibold" }}
                inactiveProps={{ className: "flex items-center gap-2.5 px-2.5 py-1.5 rounded-sm text-xs transition-colors text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground" }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border sticky bottom-0 bg-sidebar space-y-1">
          {user && (
            <div className="px-2 pb-1">
              <p className="text-[10px] text-sidebar-foreground/50 truncate">{user.email}</p>
            </div>
          )}
          <button
            onClick={toggle}
            className="flex items-center gap-1.5 w-full px-2 py-1 rounded text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {dark ? "Mode clair" : "Mode sombre"}
          </button>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 w-full px-2 py-1 rounded text-xs text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Déconnexion
          </button>
          <div className="text-[10px] text-sidebar-foreground/40 leading-tight px-2 pt-1">
            <div>v1.0 · ERP coffrets</div>
            <div>Développé par <a href="mailto:contact@afdev.fr" className="hover:underline">AFDEV</a> pour ESAT AGECET</div>
          </div>
        </div>
      </aside>

      {/* Mobile */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src={agecetLogo} alt="ESAT AGECET" className="h-6 w-6 rounded-sm object-cover border border-sidebar-border" />
            <span className="font-semibold text-sm">
              Coffret ERP
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggle} className="p-1.5 rounded hover:bg-sidebar-accent transition-colors">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button onClick={handleSignOut} className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors" title="Déconnexion">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex border-t border-sidebar-border overflow-x-auto">
          {NAV.map(({ to, label, icon: Icon }) => {
            return (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === "/" }}
                className="flex-1 min-w-[80px] flex flex-col items-center gap-1 py-2 text-xs"
                activeProps={{ className: "flex-1 min-w-[80px] flex flex-col items-center gap-1 py-2 text-xs text-accent" }}
                inactiveProps={{ className: "flex-1 min-w-[80px] flex flex-col items-center gap-1 py-2 text-xs text-sidebar-foreground/70" }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-sidebar text-sidebar-foreground border-t border-sidebar-border px-4 py-2 text-[10px] text-center text-sidebar-foreground/50">
        v1.0 · ERP coffrets · AFDEV pour ESAT AGECET
      </div>

      <main className="flex-1 md:ml-56 mt-[88px] md:mt-0 mb-[34px] md:mb-0">
        <Outlet />
      </main>
    </div>
  );
}