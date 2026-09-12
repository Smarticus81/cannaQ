import { useQuery } from "@tanstack/react-query";

// WHICH SITE A RECORD CAME FROM — multi-facility Phase 4 (2026-08-28).
//
// Non-conformances, CAPAs, complaints and field actions are RAISED at a plant and
// LISTED COMPANY-WIDE (his ruling 08-27, restated 08-28: "If I were director over all
// sites, I would want to see metrics from everyone. That could help me identify
// global issues"). Three plants hitting the same cartridge failure is a pattern only
// visible if the person over all three can see all three — so these lists are not
// filtered by site, and instead each row says where it came from.
//
// The column HIDES ITSELF when there is only one facility. A single-site operator
// should see no trace of any of this, and a column repeating the same site name on
// every row is noise.

type Facility = { id: number; name: string };

export function useFacilities() {
  const { data = [] } = useQuery<Facility[]>({
    queryKey: ["facilities"],
    queryFn: async () => {
      const r = await fetch("/api/facilities", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const names = new Map(data.map((f) => [f.id, f.name]));
  return { facilities: data, names, multiSite: data.length > 1 };
}

/** The site a record came from, or a dash when it predates facilities. */
export function SiteName({ facilityId }: { facilityId: number | null | undefined }) {
  const { names } = useFacilities();
  return (
    <span className="text-sm text-muted-foreground">
      {facilityId ? names.get(facilityId) ?? `Facility ${facilityId}` : "—"}
    </span>
  );
}

/**
 * The site a record came from, as a badge — for the top of a record's own page.
 *
 * ⛔ Renders NOTHING when the company has one site. His instinct, 2026-08-28: "It's
 * important people know where the quality events are coming... We can't just add a
 * field to the opening of those records to show the facility?" — better than a list
 * column alone, because it is there whenever anyone opens the record rather than only
 * when they are scanning.
 */
export function SiteBadge({ facilityId }: { facilityId: number | null | undefined }) {
  const { names, multiSite } = useFacilities();
  if (!multiSite || !facilityId) return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-50 text-slate-600 border-slate-200 mt-1">
      {names.get(facilityId) ?? `Facility ${facilityId}`}
    </span>
  );
}
