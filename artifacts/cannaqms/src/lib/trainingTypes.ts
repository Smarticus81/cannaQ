// Canonical training delivery types, used by every training entry point
// (Assign Training, Record Group Training, Record Individual Training) so the
// `trainingType` field is consistent across the app.
//
//  - Read and Understand: the operator reads the document and signs that they
//    understand the stated requirements.
//  - Instructor-Led: a trainer delivers the material to one or more people,
//    typically covering more than one procedure and highlighting key points.
//  - Direct / Indirect Supervision: the operator reads the document FIRST, then
//    performs the required tasks under a supervisor/trainer. Direct = watched
//    over-the-shoulder; indirect = the supervisor reviews and signs the paperwork
//    (e.g. batch records) without watching every task. The number of tasks to
//    observe is left to the facility (captured in an open quantity field).
//
// Multi-select: a single training event can combine methods (e.g. Read and
// Understand PLUS Direct / Indirect Supervision).

// The supervision type — exported so dialogs can show the "tasks observed"
// quantity field only when this type is selected, without hard-coding the string.
export const SUPERVISION_TYPE = "Direct / Indirect Supervision";

export const TRAINING_TYPES = [
  "Read and Understand",
  "Instructor-Led",
  SUPERVISION_TYPE,
] as const;

export type TrainingType = (typeof TRAINING_TYPES)[number];
