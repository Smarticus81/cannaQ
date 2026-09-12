import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useOnboarding,
  onboardingRequest,
  onboardingKey,
  applyPreferences,
} from "@/lib/onboarding";

export function ThemeToggle() {
  const { data } = useOnboarding();
  const client = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const dark =
    data?.draft.theme === "dark" ||
    (data?.draft.theme === "system" && systemDark);
  async function toggle() {
    if (!data || busy) return;
    setBusy(true);
    try {
      const next = await onboardingRequest("PATCH", "", {
        revision: data.revision,
        draft: { ...data.draft, theme: dark ? "light" : "dark" },
      });
      client.setQueryData(onboardingKey, next);
      applyPreferences(next.draft);
    } catch {
      toast({
        title: "Your appearance couldn't be saved",
        description: "Please try again. Your current preference is unchanged.",
        variant: "destructive",
      });
      void client.invalidateQueries({ queryKey: onboardingKey });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={() => void toggle()}
      disabled={!data || busy}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      data-testid="button-theme-toggle"
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
