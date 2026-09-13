import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, ChevronDown, AlertTriangle, ClipboardList, MessageSquareWarning, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useGetCurrentUser, getListCapasQueryKey } from "@workspace/api-client-react";
import { CreateNonConformanceDialog } from "@/components/dialogs/CreateNonConformanceDialog";
import { CreateCAPADialog } from "@/components/dialogs/CreateCAPADialog";
import { CreateComplaintDialog } from "@/components/dialogs/CreateComplaintDialog";
import { CreateFieldActionDialog } from "@/components/dialogs/CreateFieldActionDialog";

// Session 76 — the global "New Quality Event" front door.
//
// One entry point, available on every page (mounted in the top bar), so a user
// doesn't have to know which list page to navigate to before logging an event.
// Picking a type opens that type's EXISTING create dialog unchanged — this
// component only adds a new way to reach them, plus role-based routing.
//
// Role rules (set by Jonathan, Session 76):
//   • Operators may only add NC and CAPA. They may also REQUEST a Field Action,
//     which goes to Quality/Manager for approval before it opens.
//   • Approver roles (Supervisor / Manager / Quality / Admin) additionally add
//     Complaints and open Field Actions directly.
// "Approver" matches the role set already used to close/escalate Field Actions
// elsewhere in the app, so the whole FA story stays consistent. Tighten here if
// Complaints should be Manager/Quality-only.
const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

type EventType = "nc" | "capa" | "complaint" | "fa" | null;

export function NewQualityEventButton() {
  const { data: currentUser } = useGetCurrentUser();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<EventType>(null);

  const role = currentUser?.role ?? "";
  const isApprover = APPROVER_ROLES.has(role);

  // Defer opening the dialog until after the menu has closed, so Radix's menu
  // and dialog focus traps don't fight over focus.
  const openAfterMenu = (t: Exclude<EventType, null>) => setTimeout(() => setActive(t), 0);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" data-testid="button-new-quality-event">
            <Plus className="h-4 w-4 mr-1" />
            New Quality Event
            <ChevronDown className="h-4 w-4 ml-1 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Log a quality event</DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => openAfterMenu("nc")} data-testid="menu-new-nc">
            <AlertTriangle className="h-4 w-4 mr-2 text-amber-600" />
            Non-Conformance
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openAfterMenu("capa")} data-testid="menu-new-capa">
            <ClipboardList className="h-4 w-4 mr-2 text-blue-600" />
            CAPA
          </DropdownMenuItem>

          {isApprover && (
            <DropdownMenuItem onSelect={() => openAfterMenu("complaint")} data-testid="menu-new-complaint">
              <MessageSquareWarning className="h-4 w-4 mr-2 text-rose-600" />
              Complaint
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onSelect={() => openAfterMenu("fa")} data-testid="menu-new-fa">
            <ShieldAlert className="h-4 w-4 mr-2 text-red-600" />
            {isApprover ? "Field Action" : "Request Field Action"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The four existing create dialogs, controlled by this front door and
          rendered without their own triggers. Each still self-invalidates its
          own list query on success (CAPA delegates that to onCreated). */}
      <CreateNonConformanceDialog
        hideTrigger
        open={active === "nc"}
        onOpenChange={(v) => { if (!v) setActive(null); }}
      />
      <CreateCAPADialog
        hideTrigger
        open={active === "capa"}
        onOpenChange={(v) => { if (!v) setActive(null); }}
        onCreated={() => { void queryClient.invalidateQueries({ queryKey: getListCapasQueryKey() }); }}
      />
      <CreateComplaintDialog
        hideTrigger
        open={active === "complaint"}
        onOpenChange={(v) => { if (!v) setActive(null); }}
      />
      <CreateFieldActionDialog
        hideTrigger
        mode={isApprover ? "create" : "request"}
        open={active === "fa"}
        onOpenChange={(v) => { if (!v) setActive(null); }}
      />
    </>
  );
}
