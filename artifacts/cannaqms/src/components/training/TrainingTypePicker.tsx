import { TRAINING_TYPES } from "@/lib/trainingTypes";

// Multi-select chips for training delivery type(s). A single training event can
// combine methods (e.g. Read and Understand PLUS Direct Supervision), so more than
// one may be selected. Rendered as toggle chips, mirroring DepartmentPicker. The
// selected types are stored joined (", ") in the record's `trainingType` field.
export function TrainingTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (t: string) =>
    onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {TRAINING_TYPES.map((t) => {
        const on = value.includes(t);
        return (
          <button
            key={t}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => toggle(t)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-50 ${
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}
