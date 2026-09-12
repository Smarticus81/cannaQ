import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Router } from "wouter";
import { WorkspaceLayout } from "../src/components/layout/AppLayout";
import { Button } from "../src/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../src/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../src/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
import { Label } from "../src/components/ui/label";
import { applyPreferences } from "../src/lib/onboarding";
import "../src/index.css";
import "../src/product.css";
function Preview() {
  const [dark, setDark] = useState(false);
  const [compact, setCompact] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const records = [
    "Receiving materials",
    "Production readiness",
    "Document control",
  ];
  return (
    <WorkspaceLayout
      account={<span className="cq-microcopy">Local review</span>}
      toolbar={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setCompact(!compact);
              applyPreferences({
                theme: dark ? "dark" : "light",
                density: !compact ? "compact" : "comfortable",
              });
            }}
          >
            Change spacing
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDark(!dark);
              applyPreferences({
                theme: !dark ? "dark" : "light",
                density: compact ? "compact" : "comfortable",
              });
            }}
          >
            Change appearance
          </Button>
        </>
      }
    >
      <span className="cq-eyebrow">
        ISOLATED DESIGN REVIEW / SHARED PRODUCTION COMPONENTS
      </span>
      <h1 className="cq-dashboard-greeting">A clearer view of your work.</h1>
      <p className="cq-lead">
        Review the navigation, reading rhythm, tables, and forms. These are
        sample records, kept outside the application.
      </p>
      <section className="cq-orientation">
        <span className="cq-eyebrow">A USEFUL PLACE TO BEGIN</span>
        <div>
          <h2>Find your source of truth</h2>
          <p>Meet the controlled documents that guide your work.</p>
        </div>
        <button
          className="cq-text-action"
          onClick={() => setSelected(records[0])}
        >
          Explore a record →
        </button>
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Controlled documents</CardTitle>
          <Label htmlFor="review-search">Find a document</Label>
          <Input
            id="review-search"
            placeholder="Search by title"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records
                .filter((title) =>
                  title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((title, index) => (
                  <TableRow key={title}>
                    <TableCell>SOP-00{index + 1}</TableCell>
                    <TableCell>{title}</TableCell>
                    <TableCell>Effective</TableCell>
                    <TableCell>02</TableCell>
                    <TableCell>
                      <button
                        className="cq-text-action"
                        onClick={() => setSelected(title)}
                      >
                        Read
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {selected && (
        <Card className="mt-8">
          <CardHeader>
            <span className="cq-eyebrow">DOCUMENT OVERVIEW</span>
            <CardTitle>{selected}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="cq-lead">
              The current effective procedure is the starting point. Review its
              purpose, responsibilities, and revision history before beginning
              work.
            </p>
            <Dialog>
              <DialogTrigger asChild>
                <Button className="mt-5" variant="outline">
                  Review form layout
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Record a review</DialogTitle>
                  <DialogDescription>
                    Local layout preview. This does not create a regulated
                    record.
                  </DialogDescription>
                </DialogHeader>
                <Label htmlFor="review-note">Review notes</Label>
                <Input
                  id="review-note"
                  placeholder="What would help your team?"
                />
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      )}
    </WorkspaceLayout>
  );
}
createRoot(document.getElementById("root")!).render(
  <Router>
    <Preview />
  </Router>,
);
