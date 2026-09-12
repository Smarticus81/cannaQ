import { DEPARTMENTS } from "@/lib/departments";

// A simple multi-select department checklist rendered as toggle chips. Used on the
// user profile (which departments a person works in) and the training assignment
// dialog (which departments to target). Kept dependency-free (plain buttons) so it
// works anywhere without a specific checkbox component.
export function DepartmentPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (d: string) =>
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {DEPARTMENTS.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => toggle(d)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-50 ${
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}
