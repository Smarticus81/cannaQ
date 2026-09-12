import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Printer, Archive } from "lucide-react";
import { DocumentPrintView, type RetainedSnapshot } from "@/components/document/DocumentPrintView";

// Reading a superseded revision as it stood (2026-08-25).
//
// This is its OWN PAGE rather than a dialog, and deliberately so: printing is the
// point — "in case an old procedure is requested during an audit" — and a page
// containing only the retained copy prints correctly with the existing print CSS.
// A dialog would need the rest of the app hidden at print time, which is exactly
// the kind of fragile trick that produces a wrong controlled document one day.
type RetainedResponse = {
  retained: boolean;
  revision: string;
  status: string;
  snapshot: RetainedSnapshot;
  capturedAt: string | null;
  capturedFrom: string | null;
  approvedByName: string | null;
  approvalDate: string | null;
  effectiveDate: string | null;
  supersededOn: string | null;
  supersededByRevision: string | null;
  error?: string;
};

export default function DocumentRevisionView() {
  const [, params] = useRoute("/documents/:id/revisions/:rowId");
  const docId = parseInt(params?.id ?? "0");
  const rowId = parseInt(params?.rowId ?? "0");

  const { data, isLoading, isError } = useQuery<RetainedResponse>({
    queryKey: [`/api/documents/${docId}/revisions/${rowId}/content`],
    queryFn: async () => {
      const res = await fetch(`/api/documents/${docId}/revisions/${rowId}/content`, { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load this revision.");
      return body;
    },
    enabled: !!docId && !!rowId,
  });

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Link
            href={`/documents/${docId}`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to document
          </Link>
          {data?.retained && (
            <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-retained">
              <Printer className="h-4 w-4 mr-1" /> Print
            </Button>
          )}
        </div>

        {isLoading && <Skeleton className="h-96 w-full" />}

        {isError && (
          <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-amber-900 print:hidden">
            <p className="font-semibold text-sm flex items-center gap-2">
              <Archive className="h-4 w-4" /> No retained copy of this revision
            </p>
            <p className="text-xs mt-1">
              This revision was approved before revision content was retained, so its text was overwritten
              when the next revision was drafted. Its approval record — who signed it and when — is still on
              the document&rsquo;s History tab.
            </p>
          </div>
        )}

        {data?.retained && (
          <>
            {/* Screen reading. The print view below carries the same content for paper. */}
            <div className="rounded-lg border bg-card p-4 print:hidden">
              <p className="text-sm font-semibold">
                {String(data.snapshot.header.docNumber ?? "")} — Rev {data.revision}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {data.supersededOn
                  ? `In force until ${data.supersededOn}${data.supersededByRevision ? `, replaced by Rev ${data.supersededByRevision}` : ""}.`
                  : "This is the revision currently in force."}
                {data.capturedFrom === "backfill"
                  ? " Content captured at backfill rather than at the approver's signature."
                  : " Content frozen at approval."}
              </p>
            </div>

            {/* Always visible here, unlike on the document screen where it prints only. */}
            <div className="bg-white p-6 rounded-lg border print:border-0 print:p-0">
              <DocumentPrintView
                showOnScreen
                doc={data.snapshot.header}
                snapshot={data.snapshot}
                supersededOn={data.supersededOn}
                supersededByRevision={data.supersededByRevision}
                capturedFrom={data.capturedFrom}
              />
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
