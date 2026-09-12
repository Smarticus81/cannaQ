import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

// THE CORPORATE VIEW — every site, side by side. Multi-facility Phase 4 (2026-08-28).
//
// His reason for wanting it: "If I were director over all sites, I would want to see
// metrics from everyone. That could help me identify global issues." Three plants
// hitting the same failure is a pattern nobody can see from inside one plant.
//
// The two halves of the table are two different rules, and the header says so:
// quality events are raised at a plant and belong to the company; batches, lots,
// training and local documents belong to the plant that made them and are only
// counted here for the sites this person actually works at.

type SiteRow = {
  id: number;
  name: string;
  code: string | null;
  state: string;
  licenseType: string | null;
  nonConformances: number;
  capas: number;
  complaints: number;
  fieldActions: number;
  batches: number;
  lots: number;
  trainingRecords: number;
  localDocuments: number;
};

export default function Corporate() {
  const { data, isLoading } = useQuery<{ sites: SiteRow[] }>({
    queryKey: ["corporate", "summary"],
    queryFn: async () => {
      const r = await fetch("/api/corporate/summary", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load the corporate summary");
      return r.json();
    },
  });

  const sites = data?.sites ?? [];
  const total = (key: keyof SiteRow) => sites.reduce((n, s) => n + (Number(s[key]) || 0), 0);

  return (
    <AppLayout>
      <div className="space-y-6 max-w-6xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Corporate View</h1>
          <p className="text-muted-foreground">
            Every site you work at, side by side.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Quality events</CardTitle>
            <CardDescription>
              Raised at a site and owned by the company. The same failure appearing at two plants is
              the thing this table exists to show.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Non-conformances</TableHead>
                    <TableHead className="text-right">CAPAs</TableHead>
                    <TableHead className="text-right">Complaints</TableHead>
                    <TableHead className="text-right">Field actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="font-medium">{s.name}</span>
                        {s.code ? <span className="ml-2 text-xs font-mono text-muted-foreground">{s.code}</span> : null}
                        <span className="ml-2 text-xs text-muted-foreground">{[s.licenseType, s.state].filter(Boolean).join(" · ")}</span>
                      </TableCell>
                      <TableCell className="text-right">{s.nonConformances}</TableCell>
                      <TableCell className="text-right">{s.capas}</TableCell>
                      <TableCell className="text-right">{s.complaints}</TableCell>
                      <TableCell className="text-right">{s.fieldActions}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/40">
                    <TableCell className="font-medium">Company</TableCell>
                    <TableCell className="text-right font-medium">{total("nonConformances")}</TableCell>
                    <TableCell className="text-right font-medium">{total("capas")}</TableCell>
                    <TableCell className="text-right font-medium">{total("complaints")}</TableCell>
                    <TableCell className="text-right font-medium">{total("fieldActions")}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What each site holds</CardTitle>
            <CardDescription>
              These belong to the plant that made them and are not visible from the other sites.
              They are counted here by asking each site in turn, as that site — not by going around
              the rule that keeps them apart.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Batches</TableHead>
                    <TableHead className="text-right">Lots</TableHead>
                    <TableHead className="text-right">Training records</TableHead>
                    <TableHead className="text-right">Site documents</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="font-medium">{s.name}</span>
                        {s.code ? <span className="ml-2 text-xs font-mono text-muted-foreground">{s.code}</span> : null}
                      </TableCell>
                      <TableCell className="text-right">{s.batches}</TableCell>
                      <TableCell className="text-right">{s.lots}</TableCell>
                      <TableCell className="text-right">{s.trainingRecords}</TableCell>
                      <TableCell className="text-right">{s.localDocuments}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-[11px] text-muted-foreground mt-3">
              Company-wide documents — SOPs, policies, manuals, specifications — are not counted per
              site, because there is one of each and every site works to the same one.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
