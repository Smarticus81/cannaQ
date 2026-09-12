import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useGetCurrentUser } from "@workspace/api-client-react";

// THE ESTATE — every licence this company operates. Multi-facility Phase 4 (2026-08-28).
//
// ⛔ A FACILITY IS A LICENCE (his ruling 08-27). One company with a cultivation
// licence, a processing licence and three stores has five facilities, which is
// exactly how METRC sees it.
//
// Adding a site does NOT move anybody to it. People are added to a site separately,
// and until someone is added, nobody can switch to it — a site with no people is a
// site nobody can accidentally start working in.
//
// ⚠️ His open flag, unsolved: "we still need to be aware that people are not being
// removed with this software." METRC is the authority on who is at a site; this list
// is kept in step by hand for now.

type Facility = {
  id: number;
  name: string;
  code: string | null;
  licenseNumber: string | null;
  licenseType: string | null;
  state: string;
  city: string | null;
  isActive: boolean;
};

type Person = { userId: number; fullName: string; email: string; role: string; active: boolean };
type AppUser = { id: number; fullName: string; email: string; role: string; active: boolean };

const US_STATES = ["MI", "MO", "IL", "OH", "CO", "CA", "NV", "AZ", "NM", "MA", "NY", "NJ", "FL"];

export function FacilitiesCard() {
  const { data: currentUser } = useGetCurrentUser();
  const isAdmin = currentUser?.role === "Admin";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [openPeopleFor, setOpenPeopleFor] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", code: "", state: "MI", licenseNumber: "", licenseType: "" });

  const { data: facilities = [] } = useQuery<Facility[]>({
    queryKey: ["facilities"],
    queryFn: async () => {
      const r = await fetch("/api/facilities", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load facilities");
      return r.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/facilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Failed to add the facility");
      return r.json();
    },
    onSuccess: (created: Facility) => {
      queryClient.invalidateQueries({ queryKey: ["facilities"] });
      setAdding(false);
      setForm({ name: "", code: "", state: "MI", licenseNumber: "", licenseType: "" });
      toast({
        title: `${created.name} added`,
        description: "Nobody works there yet — add people before anyone can switch to it.",
      });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>All Facilities</CardTitle>
        <CardDescription>
          Every licence this company operates. A facility is a licence — a cultivation licence and a
          processing licence are two facilities even in one building, which is how the state tracks them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {facilities.map((f) => (
          <div key={f.id} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">
                  {f.name}
                  {f.code ? <span className="ml-2 text-xs font-mono text-muted-foreground">{f.code}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {[f.licenseType, f.licenseNumber, f.city, f.state].filter(Boolean).join(" · ") || "No licence details yet"}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setOpenPeopleFor(f.id)}>
                People
              </Button>
            </div>
          </div>
        ))}

        {isAdmin ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add facility
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Facilities are added by an Admin.</p>
        )}
      </CardContent>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a facility</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="nf-name">Facility Name *</Label>
              <Input id="nf-name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Bay City Processing" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="nf-code">Site Code *</Label>
                <Input
                  id="nf-code"
                  value={form.code}
                  onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                  placeholder="BC"
                  maxLength={4}
                />
                <p className="text-[11px] text-muted-foreground">
                  Two to four letters. It goes into the numbers of records raised here, so NC-BC-26-0001
                  says where it came from.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="nf-state">State *</Label>
                <Select value={form.state} onValueChange={(v) => setForm((p) => ({ ...p, state: v }))}>
                  <SelectTrigger id="nf-state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {US_STATES.map((st) => (
                      <SelectItem key={st} value={st}>{st}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="nf-license">License Number</Label>
                <Input id="nf-license" value={form.licenseNumber} onChange={(e) => setForm((p) => ({ ...p, licenseNumber: e.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="nf-type">License Type</Label>
                <Input id="nf-type" value={form.licenseType} onChange={(e) => setForm((p) => ({ ...p, licenseType: e.target.value }))} placeholder="Processor" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button disabled={create.isPending || !form.name.trim() || form.code.trim().length < 2} onClick={() => create.mutate()}>
              {create.isPending ? "Adding…" : "Add facility"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PeopleDialog
        facilityId={openPeopleFor}
        facilityName={facilities.find((f) => f.id === openPeopleFor)?.name ?? ""}
        isAdmin={isAdmin}
        onClose={() => setOpenPeopleFor(null)}
      />
    </Card>
  );
}

function PeopleDialog({
  facilityId,
  facilityName,
  isAdmin,
  onClose,
}: {
  facilityId: number | null;
  facilityName: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [toAdd, setToAdd] = useState("");

  const peopleKey = ["facility", facilityId, "people"] as const;
  const { data: people = [] } = useQuery<Person[]>({
    queryKey: peopleKey,
    enabled: facilityId != null,
    queryFn: async () => {
      const r = await fetch(`/api/facilities/${facilityId}/people`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load the people at this facility");
      return r.json();
    },
  });

  const { data: users = [] } = useQuery<AppUser[]>({
    queryKey: ["users", "all"],
    enabled: facilityId != null,
    queryFn: async () => {
      const r = await fetch("/api/users", { credentials: "include" });
      if (!r.ok) return [];
      const body = await r.json();
      return Array.isArray(body) ? body : (body.users ?? []);
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: peopleKey });
    queryClient.invalidateQueries({ queryKey: ["facilities"] });
  };

  const add = useMutation({
    mutationFn: async (userId: number) => {
      const r = await fetch(`/api/facilities/${facilityId}/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Failed to add");
      return r.json();
    },
    onSuccess: () => { setToAdd(""); refresh(); },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (userId: number) => {
      const r = await fetch(`/api/facilities/${facilityId}/people/${userId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Failed to remove");
      return r.json();
    },
    onSuccess: refresh,
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const here = new Set(people.map((p) => p.userId));
  const notHere = users.filter((u) => u.active && !here.has(u.id));

  return (
    <Dialog open={facilityId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>People at {facilityName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Somebody can only work at — and switch to — a facility they are listed at. This should match
            who the state has at this licence in METRC.
          </p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {people.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody yet.</p>
            ) : (
              people.map((p) => (
                <div key={p.userId} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <div>
                    <p className="text-sm">{p.fullName}</p>
                    <p className="text-xs text-muted-foreground">{p.role}</p>
                  </div>
                  {isAdmin ? (
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(p.userId)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {isAdmin ? (
            <div className="flex items-end gap-2">
              <div className="grid gap-2 flex-1">
                <Label htmlFor="add-person">Add someone</Label>
                <Select value={toAdd} onValueChange={setToAdd}>
                  <SelectTrigger id="add-person"><SelectValue placeholder="Choose a person" /></SelectTrigger>
                  <SelectContent>
                    {notHere.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>{u.fullName} — {u.role}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={!toAdd || add.isPending} onClick={() => add.mutate(parseInt(toAdd, 10))}>
                Add
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
