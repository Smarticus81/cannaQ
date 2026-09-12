import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronsUpDown } from "lucide-react";

// Multi-select role dropdown for training targeting. Reads like the old single
// Select trigger (compact button that opens a list), but lets you tick several
// roles at once. Empty selection = "Any role" (targets everyone regardless of
// role). Kept in sync with the backend user roles.
export const ASSIGN_ROLES = ["Operator", "Supervisor", "Manager", "Quality", "Admin"] as const;

export function RolePicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (r: string) =>
    onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);

  const label =
    value.length === 0 ? "Any role" : value.length === 1 ? value[0] : `${value.length} roles`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label="Select roles"
          className="w-full justify-between font-normal"
        >
          <span className={value.length === 0 ? "text-muted-foreground" : ""}>{label}</span>
          <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {ASSIGN_ROLES.map((r) => (
          <label
            key={r}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted"
          >
            <Checkbox checked={value.includes(r)} onCheckedChange={() => toggle(r)} />
            <span>{r}</span>
          </label>
        ))}
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
          >
            Clear (any role)
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
