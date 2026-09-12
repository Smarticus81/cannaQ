import { useQuery, useMutation } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// THE FACILITY SWITCHER — multi-facility Phase 4 (2026-08-28).
//
// Which plant am I working at right now. Everything on screen follows it, and any
// record made while it is set belongs to that plant.
//
// ⛔ IT HIDES ITSELF WHEN THERE IS ONLY ONE SITE. That was the promise when facilities
// were introduced: a single-site operator should see no trace of any of this.
//
// ⛔ It only lists the sites the person is LISTED at. The browser does not get to say
// which facility it wants — it asks to switch, the server checks the person actually
// works there, and stores the answer on the person. A facility the browser could set
// is a facility the browser could lie about.
//
// Switching RELOADS THE PAGE on purpose. Every screen's data was fetched for the old
// site; keeping any of it would mean showing one plant's numbers under another
// plant's name, which is the exact confusion this whole design exists to prevent.

type Site = { id: number; name: string; code: string | null; state: string };

export function FacilitySwitcher() {
  const { toast } = useToast();

  const { data } = useQuery<{ facilities: Site[]; activeFacilityId: number | null }>({
    queryKey: ["me", "facilities"],
    queryFn: async () => {
      const r = await fetch("/api/me/facilities", { credentials: "include" });
      if (!r.ok) return { facilities: [], activeFacilityId: null };
      return r.json();
    },
    staleTime: 60 * 1000,
  });

  const switchTo = useMutation({
    mutationFn: async (facilityId: number) => {
      const r = await fetch("/api/me/facility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ facilityId }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Could not switch facility");
      return r.json();
    },
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const sites = data?.facilities ?? [];
  if (sites.length < 2) return null;

  const active = data?.activeFacilityId ?? sites[0]?.id ?? null;

  return (
    <div className="flex items-center gap-1.5">
      <Building2 className="h-4 w-4 text-muted-foreground" />
      <Select
        // Keyed on the value for the same reason the licence-type picker is: this
        // mounts before the sites have loaded, and a select that mounts empty never
        // picks the value up. See [[radix-select-async-value]].
        key={`facility-switcher-${active ?? "none"}`}
        value={active ? String(active) : undefined}
        onValueChange={(v) => switchTo.mutate(parseInt(v, 10))}
        disabled={switchTo.isPending}
      >
        <SelectTrigger className="h-8 w-[190px] text-sm" aria-label="Facility">
          <SelectValue placeholder="Choose a facility" />
        </SelectTrigger>
        <SelectContent>
          {sites.map((s) => (
            <SelectItem key={s.id} value={String(s.id)}>
              {s.name}
              {s.code ? ` · ${s.code}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
