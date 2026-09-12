import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetCompanyProfile,
  useUpdateCompanyProfile,
  useListRegulatoryConfigs,
  useListUsers,
  useCreateUser,
  useUpdateUser,
  useGetCurrentUser,
  getGetCompanyProfileQueryKey,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DepartmentPicker } from "@/components/DepartmentPicker";
import { FacilitiesCard } from "@/components/settings/FacilitiesCard";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The zones a US cannabis operator can actually be in. IANA names, because that is
// what the date layer needs — an abbreviation like "EST" does not carry daylight
// saving and would be wrong for half the year.
const US_TIME_ZONES = [
  { value: "America/New_York",    label: "Eastern — New York, Michigan, Florida" },
  { value: "America/Chicago",     label: "Central — Illinois, Missouri, Texas" },
  { value: "America/Denver",      label: "Mountain — Colorado, New Mexico, Montana" },
  { value: "America/Phoenix",     label: "Arizona — Mountain, no daylight saving" },
  { value: "America/Los_Angeles", label: "Pacific — California, Washington, Nevada" },
  { value: "America/Anchorage",   label: "Alaska" },
  { value: "Pacific/Honolulu",    label: "Hawaii — no daylight saving" },
] as const;
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import {
  ShieldAlert,
  UserPlus,
  UserCheck,
  UserX,
  Pencil,
  Lock,
  Building2,
  FlaskConical,
  Users,
  Mail,
  Send,
  Eye,
  Clock,
  CheckCircle2,
  AlertCircle,
  Package,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";

// ── Constants ──────────────────────────────────────────────────────────────────

const ROLES = ["Admin", "Manager", "Supervisor", "Quality", "Operator"] as const;
type Role = (typeof ROLES)[number];

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  Admin:      "Full system access, user management, all modules",
  Manager:    "All modules, cannot manage users",
  Supervisor: "Batch records, inspections, non-conformances, testing",
  Quality:    "Read/write access to QC modules; read-only elsewhere",
  Operator:   "Production and batch record entry only",
};

const ROLE_COLORS: Record<Role, string> = {
  Admin:      "bg-red-100 text-red-800 border-red-300",
  Manager:    "bg-purple-100 text-purple-800 border-purple-300",
  Supervisor: "bg-blue-100 text-blue-800 border-blue-300",
  Quality:    "bg-green-100 text-green-800 border-green-300",
  Operator:   "bg-gray-100 text-gray-700 border-gray-300",
};

function RoleBadge({ role }: { role: string }) {
  const cls = ROLE_COLORS[role as Role] ?? "bg-gray-100 text-gray-700 border-gray-300";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {role}
    </span>
  );
}

// ── Add User Dialog ────────────────────────────────────────────────────────────

function AddUserDialog({ onCreated, onEditExisting }: { onCreated: () => void; onEditExisting: (userId: number) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", initials: "", role: "Operator" as Role });
  const [depts, setDepts] = useState<string[]>([]);
  // Session 70 — when the email already exists, the server returns the existing
  // user's id/name; we hold it here to show an "edit them instead" affordance in
  // the dialog rather than a dead-end toast that loses the admin's typed data.
  const [existing, setExisting] = useState<{ id: number; name: string; active: boolean } | null>(null);
  const createUser = useCreateUser();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName || !form.email || !form.initials) return;
    setExisting(null);
    createUser.mutate(
      { data: form },
      {
        onSuccess: async (created) => {
          const newId = (created as { id?: number } | undefined)?.id;
          if (newId && depts.length) {
            await fetch(`/api/users/${newId}`, {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ departments: depts }),
            }).catch(() => {});
          }
          toast({ title: "User added", description: `${form.fullName} has been added.` });
          setOpen(false);
          setForm({ fullName: "", email: "", initials: "", role: "Operator" });
          setDepts([]);
          onCreated();
        },
        onError: (err) => {
          // Surface the server's reason (e.g. duplicate-initials 409) instead
          // of a generic failure so the admin knows to pick distinct initials.
          const data = (err as { data?: { error?: string; existingUserId?: number; existingUserName?: string; existingUserActive?: boolean } } | null)?.data;
          // Duplicate-email 409 carries the existing user — show the inline
          // "edit instead" panel and keep the dialog (and typed data) open.
          if (data?.existingUserId != null) {
            setExisting({ id: data.existingUserId, name: data.existingUserName ?? form.email, active: data.existingUserActive ?? true });
            return;
          }
          toast({ title: "Error", description: data?.error ?? "Failed to add user.", variant: "destructive" });
        },
      },
    );
  };

  const goEditExisting = () => {
    if (!existing) return;
    const id = existing.id;
    setOpen(false);
    setExisting(null);
    setForm({ fullName: "", email: "", initials: "", role: "Operator" });
    onEditExisting(id);
  };

  const autoInitials = (name: string) =>
    name.split(" ").map((w) => w[0] ?? "").join("").toUpperCase().slice(0, 3);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setExisting(null); }}>
      <DialogTrigger asChild>
        <Button size="sm"><UserPlus className="h-4 w-4 mr-1.5" />Add User</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Team Member</DialogTitle>
          <DialogDescription>
            Create a new user account. They can sign in via Clerk using the email address below.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="add-fullName">Full Name *</Label>
            <Input
              id="add-fullName"
              value={form.fullName}
              onChange={(e) => {
                const name = e.target.value;
                setForm((f) => ({ ...f, fullName: name, initials: f.initials || autoInitials(name) }));
              }}
              placeholder="Jane Smith"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-email">Email *</Label>
            <Input
              id="add-email"
              type="email"
              value={form.email}
              onChange={(e) => { setForm((f) => ({ ...f, email: e.target.value })); if (existing) setExisting(null); }}
              placeholder="jane@facility.com"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="add-initials">Initials *</Label>
              <Input
                id="add-initials"
                value={form.initials}
                onChange={(e) =>
                  setForm((f) => ({ ...f, initials: e.target.value.toUpperCase().slice(0, 3) }))
                }
                placeholder="JS"
                maxLength={3}
                required
              />
              <p className="text-xs text-muted-foreground">Used for Part 11 e-signatures</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-role">Role *</Label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v as Role }))}>
                <SelectTrigger id="add-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Departments</Label>
            <DepartmentPicker value={depts} onChange={setDepts} />
            <p className="text-xs text-muted-foreground">Which departments this person works in (used to target training).</p>
          </div>
          {form.role && (
            <p className="text-xs text-muted-foreground bg-muted rounded px-3 py-2">
              <span className="font-medium">{form.role}:</span>{" "}
              {ROLE_DESCRIPTIONS[form.role as Role]}
            </p>
          )}
          {/* Session 70 — duplicate-email affordance. Rather than a dead-end
              error, point the admin straight at the existing account (often
              auto-created by Clerk on first sign-in) to edit instead. */}
          {existing && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-2">
                <p className="text-sm text-amber-900">
                  <span className="font-semibold">{existing.name}</span> already uses this email
                  {!existing.active && " (currently inactive)"}. You don't need to create a new account.
                </p>
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={goEditExisting}>
                  <UserCheck className="h-3.5 w-3.5 mr-1" />Edit {existing.name} instead
                </Button>
              </div>
            </div>
          )}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createUser.isPending}>
              {createUser.isPending ? "Adding…" : "Add User"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit User Dialog ───────────────────────────────────────────────────────────
// Admin-only editor for a user's identity fields (full name, initials, email).
// Role and active status are edited inline on the row; this dialog covers the
// rest. Email is editable but warned: it's tied to the user's Clerk sign-in and
// Part 11 signature attribution, so changing it updates the record without
// changing how they actually log in. Reuses PATCH /users/:id (UpdateUserBody),
// which already enforces unique initials + case-insensitive email (excluding
// self); the server's 409 message is surfaced inline.
function EditUserDialog({ user, onUpdated }: { user: User; onUpdated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: user.fullName, email: user.email, initials: user.initials ?? "" });
  const [depts, setDepts] = useState<string[]>((user as { departments?: string[] }).departments ?? []);
  const [error, setError] = useState<string | null>(null);
  const updateUser = useUpdateUser();
  const { toast } = useToast();

  // Re-sync to the latest values each time the dialog opens (the row's role can
  // change underneath it, and we never want a stale name/email pre-filled).
  useEffect(() => {
    if (open) {
      setForm({ fullName: user.fullName, email: user.email, initials: user.initials ?? "" });
      setDepts((user as { departments?: string[] }).departments ?? []);
      setError(null);
    }
  }, [open, user]);

  const emailChanged = form.email.trim().toLowerCase() !== (user.email ?? "").toLowerCase();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName.trim() || !form.email.trim() || !form.initials.trim()) return;
    setError(null);
    updateUser.mutate(
      { id: user.id, data: { fullName: form.fullName.trim(), email: form.email.trim(), initials: form.initials.trim() } },
      {
        onSuccess: async () => {
          await fetch(`/api/users/${user.id}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ departments: depts }),
          }).catch(() => {});
          toast({ title: "User updated", description: `${form.fullName.trim()} has been updated.` });
          setOpen(false);
          onUpdated();
        },
        onError: (err) => {
          // Surface the server reason (e.g. duplicate-initials / duplicate-email
          // 409) inline so the admin can correct it without losing typed data.
          const msg = (err as { data?: { error?: string } } | null)?.data?.error ?? "Failed to update user.";
          setError(msg);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 text-xs" data-testid={`button-edit-user-${user.id}`}>
          <Pencil className="h-3.5 w-3.5 mr-1" />Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {user.fullName}</DialogTitle>
          <DialogDescription>
            Update this user's name, initials, or email. Role and status are changed on the table row.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-fullName">Full Name *</Label>
            <Input
              id="edit-fullName"
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initials">Initials *</Label>
            <Input
              id="edit-initials"
              value={form.initials}
              onChange={(e) => setForm((f) => ({ ...f, initials: e.target.value.toUpperCase().slice(0, 3) }))}
              maxLength={3}
              required
            />
            <p className="text-xs text-muted-foreground">Used for Part 11 e-signatures.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-email">Email *</Label>
            <Input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={(e) => { setForm((f) => ({ ...f, email: e.target.value })); if (error) setError(null); }}
              required
            />
            {emailChanged && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-xs text-amber-900">
                  This email is tied to the user's sign-in (Clerk) and Part 11 signature attribution.
                  Changing it updates the record but not how they actually log in — only change it if
                  this account should use the new address.
                </p>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Departments</Label>
            <DepartmentPicker value={depts} onChange={setDepts} />
            <p className="text-xs text-muted-foreground">Which departments this person works in (used to target training).</p>
          </div>
          {error && (
            <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
          )}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={updateUser.isPending}>
              {updateUser.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── User Row ───────────────────────────────────────────────────────────────────

function UserRow({
  user,
  isCurrentUser,
  isAdmin,
  onUpdated,
  highlighted = false,
}: {
  user: User;
  isCurrentUser: boolean;
  isAdmin: boolean;
  onUpdated: () => void;
  highlighted?: boolean;
}) {
  const updateUser = useUpdateUser();
  const { toast } = useToast();
  // Session 70 — scroll this row into view when it's the "edit existing user"
  // target picked from the Add User duplicate-email panel.
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  const patch = (data: { role?: string; active?: boolean }, msg: string) =>
    updateUser.mutate(
      { id: user.id, data },
      {
        onSuccess: () => { toast({ title: msg }); onUpdated(); },
        onError: () => toast({ title: "Error", description: "Failed to update user.", variant: "destructive" }),
      },
    );

  return (
    <TableRow
      ref={rowRef}
      className={`${!user.active ? "opacity-60" : ""} ${highlighted ? "ring-2 ring-inset ring-amber-400 bg-amber-50/60 transition-colors" : ""}`.trim() || undefined}
    >
      {/* Name + email */}
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-primary">{user.initials}</span>
          </div>
          <div>
            <div className="text-sm font-medium leading-none">
              {user.fullName}
              {isCurrentUser && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">(you)</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{user.email}</div>
          </div>
        </div>
      </TableCell>

      {/* Role */}
      <TableCell>
        {isAdmin && !isCurrentUser ? (
          <Select
            value={user.role}
            onValueChange={(v) => patch({ role: v }, `${user.fullName} is now ${v}`)}
            disabled={updateUser.isPending}
          >
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <RoleBadge role={user.role} />
        )}
      </TableCell>

      {/* Status */}
      <TableCell>
        <Badge variant={user.active ? "default" : "secondary"} className="text-xs">
          {user.active ? "Active" : "Inactive"}
        </Badge>
      </TableCell>

      {/* Added */}
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {format(new Date(user.createdAt), "MMM d, yyyy")}
      </TableCell>

      {/* Actions — Admin only, cannot act on self */}
      <TableCell className="text-right">
        {isAdmin && !isCurrentUser && (
          <div className="flex items-center justify-end gap-1">
            <EditUserDialog user={user} onUpdated={onUpdated} />
            {user.active ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost" size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  disabled={updateUser.isPending}
                >
                  <UserX className="h-3.5 w-3.5 mr-1" />Deactivate
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Deactivate {user.fullName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will prevent them from signing in. All their records and audit history are
                    preserved. You can reactivate them at any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => patch({ active: false }, `${user.fullName} deactivated`)}
                  >
                    Deactivate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="ghost" size="sm"
              className="h-7 text-xs text-green-700 hover:text-green-700"
              onClick={() => patch({ active: true }, `${user.fullName} reactivated`)}
              disabled={updateUser.isPending}
            >
              <UserCheck className="h-3.5 w-3.5 mr-1" />Reactivate
            </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// ── User Management Tab ────────────────────────────────────────────────────────

function UserManagementTab() {
  const { data: currentUser, isLoading: meLoading } = useGetCurrentUser();
  const { data: users = [], isLoading: usersLoading } = useListUsers();
  const queryClient = useQueryClient();

  // Treat a failed /me call (e.g. 401 in dev) the same as "not admin"
  const isAdmin      = currentUser?.role === "Admin";
  const meResolved   = !meLoading;
  const active       = users.filter((u) => u.active);
  const inactive     = users.filter((u) => !u.active);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  // Session 70 — when "Add User" hits an existing email, we scroll to + briefly
  // highlight that user's row so the admin can edit them in place. Auto-clears.
  const [highlightUserId, setHighlightUserId] = useState<number | null>(null);
  useEffect(() => {
    if (highlightUserId == null) return;
    const t = setTimeout(() => setHighlightUserId(null), 4000);
    return () => clearTimeout(t);
  }, [highlightUserId]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">Team Members</h2>
          <p className="text-sm text-muted-foreground">
            {usersLoading ? "Loading…" : `${active.length} active · ${inactive.length} inactive`}
          </p>
        </div>
        {isAdmin && <AddUserDialog onCreated={refresh} onEditExisting={setHighlightUserId} />}
      </div>

      {/* Read-only notice for non-Admins */}
      {meResolved && !isAdmin && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">
            <span className="font-semibold">Read-only view.</span> Only users with the{" "}
            <span className="font-mono text-xs font-bold">Admin</span> role can change roles or
            deactivate accounts. Contact your system administrator to make changes.
          </p>
        </div>
      )}

      {/* Role legend — Admin only */}
      {isAdmin && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2.5">
            Role Permissions
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
            {ROLES.map((r) => (
              <div key={r} className="flex items-start gap-2 text-xs">
                <RoleBadge role={r} />
                <span className="text-muted-foreground leading-tight pt-0.5">
                  {ROLE_DESCRIPTIONS[r]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Part 11 note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldAlert className="h-4 w-4 shrink-0 text-primary mt-0.5" />
        <span>
          All role changes and account status updates are written to the Audit Log per{" "}
          <span className="font-mono">21 CFR Part 11 §11.10(d)</span> — limiting system access
          to authorised individuals only.
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <div className="space-y-1">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-44" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-14 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell />
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No users found.{isAdmin ? " Add the first team member above." : ""}
                </TableCell>
              </TableRow>
            ) : (
              [...active, ...inactive].map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isCurrentUser={user.id === currentUser?.id}
                  isAdmin={isAdmin}
                  onUpdated={refresh}
                  highlighted={user.id === highlightUserId}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── Company Profile Tab ────────────────────────────────────────────────────────

function CompanyProfileTab() {
  const { data: company, isLoading } = useGetCompanyProfile();
  const updateCompany = useUpdateCompanyProfile();
  const queryClient   = useQueryClient();
  const { toast }     = useToast();

  const [form, setForm] = useState({
    companyName: "", licenseNumber: "", address: "",
    city: "", state: "", zip: "", phone: "", email: "", contactPerson: "",
  });

  useEffect(() => {
    if (company) {
      setForm({
        companyName:   company.companyName   || "",
        licenseNumber: company.licenseNumber || "",
        address:       company.address       || "",
        city:          company.city          || "",
        state:         company.state         || "",
        zip:           company.zip           || "",
        phone:         company.phone         || "",
        email:         company.email         || "",
        contactPerson: company.contactPerson || "",
      });
    }
  }, [company]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateCompany.mutate(
      { data: form },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyProfileQueryKey() });
          toast({ title: "Settings saved", description: "Company profile updated." });
        },
        onError: () =>
          toast({ title: "Error", description: "Failed to save.", variant: "destructive" }),
      },
    );
  };

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [field]: e.target.value }));

  // Session 97 (#15) — supplier risk-scoring opt-in lives on the company profile.
  const scoringOn = !!(company as { supplierScoringEnabled?: boolean } | undefined)?.supplierScoringEnabled;
  const toggleScoring = () =>
    updateCompany.mutate(
      { data: { supplierScoringEnabled: !scoringOn } as never },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyProfileQueryKey() });
          toast({ title: scoringOn ? "Supplier scoring turned off" : "Supplier scoring turned on" });
        },
        onError: () => toast({ title: "Error", description: "Failed to update.", variant: "destructive" }),
      },
    );

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>Company Profile</CardTitle>
        <CardDescription>Update your facility's licensing and location information.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="companyName">Company Name</Label>
              <Input id="companyName" value={form.companyName} onChange={f("companyName")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="licenseNumber">State License Number</Label>
              <Input id="licenseNumber" value={form.licenseNumber} onChange={f("licenseNumber")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contactPerson">Contact Person</Label>
              <Input id="contactPerson" value={form.contactPerson} onChange={f("contactPerson")} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="s-email">Email</Label>
                <Input id="s-email" type="email" value={form.email} onChange={f("email")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" value={form.phone} onChange={f("phone")} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" value={form.address} onChange={f("address")} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="city">City</Label>
                <Input id="city" value={form.city} onChange={f("city")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="s-state">State</Label>
                <Input id="s-state" value={form.state} onChange={f("state")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="zip">ZIP Code</Label>
                <Input id="zip" value={form.zip} onChange={f("zip")} />
              </div>
            </div>
            <Button type="submit" disabled={updateCompany.isPending}>
              {updateCompany.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>

    {/* Multi-facility Phase 1 (2026-08-28) — THE facility. */}
    <FacilityCard />

    {/* Phase 1 slice 3 — the METRC connection, which belongs to the licence. */}
    <FacilityMetrcCard />

    {/* Phase 4 (2026-08-28) — the estate. Every licence the company operates. */}
    <FacilitiesCard />

    {/* Session 97 (#15) — supplier risk-scoring opt-in. Off by default so the
        ISO-13485-style tier alarms don't fire before the facility adopts scoring. */}
    <Card>
      <CardHeader>
        <CardTitle>Supplier Risk Scoring</CardTitle>
        <CardDescription>Control whether supplier risk tiers and alarms are active facility-wide.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Risk-tier alarms are {scoringOn ? "ON" : "OFF"}</p>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
              {scoringOn
                ? "Suppliers show Critical / High risk tiers, alert chips, and row highlighting driven by the computed score."
                : "The numeric score still shows, but as neutral information — no risk-tier alarms, alert chips, or row highlighting. Turn this on once you've defined your facility's own scoring process."}
            </p>
          </div>
          <Button type="button" variant={scoringOn ? "outline" : "default"} size="sm" disabled={updateCompany.isPending} onClick={toggleScoring}>
            {updateCompany.isPending ? "Saving…" : scoringOn ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}

// ── Facility Card ──────────────────────────────────────────────────────────────
//
// Multi-facility Phase 1 (2026-08-28). THE facility — the operating site every
// record belongs to.
//
// ⛔ A FACILITY IS A LICENCE (his ruling 08-27): a company with a cultivation
// licence, a processing licence and three stores has five facilities, exactly as
// METRC sees it. Today there is one, seeded from the company profile above, so
// nothing else in the app looks any different. Adding a second one — with the
// facility switcher and the corporate cross-site view — is Phase 4.
//
// The facility TIME ZONE lives here now rather than on the company profile: an
// operator running Michigan and Missouri plants has two calendars, and a date-only
// field is the day where the person was standing.

// The CRA licence vocabulary, matching the licence register on /licenses. Free
// text underneath, because the list differs by state and a second state is the
// whole point of this work.
const FACILITY_LICENSE_TYPES = [
  "Grower – Class A",
  "Grower – Class B",
  "Grower – Class C",
  "Excess Grower",
  "Processor",
  "Retailer",
  "Microbusiness",
  "Class A Microbusiness",
  "Secure Transporter",
  "Safety Compliance Facility",
  "Designated Consumption Establishment",
  "Event Organizer",
  "Other",
] as const;

type FacilityRow = {
  id: number;
  name: string;
  code: string | null;
  licenseNumber: string | null;
  licenseType: string | null;
  state: string;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  contactPerson: string | null;
  timeZone: string | null;
  isActive: boolean;
};

const FACILITY_QUERY_KEY = ["facility", "primary"] as const;

function FacilityCard() {
  const { data: currentUser } = useGetCurrentUser();
  const canEdit = ["Admin", "Quality", "Manager"].includes(currentUser?.role ?? "");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: facility, isLoading } = useQuery<FacilityRow>({
    queryKey: FACILITY_QUERY_KEY,
    queryFn: async () => {
      const r = await fetch("/api/facilities/primary", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load facility");
      return r.json();
    },
  });

  const [form, setForm] = useState({
    name: "", code: "", licenseNumber: "", licenseType: "", state: "",
    address: "", city: "", zip: "", phone: "", contactPerson: "", timeZone: "",
  });

  useEffect(() => {
    if (facility) {
      setForm({
        name:          facility.name          || "",
        code:          facility.code          || "",
        licenseNumber: facility.licenseNumber || "",
        licenseType:   facility.licenseType   || "",
        state:         facility.state         || "MI",
        address:       facility.address       || "",
        city:          facility.city          || "",
        zip:           facility.zip           || "",
        phone:         facility.phone         || "",
        contactPerson: facility.contactPerson || "",
        timeZone:      facility.timeZone      || "",
      });
    }
  }, [facility]);

  const save = useMutation({
    mutationFn: async () => {
      if (!facility) throw new Error("No facility loaded");
      const r = await fetch(`/api/facilities/${facility.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to save facility");
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FACILITY_QUERY_KEY });
      toast({ title: "Facility saved", description: "Facility details updated." });
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [field]: e.target.value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Facility</CardTitle>
        <CardDescription>
          The licensed site this system's records belong to. A facility is a licence — a company
          holding a cultivation licence and a processing licence operates two facilities, which is
          how the state tracks them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
            className="space-y-4"
          >
            <div className="grid grid-cols-[1fr_120px] gap-4">
              <div className="grid gap-2">
                <Label htmlFor="fac-name">Facility Name</Label>
                <Input id="fac-name" value={form.name} onChange={f("name")} disabled={!canEdit} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fac-code">Site Code</Label>
                <Input
                  id="fac-code"
                  value={form.code}
                  onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                  maxLength={4}
                  placeholder="DE"
                  disabled={!canEdit}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-2">
              The site code goes into the numbers of records raised here, so NC-DE-26-0001 says where
              it came from. Two to four letters, and no two sites may share one.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="fac-license">License Number</Label>
                <Input id="fac-license" value={form.licenseNumber} onChange={f("licenseNumber")} disabled={!canEdit} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fac-license-type">License Type</Label>
                {/* ⛔ THE `key` IS LOAD-BEARING — do not remove it.
                    This select mounts before the facility has been fetched, so its value
                    is empty on the first render and only becomes "Processor" a moment
                    later. Radix does not pick that up: the trigger keeps its
                    data-placeholder state and goes on reading "Select a license type"
                    while the licence type is sitting in the database. Verified against
                    the deployed build, not assumed — passing the value instead of
                    `undefined` was NOT enough on its own.
                    Re-keying on the value remounts the select the moment the real value
                    arrives, so it mounts WITH a value, which is the arrangement that
                    works — it is why the Time Zone select below has never had this
                    problem (it falls back to a real zone from the very first render).
                    Any select on this page fed from an async fetch needs the same. */}
                <Select
                  key={`fac-license-type-${form.licenseType}`}
                  value={form.licenseType}
                  onValueChange={(v) => setForm((p) => ({ ...p, licenseType: v }))}
                  disabled={!canEdit}
                >
                  <SelectTrigger id="fac-license-type"><SelectValue placeholder="Select a license type" /></SelectTrigger>
                  <SelectContent>
                    {FACILITY_LICENSE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fac-contact">Site Contact</Label>
              <Input id="fac-contact" value={form.contactPerson} onChange={f("contactPerson")} disabled={!canEdit} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fac-address">Address</Label>
              <Input id="fac-address" value={form.address} onChange={f("address")} disabled={!canEdit} />
            </div>
            <div className="grid grid-cols-4 gap-4">
              <div className="grid gap-2 col-span-2">
                <Label htmlFor="fac-city">City</Label>
                <Input id="fac-city" value={form.city} onChange={f("city")} disabled={!canEdit} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fac-state">State</Label>
                <Input id="fac-state" value={form.state} onChange={f("state")} disabled={!canEdit} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fac-zip">ZIP Code</Label>
                <Input id="fac-zip" value={form.zip} onChange={f("zip")} disabled={!canEdit} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fac-phone">Phone</Label>
              <Input id="fac-phone" value={form.phone} onChange={f("phone")} disabled={!canEdit} />
            </div>
            {/* The facility's time zone. Every date-only field in the system — approval
                dates, effective dates, training due dates, and the packagedDate reported
                to METRC — is a calendar day AT THIS SITE, so this decides which day they
                fall on. Deliberately not the viewer's zone: one act must not get two
                dates depending on who signed it. */}
            <div className="grid gap-2">
              <Label htmlFor="fac-timezone">Time Zone</Label>
              <Select
                value={form.timeZone || "America/New_York"}
                onValueChange={(v) => setForm((p) => ({ ...p, timeZone: v }))}
                disabled={!canEdit}
              >
                <SelectTrigger id="fac-timezone"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {US_TIME_ZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Sets the calendar day recorded on approvals, effective dates, training due dates and
                the packaged date sent to METRC. Signature timestamps are unaffected — they are exact
                moments and already display correctly wherever they are read.
              </p>
            </div>
            {canEdit ? (
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save Facility"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Facility details are edited by Admin, Quality or Manager.
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ── Facility METRC Connection ──────────────────────────────────────────────────
//
// Phase 1 slice 3 (2026-08-28). A facility IS a licence and METRC issues its
// credentials per licence, so the connection belongs here rather than to an
// environment variable shared by whatever the server happens to be running. The
// host differs by state too, which is why a second state needs this before it
// needs anything else.
//
// ⛔ THE KEYS ARE NEVER SENT BACK. The server reports whether each half is set and
// where it is coming from; the boxes below are always empty on load and only carry
// a value while somebody is typing a new one. Leaving them blank saves everything
// else and leaves the keys alone.

type FacilityMetrc = {
  facilityId: number;
  metrcBaseUrl: string | null;
  metrcLicenseNumber: string | null;
  hasVendorKey: boolean;
  hasUserKey: boolean;
  updatedByName: string | null;
  updatedAt: string | null;
  effective: {
    configured: boolean;
    baseUrl: string;
    isSandbox: boolean;
    licenseNumber: string | null;
    source: { vendorKey: string; userKey: string; baseUrl: string; licenseNumber: string };
  };
};

function FacilityMetrcCard() {
  const { data: currentUser } = useGetCurrentUser();
  const isAdmin = currentUser?.role === "Admin";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: facility } = useQuery<FacilityRow>({
    queryKey: FACILITY_QUERY_KEY,
    queryFn: async () => {
      const r = await fetch("/api/facilities/primary", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load facility");
      return r.json();
    },
  });

  const metrcKey = ["facility", "metrc", facility?.id] as const;
  const { data: metrc, isLoading } = useQuery<FacilityMetrc>({
    queryKey: metrcKey,
    enabled: !!facility?.id,
    queryFn: async () => {
      const r = await fetch(`/api/facilities/${facility!.id}/metrc`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load the METRC connection");
      return r.json();
    },
  });

  const [baseUrl, setBaseUrl] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [vendorKey, setVendorKey] = useState("");
  const [userKey, setUserKey] = useState("");

  useEffect(() => {
    if (metrc) {
      setBaseUrl(metrc.metrcBaseUrl || "");
      setLicenseNumber(metrc.metrcLicenseNumber || "");
      setVendorKey("");
      setUserKey("");
    }
  }, [metrc]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/facilities/${facility!.id}/metrc`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ metrcBaseUrl: baseUrl, metrcLicenseNumber: licenseNumber, vendorKey, userKey }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to save the METRC connection");
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: metrcKey });
      setVendorKey("");
      setUserKey("");
      toast({ title: "METRC connection saved", description: "In effect from the next METRC call." });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const src = metrc?.effective.source;
  const sourceLabel = (v: string | undefined) =>
    v === "facility"
      ? "from this facility"
      : v === "environment"
        ? "from the environment"
        : v === "default"
          ? "the built-in default"
          : "not set";

  return (
    <Card>
      <CardHeader>
        <CardTitle>METRC Connection</CardTitle>
        <CardDescription>
          The state tracking credentials for this licence. METRC issues them per licence, so each
          facility connects with its own — and the host differs by state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {metrc?.effective.configured ? "Connected" : "Not configured"}
                {metrc?.effective.isSandbox ? " · sandbox" : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Host {sourceLabel(src?.baseUrl)} · licence {sourceLabel(src?.licenseNumber)} · vendor key{" "}
                {sourceLabel(src?.vendorKey)} · user key {sourceLabel(src?.userKey)}.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Anything not set here keeps using the server's environment variables, exactly as before.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="metrc-license">METRC License Number</Label>
                <Input
                  id="metrc-license"
                  value={licenseNumber}
                  onChange={(e) => setLicenseNumber(e.target.value)}
                  placeholder={metrc?.effective.licenseNumber || "e.g. SF-SBX-MI-6-13501"}
                  disabled={!isAdmin}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="metrc-base-url">METRC Host</Label>
                <Input
                  id="metrc-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={metrc?.effective.baseUrl || "https://sandbox-api-mi.metrc.com"}
                  disabled={!isAdmin}
                />
              </div>
            </div>

            {isAdmin && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="metrc-vendor-key">Vendor Key</Label>
                    <Input
                      id="metrc-vendor-key"
                      type="password"
                      autoComplete="off"
                      value={vendorKey}
                      onChange={(e) => setVendorKey(e.target.value)}
                      placeholder={metrc?.hasVendorKey ? "Stored — leave blank to keep" : "Not set"}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="metrc-user-key">User Key</Label>
                    <Input
                      id="metrc-user-key"
                      type="password"
                      autoComplete="off"
                      value={userKey}
                      onChange={(e) => setUserKey(e.target.value)}
                      placeholder={metrc?.hasUserKey ? "Stored — leave blank to keep" : "Not set"}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Keys are never shown again once saved. Leave a box blank to keep the stored key; type{" "}
                  <span className="font-mono">clear</span> to remove it and hand that half back to the
                  environment. The user key is the one that rotates — replace it here when METRC issues a
                  new one, and the vendor key it is paired with must match.
                </p>
                <div className="flex items-center gap-3">
                  <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? "Saving…" : "Save Connection"}
                  </Button>
                  {metrc?.updatedByName && metrc.updatedAt ? (
                    <span className="text-xs text-muted-foreground">
                      Last changed by {metrc.updatedByName} on {format(new Date(metrc.updatedAt), "MMM d, yyyy")}
                    </span>
                  ) : null}
                </div>
              </>
            )}
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">
                The METRC credentials are changed by an Admin.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Regulatory Config Tab ──────────────────────────────────────────────────────

const INV_CADENCES = ["Monthly", "Quarterly", "Semiannual", "Annual", "None"];

function InventoryCheckCadenceCard() {
  const { toast } = useToast();
  const [cadence, setCadence] = useState("Quarterly");
  const [graceDays, setGraceDays] = useState("0");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/inventory-check-settings", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d) { setCadence(d.cadence ?? "Quarterly"); setGraceDays(String(d.graceDays ?? 0)); } })
      .catch(() => {})
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  const save = async (nextCadence: string, nextGrace: string) => {
    setSaving(true);
    try {
      const r = await fetch("/api/inventory-check-settings", {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: nextCadence, graceDays: Number(nextGrace) || 0 }),
      });
      if (!r.ok) throw new Error("Save failed");
      toast({ title: "Inventory check cadence saved" });
    } catch {
      toast({ title: "Error", description: "Could not save cadence.", variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventory Check Cadence</CardTitle>
        <CardDescription>How often a physical inventory count / METRC reconciliation is due. Drives the due-date and overdue flag on the Inventory Checks page.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-52">
            <Label className="text-xs">Cadence</Label>
            <Select value={cadence} onValueChange={(v) => { setCadence(v); void save(v, graceDays); }} disabled={!loaded || saving}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {INV_CADENCES.map((c) => <SelectItem key={c} value={c}>{c === "None" ? "None (no schedule)" : c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <Label className="text-xs">Grace period (days)</Label>
            <Input className="mt-1" type="number" min="0" value={graceDays}
              onChange={(e) => setGraceDays(e.target.value)}
              onBlur={() => void save(cadence, graceDays)} disabled={!loaded || saving || cadence === "None"} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// What the SERVER resolves for the facility this session is acting for. The list
// endpoint says which rule sets exist; this says which one is actually in force.
// Asked of the server rather than matched in the UI on purpose — state is stored
// as a short code in one table and (historically) a full name in the other, and
// duplicating that normalisation here is how the two drift apart.
type ResolvedRegulatory = {
  facilityId: number | null;
  facilityState: string | null;
  state: string | null;
  /** id of the row in force. ⛔ Match on THIS — the row holds "MI" while `state`
   *  is the normalized "MICHIGAN", so comparing those two is always false. */
  configId: number | null;
  configured: boolean;
};

function RegulatoryTab() {
  const { data: regulatory, isLoading } = useListRegulatoryConfigs();

  const { data: resolved } = useQuery<ResolvedRegulatory>({
    queryKey: ["regulatory-config", "resolved"],
    queryFn: async () => {
      const r = await fetch("/api/regulatory-config/resolved", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to resolve the regulatory rule set");
      return r.json();
    },
  });

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>Regulatory Configuration</CardTitle>
        <CardDescription>
          The rule set for each state this operator is licensed in. Your facility is held to the
          one marked below; the others are here so a second site in another state has somewhere
          to resolve to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : !regulatory?.length ? (
          <p className="text-sm text-muted-foreground">No regulatory rules configured.</p>
        ) : (
          <div className="space-y-6">
            {regulatory.map((config) => (
              <div key={config.id} className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-lg">{config.state}</h3>
                    {resolved?.configured && resolved.configId === config.id && (
                      <Badge variant="default" data-testid={`badge-applies-${config.state}`}>
                        Applies to your facility
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Record retention: {config.retentionYears} years
                  </div>
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Max THC / serving</dt>
                    <dd className="font-medium">{config.maxThcPerServing} mg</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Max THC / container</dt>
                    <dd className="font-medium">{config.maxThcPerContainer} mg</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Potency tolerance</dt>
                    <dd className="font-medium">±{config.potencyTolerancePct}%</dd>
                  </div>
                  {config.tracingSystem && (
                    <div>
                      <dt className="text-muted-foreground">Tracing System</dt>
                      <dd className="font-medium">{config.tracingSystem}</dd>
                    </div>
                  )}
                </dl>
                {config.additionalConfig && (
                  <div className="bg-muted p-4 rounded-md text-sm font-mono whitespace-pre-wrap">
                    {JSON.stringify(config.additionalConfig, null, 2)}
                  </div>
                )}
                <Separator />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
    <InventoryCheckCadenceCard />
    </div>
  );
}

// ── Digest Email Tab ────────────────────────────────────────────────────────────

type DigestSettings = {
  id: number;
  complianceRecipients: string;
  inventoryRecipients: string;
  sendHourUtc: number;
  sendDayOfWeek: number;
  enabled: number;
  lastComplianceSentAt: string | null;
  lastInventorySentAt: string | null;
  updatedAt: string;
};

const BASE = import.meta.env.BASE_URL ?? "/";

async function fetchDigestSettings(): Promise<DigestSettings> {
  const r = await fetch(`${BASE}api/digest/settings`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load digest settings");
  return r.json() as Promise<DigestSettings>;
}

async function patchDigestSettings(patch: Partial<DigestSettings>): Promise<DigestSettings> {
  const r = await fetch(`${BASE}api/digest/settings`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error("Failed to save digest settings");
  return r.json() as Promise<DigestSettings>;
}

async function triggerDigest(type: "compliance" | "inventory"): Promise<{ sent: number; skipped: string[] }> {
  const r = await fetch(`${BASE}api/digest/send/${type}`, { method: "POST", credentials: "include" });
  if (!r.ok) throw new Error("Failed to send digest");
  return r.json() as Promise<{ sent: number; skipped: string[] }>;
}

const UTC_HOURS = Array.from({ length: 24 }, (_, i) => {
  const label = i === 0 ? "12:00 AM UTC (midnight)" : i < 12 ? `${i}:00 AM UTC` : i === 12 ? "12:00 PM UTC (noon)" : `${i - 12}:00 PM UTC`;
  return { value: i, label };
});

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function LastSentBadge({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground text-xs">Never sent</span>;
  return (
    <span className="flex items-center gap-1 text-xs text-green-700">
      <CheckCircle2 className="h-3 w-3" />
      Last sent {format(new Date(at), "MMM d, yyyy 'at' h:mm a")}
    </span>
  );
}

function DigestEmailTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState<"compliance" | "inventory" | null>(null);

  const [complianceRecipients, setComplianceRecipients] = useState("");
  const [inventoryRecipients, setInventoryRecipients] = useState("");
  const [sendHourUtc, setSendHourUtc] = useState(12);
  const [sendDayOfWeek, setSendDayOfWeek] = useState(1);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    fetchDigestSettings()
      .then((s) => {
        setSettings(s);
        setComplianceRecipients(s.complianceRecipients);
        setInventoryRecipients(s.inventoryRecipients);
        setSendHourUtc(s.sendHourUtc);
        setSendDayOfWeek(s.sendDayOfWeek ?? 1);
        setEnabled(s.enabled !== 0);
      })
      .catch(() => toast({ title: "Failed to load digest settings", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await patchDigestSettings({
        complianceRecipients,
        inventoryRecipients,
        sendHourUtc,
        sendDayOfWeek,
        enabled: enabled ? 1 : 0,
      });
      setSettings(updated);
      toast({ title: "Digest settings saved" });
    } catch {
      toast({ title: "Failed to save settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleSend = async (type: "compliance" | "inventory") => {
    setSending(type);
    try {
      const result = await triggerDigest(type);
      if (result.sent > 0) {
        toast({ title: `Digest sent to ${result.sent} recipient${result.sent > 1 ? "s" : ""}` });
        const updated = await fetchDigestSettings();
        setSettings(updated);
      } else {
        toast({
          title: "No emails sent",
          description: result.skipped.length > 0 ? result.skipped.join(", ") : "No recipients configured or Resend API key not set.",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "Failed to send digest", variant: "destructive" });
    } finally {
      setSending(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64 mt-1" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Schedule */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Weekly Snapshot Emails
              </CardTitle>
              <CardDescription>
                Automated weekly compliance and inventory snapshots sent once per week on a chosen day and time.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            <Label className="w-36 shrink-0">Send day</Label>
            <Select value={String(sendDayOfWeek)} onValueChange={(v) => setSendDayOfWeek(Number(v))}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OF_WEEK.map((d) => (
                  <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0 opacity-0" aria-hidden />
            <Label className="w-36 shrink-0">Send time (UTC)</Label>
            <Select value={String(sendHourUtc)} onValueChange={(v) => setSendHourUtc(Number(v))}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UTC_HOURS.map((h) => (
                  <SelectItem key={h.value} value={String(h.value)}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Compliance Digest */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-500" />
            Compliance Digest
          </CardTitle>
          <CardDescription>
            Proactive weekly snapshot: CAPA action items and NC close dates due in the next 7 days, items already overdue, plus open NCs, complaints, field actions, and flagged batches. Sent to QA/compliance staff.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="compliance-recipients">Recipients (comma-separated emails)</Label>
            <Input
              id="compliance-recipients"
              placeholder="sarah.chen@facility.com, priya.patel@facility.com"
              value={complianceRecipients}
              onChange={(e) => setComplianceRecipients(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Users with Admin or Quality roles receive this by default when configured.</p>
          </div>
          <div className="flex items-center justify-between pt-1">
            <LastSentBadge at={settings?.lastComplianceSentAt ?? null} />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => window.open(`${BASE}api/digest/preview/compliance`, "_blank")}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={sending === "compliance"}
                onClick={() => handleSend("compliance")}
              >
                <Send className="h-3.5 w-3.5" />
                {sending === "compliance" ? "Sending…" : "Send Now"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Inventory Digest */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-blue-500" />
            Inventory & Production Digest
          </CardTitle>
          <CardDescription>
            Covers low-stock inventory items, all inventory levels, batch status breakdown, and pending lab test results. Sent to operations/management.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="inventory-recipients">Recipients (comma-separated emails)</Label>
            <Input
              id="inventory-recipients"
              placeholder="marcus.rivera@facility.com, linda.torres@facility.com"
              value={inventoryRecipients}
              onChange={(e) => setInventoryRecipients(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Users with Manager or Supervisor roles receive this by default when configured.</p>
          </div>
          <div className="flex items-center justify-between pt-1">
            <LastSentBadge at={settings?.lastInventorySentAt ?? null} />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => window.open(`${BASE}api/digest/preview/inventory`, "_blank")}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={sending === "inventory"}
                onClick={() => handleSend("inventory")}
              >
                <Send className="h-3.5 w-3.5" />
                {sending === "inventory" ? "Sending…" : "Send Now"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? "Saving…" : "Save Settings"}
        </Button>
      </div>

      {/* Info box */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 space-y-1">
        <p className="font-semibold">How weekly snapshot emails work</p>
        <ul className="list-disc list-inside space-y-0.5 text-blue-700">
          <li>Emails fire once per week on the chosen day at the chosen UTC time.</li>
          <li>The compliance snapshot leads with items <strong>due in the next 7 days</strong> (CAPA actions, NC close dates, effectiveness checks), then shows already-overdue items, then a full open-items summary.</li>
          <li>Requires a Resend API key configured as <code className="font-mono text-xs bg-blue-100 px-1 py-0.5 rounded">RESEND_API_KEY</code> in environment settings.</li>
          <li>Use <strong>Preview</strong> to see the current email in your browser before sending.</li>
          <li>Use <strong>Send Now</strong> to trigger an immediate one-off dispatch (useful for testing).</li>
        </ul>
      </div>
    </div>
  );
}

// ── Sandbox Reset (Admin only) ─────────────────────────────────────────────────

interface SandboxResetResult {
  ok: boolean;
  truncated: string[];
  recipesCreated: number;
  recipesSkipped: number;
  recipesWiped: boolean;
  sampleSuppliers: number;
  sampleQuals: number;
  sampleInventory: number;
  sampleLots: number;
}

async function callSandboxReset(alsoWipeRecipes: boolean, seedSampleData: boolean): Promise<SandboxResetResult> {
  const r = await fetch(`${BASE}api/admin/sandbox-reset`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "yes-wipe-sandbox", alsoWipeRecipes, seedSampleData }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<SandboxResetResult> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Reset failed (HTTP ${r.status})`);
  return body as SandboxResetResult;
}

// ── Starter document library (Admin only) ──────────────────────────────────────

interface SeedStarterResult { ok: boolean; created: { docNumber: string; title: string }[]; skipped: string[]; }
interface RemoveStarterResult { ok: boolean; removed: string[]; skipped: { docNumber: string; reason: string }[]; purge: boolean; }

async function callSeedStarterDocs(): Promise<SeedStarterResult> {
  const r = await fetch(`${BASE}api/admin/seed-starter-documents`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<SeedStarterResult> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Seed failed (HTTP ${r.status})`);
  return body as SeedStarterResult;
}

async function callRemoveStarterDocs(purge: boolean): Promise<RemoveStarterResult> {
  const r = await fetch(`${BASE}api/admin/remove-starter-documents`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "yes-remove-starter", purge }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<RemoveStarterResult> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Remove failed (HTTP ${r.status})`);
  return body as RemoveStarterResult;
}

// One-time capture of current document content onto the revision currently in force,
// for revisions approved before revision content was retained. Everything approved
// from here on freezes its own copy at the approver's signature.
function RevisionRetentionBackfillCard() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ captured: number; skipped: number; documents: number } | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE}api/documents/admin/backfill-revision-content`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? `Backfill failed (HTTP ${r.status})`);
      setResult(body);
      toast({
        title: "Revision content captured",
        description: `${body.captured} of ${body.documents} document(s) captured${body.skipped ? `, ${body.skipped} skipped` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Backfill failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <CardTitle>Retain Current Revision Content</CardTitle>
        <CardDescription>
          Documents approved before revision content was retained have no copy of what they said —
          their text is overwritten the moment the next revision is drafted. This captures each
          Approved or Effective document&rsquo;s current content onto the revision in force, so the
          retained history starts today rather than one revision from now. Safe to run more than once:
          it never overwrites a copy that already exists. Captured records are marked as
          <strong> backfill</strong> rather than as frozen at signature, because that is what they are.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={run} disabled={busy} data-testid="button-backfill-revisions">
          {busy ? "Capturing…" : "Capture current content"}
        </Button>
        {result && (
          <p className="text-sm text-muted-foreground">
            {result.captured} captured · {result.skipped} skipped · {result.documents} document(s) examined.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StarterDocumentsCard() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"seed" | "remove" | null>(null);
  const [purge, setPurge] = useState(false);

  const doSeed = async () => {
    setBusy("seed");
    try {
      const res = await callSeedStarterDocs();
      toast({
        title: "Starter documents loaded",
        description: `${res.created.length} created${res.skipped.length ? `, ${res.skipped.length} already present` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Load failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const doRemove = async () => {
    setBusy("remove");
    try {
      const res = await callRemoveStarterDocs(purge);
      toast({
        title: "Starter documents removed",
        description: `${res.removed.length} ${purge ? "deleted" : "marked obsolete"}${res.skipped.length ? `, ${res.skipped.length} left (in use/modified)` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Remove failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <CardTitle>Starter Document Set</CardTitle>
        <CardDescription>
          Load the 15 generic, pre-approved controlled documents (13 SOPs plus the Quality Manual and
          Quality Policy) so a new facility opens with a working QMS. Loading is idempotent — running it
          again only adds documents that are missing. Each is flagged <strong>Starter</strong> and can be
          removed here if the facility brings its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={doSeed} disabled={busy !== null}>
            {busy === "seed" ? "Loading…" : "Load starter documents"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={busy !== null} className="text-destructive hover:text-destructive">
                {busy === "remove" ? "Removing…" : "Remove starter set"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the starter document set?</AlertDialogTitle>
                <AlertDialogDescription>
                  Only untouched starter documents (still Approved, revision A) are removed; any the
                  facility has begun revising are left alone. By default they are marked Obsolete and kept
                  for history. Tick the box to permanently delete them instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <label className="flex items-center gap-2 text-sm px-1">
                <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} className="rounded" />
                Permanently delete (purge) instead of marking obsolete
              </label>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={doRemove}>
                  {purge ? "Yes, delete them" : "Yes, mark obsolete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

interface SeedStarterInvResult { ok: boolean; created: string[]; skipped: string[]; }
interface RemoveStarterInvResult { ok: boolean; removed: string[]; skipped: { itemName: string; reason: string }[]; }

async function callSeedStarterInventory(): Promise<SeedStarterInvResult> {
  const r = await fetch(`${BASE}api/admin/seed-starter-inventory`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<SeedStarterInvResult> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Seed failed (HTTP ${r.status})`);
  return body as SeedStarterInvResult;
}

async function callRemoveStarterInventory(): Promise<RemoveStarterInvResult> {
  const r = await fetch(`${BASE}api/admin/remove-starter-inventory`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "yes-remove-starter-inventory" }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<RemoveStarterInvResult> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Remove failed (HTTP ${r.status})`);
  return body as RemoveStarterInvResult;
}

function StarterInventoryCard() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"seed" | "remove" | null>(null);

  const doSeed = async () => {
    setBusy("seed");
    try {
      const res = await callSeedStarterInventory();
      toast({
        title: "Starter inventory loaded",
        description: `${res.created.length} created${res.skipped.length ? `, ${res.skipped.length} already present` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Load failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const doRemove = async () => {
    setBusy("remove");
    try {
      const res = await callRemoveStarterInventory();
      toast({
        title: "Starter inventory removed",
        description: `${res.removed.length} deleted${res.skipped.length ? `, ${res.skipped.length} left (in use)` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Remove failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <CardTitle>Starter Inventory Catalog</CardTitle>
        <CardDescription>
          Load common non-cannabis items each segment stocks — edible ingredients, vape/pre-roll hardware,
          and cultivation inputs — so a new facility's item list isn't empty on day one. Loading is idempotent,
          and each item is flagged <strong>Starter</strong>. Items start with no quantity or reorder point; set
          those to your own volumes. Remove untouched items here if the facility brings its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={doSeed} disabled={busy !== null}>
            {busy === "seed" ? "Loading…" : "Load starter inventory"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={busy !== null} className="text-destructive hover:text-destructive">
                {busy === "remove" ? "Removing…" : "Remove starter items"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the starter inventory set?</AlertDialogTitle>
                <AlertDialogDescription>
                  Only untouched starter items (no stock, no reorder point, no supplier) are deleted; any the
                  facility has begun stocking or configuring are left alone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={doRemove}>Yes, remove them</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

function SandboxResetTab() {
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();
  const isAdmin = currentUser?.role === "Admin";
  const [running, setRunning] = useState(false);
  const [alsoWipeRecipes, setAlsoWipeRecipes] = useState(false);
  const [seedSampleData, setSeedSampleData] = useState(true);
  const [lastResult, setLastResult] = useState<SandboxResetResult | null>(null);

  const handleRun = async () => {
    setRunning(true);
    try {
      const result = await callSandboxReset(alsoWipeRecipes, seedSampleData);
      setLastResult(result);
      toast({
        title: "Sandbox reset complete",
        description: `Wiped ${result.truncated.length} table(s). Recipes: +${result.recipesCreated} new, ${result.recipesSkipped} kept.${seedSampleData ? ` Sample: ${result.sampleSuppliers} suppliers, ${result.sampleQuals} quals, ${result.sampleLots} lots seeded.` : ""}`,
      });
    } catch (e) {
      toast({ title: "Sandbox reset failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sandbox Reset</CardTitle>
          <CardDescription>Admin role required.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <RevisionRetentionBackfillCard />
      <StarterDocumentsCard />

      <StarterInventoryCard />

      <Card className="border-red-300">
        <CardHeader>
          <CardTitle className="text-red-700">Wipe Transactional Data</CardTitle>
          <CardDescription>
            Destructive. Truncates batch records, ingredients, inventory, lots, suppliers, inspections,
            documents, NCs / CAPAs / complaints / field actions, attachments, and the audit log on
            <strong> the database this app is currently connected to</strong> (development or production,
            depending on where you're signed in).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 space-y-1">
            <p className="font-semibold">What's preserved</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li><strong>Users</strong> (Clerk identities + role assignments)</li>
              <li><strong>Recipes</strong> and recipe items (unless you tick the box below)</li>
              <li><strong>Label templates</strong> and static blocks</li>
              <li><strong>Company profile</strong>, regulatory config, digest settings</li>
            </ul>
          </div>
          <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900">
            After truncating, the 6 starter recipes (cookies / brownies / rice crispy / vape carts /
            raw + infused pre-rolls) are seeded if missing. Idempotent on product name.
          </div>
          <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900">
            With <strong>Reseed fresh sample data</strong> on, the wipe also rebuilds 6 sample
            suppliers and 8 raw-material items as linked on-hand <strong>lots</strong> under the
            unified ledger — so Inventory and Lot Traceability both populate and agree by
            construction. Practice/validation data only.
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={seedSampleData}
              onChange={(e) => setSeedSampleData(e.target.checked)}
              className="rounded"
            />
            Reseed fresh sample data (suppliers + raw-material lots under the unified model)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={alsoWipeRecipes}
              onChange={(e) => setAlsoWipeRecipes(e.target.checked)}
              className="rounded"
            />
            Also wipe existing recipes before reseeding (clears any custom recipes you've added)
          </label>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={running}>
                {running ? "Resetting…" : "Reset Sandbox Data"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Wipe sandbox data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes all batch records, suppliers, inspections, inventory,
                  documents, NCs / CAPAs, attachments, and the audit log from this database. Users,
                  label templates{alsoWipeRecipes ? "" : ", and recipes"} are preserved.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-700"
                  onClick={handleRun}
                >
                  Yes, wipe everything
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {lastResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Last reset summary</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <div><strong>Tables truncated ({lastResult.truncated.length}):</strong> {lastResult.truncated.join(", ") || "none"}</div>
            <div><strong>Recipes wiped first:</strong> {lastResult.recipesWiped ? "yes" : "no"}</div>
            <div><strong>Recipes created:</strong> {lastResult.recipesCreated}</div>
            <div><strong>Recipes skipped (already present):</strong> {lastResult.recipesSkipped}</div>
            <div><strong>Sample data seeded:</strong> {lastResult.sampleSuppliers} suppliers · {lastResult.sampleInventory} catalog items · {lastResult.sampleLots} lots</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

// ── Product Setup Tab ───────────────────────────────

type ProductTypeSetting = {
  id: number;
  productType: string;
  shelfLifeDays: number | null;
  defaultNetWeight: number | null;
  defaultNetWeightUnit: string | null;
  servingSize: string | null;
  servingsPerPackage: number | null;
  activationTime: string | null;
  updatedByName: string | null;
  updatedAt: string;
};

async function fetchProductTypeSettings(): Promise<ProductTypeSetting[]> {
  const r = await fetch(`${BASE}api/product-type-settings`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load product settings");
  return r.json();
}

function ProductSetupTab() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ProductTypeSetting[] | null>(null);
  const [savingType, setSavingType] = useState<string | null>(null);

  const load = () => {
    fetchProductTypeSettings()
      .then(setRows)
      .catch(() => setRows([]));
  };
  useEffect(() => { load(); }, []);

  const edit = (pt: string, patch: Partial<ProductTypeSetting>) => {
    setRows((prev) => (prev ? prev.map((r) => (r.productType === pt ? { ...r, ...patch } : r)) : prev));
  };

  const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  const save = async (row: ProductTypeSetting) => {
    setSavingType(row.productType);
    try {
      const r = await fetch(`${BASE}api/product-type-settings/${encodeURIComponent(row.productType)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          shelfLifeDays: row.shelfLifeDays,
          activationTime: row.activationTime,
        }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? "Save failed");
      }
      toast({ title: `${row.productType} settings saved` });
      load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSavingType(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Product Setup</CardTitle>
        <CardDescription>
          Per product-type defaults: shelf-life (sets the label expiration = passing-test date + days) and
          activation time. Net weight and per-serving details are set per product on each recipe
          (each recipe, under Label Attributes), since they vary product to product.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No product types configured.</p>
        ) : (
          <div className="space-y-8">
            {rows.map((row) => (
              <div key={row.id} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-lg">{row.productType}</h3>
                  <Button size="sm" onClick={() => save(row)} disabled={savingType === row.productType}>
                    {savingType === row.productType ? "Saving…" : "Save"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Shelf-life (days)</Label>
                    <Input
                      type="number"
                      value={row.shelfLifeDays ?? ""}
                      onChange={(e) => edit(row.productType, { shelfLifeDays: numOrNull(e.target.value) })}
                      placeholder="e.g. 365"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Activation time</Label>
                    <Input
                      value={row.activationTime ?? ""}
                      onChange={(e) => edit(row.productType, { activationTime: e.target.value })}
                      placeholder="e.g. 30–90 minutes"
                    />
                  </div>
                </div>
                {row.updatedByName && (
                  <p className="text-xs text-muted-foreground">Last updated by {row.updatedByName}</p>
                )}
                <SubtypeManager productType={row.productType} />
                <Separator />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Subtypes (per product type) ─────────────────────────────────────────────────

type ProductSubtype = {
  id: number;
  productType: string;
  name: string;
  defaultNetWeight: number | null;
  defaultNetWeightUnit: string | null;
  active: boolean;
  sortOrder: number;
};

// Facility-managed operational sub-forms within a product type (Concentrate:
// live resin / wax / rosin; Pre-Roll: 0.5g / 1g). Purely descriptive except a
// size-style subtype may carry an optional default net weight + unit that
// pre-fills a recipe's net weight when picked. Grouped under each product type.
function SubtypeManager({ productType }: { productType: string }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ProductSubtype[] | null>(null);
  const [name, setName] = useState("");
  const [netWeight, setNetWeight] = useState("");
  const [netWeightUnit, setNetWeightUnit] = useState("");
  const [busy, setBusy] = useState(false);

  const url = `${BASE}api/product-subtypes`;
  const load = () => {
    fetch(`${url}?productType=${encodeURIComponent(productType)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]));
  };
  useEffect(() => { load(); }, [productType]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          productType,
          name: name.trim(),
          defaultNetWeight: netWeight.trim() === "" ? null : Number(netWeight),
          defaultNetWeightUnit: netWeightUnit.trim() || null,
        }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? "Failed to add subtype");
      }
      setName(""); setNetWeight(""); setNetWeightUnit("");
      load();
    } catch (e) {
      toast({ title: "Could not add subtype", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (s: ProductSubtype) => {
    await fetch(`${url}/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ active: !s.active }),
    }).catch(() => {});
    load();
  };

  const remove = async (s: ProductSubtype) => {
    await fetch(`${url}/${s.id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
    load();
  };

  return (
    <div className="space-y-2 rounded-md border p-3 bg-muted/30">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Subtypes</Label>
        <span className="text-xs text-muted-foreground">Optional sub-forms (e.g. live resin, 1g). Add a net weight to pre-fill it on recipes.</span>
      </div>

      {rows === null ? (
        <Skeleton className="h-6 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No subtypes yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-sm">
              <span className={s.active ? "font-medium" : "font-medium text-muted-foreground line-through"}>{s.name}</span>
              {s.defaultNetWeight != null && (
                <Badge variant="outline">{s.defaultNetWeight}{s.defaultNetWeightUnit ?? ""}</Badge>
              )}
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Active</span>
                <Switch checked={s.active} onCheckedChange={() => toggleActive(s)} />
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(s)}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-1">
        <div className="flex-1 min-w-[140px]">
          <Label className="text-xs text-muted-foreground">New subtype</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Live Resin, 1g" />
        </div>
        <div className="w-24">
          <Label className="text-xs text-muted-foreground">Net wt.</Label>
          <Input type="number" step="0.01" value={netWeight} onChange={(e) => setNetWeight(e.target.value)} placeholder="opt." />
        </div>
        <div className="w-20">
          <Label className="text-xs text-muted-foreground">Unit</Label>
          <Input value={netWeightUnit} onChange={(e) => setNetWeightUnit(e.target.value)} placeholder="g" />
        </div>
        <Button size="sm" onClick={add} disabled={!name.trim() || busy}>{busy ? "Adding…" : "Add"}</Button>
      </div>
    </div>
  );
}

export default function Settings() {
  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">
            Manage company profile, regulatory configuration, and team members.
          </p>
        </div>

        <Tabs defaultValue="users">
          <TabsList className="mb-6">
            <TabsTrigger value="users" className="gap-2">
              <Users className="h-4 w-4" />
              User Management
            </TabsTrigger>
            <TabsTrigger value="company" className="gap-2">
              <Building2 className="h-4 w-4" />
              Company Profile
            </TabsTrigger>
            <TabsTrigger value="regulatory" className="gap-2">
              <FlaskConical className="h-4 w-4" />
              Regulatory Config
            </TabsTrigger>
            <TabsTrigger value="digest" className="gap-2">
              <Mail className="h-4 w-4" />
              Digest Emails
            </TabsTrigger>
            <TabsTrigger value="products" className="gap-2">
              <Package className="h-4 w-4" />
              Product Setup
            </TabsTrigger>
            <TabsTrigger value="sandbox" className="gap-2">
              <FlaskConical className="h-4 w-4" />
              Sandbox Reset
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            <UserManagementTab />
          </TabsContent>
          <TabsContent value="company">
            <CompanyProfileTab />
          </TabsContent>
          <TabsContent value="regulatory">
            <RegulatoryTab />
          </TabsContent>
          <TabsContent value="digest">
            <DigestEmailTab />
          </TabsContent>
          <TabsContent value="products">
            <ProductSetupTab />
          </TabsContent>
          <TabsContent value="sandbox">
            <SandboxResetTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
