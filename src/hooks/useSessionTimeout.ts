import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

// 30 min inactivity → sign out. Standard for internal ERP: short enough to limit
// exposure on shared workstations, long enough not to disrupt normal workflows.
const TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "touchstart", "scroll"] as const;

export function useSessionTimeout() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const resetTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        await supabase.auth.signOut();
        // onAuthStateChange in AuthContext picks this up → session null → router.invalidate() → /login
      }, TIMEOUT_MS);
    };

    resetTimer();

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, []);
}
