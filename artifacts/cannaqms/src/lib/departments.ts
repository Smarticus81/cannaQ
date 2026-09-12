// Canonical facility departments — frontend copy of the list defined in
// lib/db/src/schema/users.ts (DEPARTMENTS). Kept in sync manually. Used for the
// user-profile checklist and for targeting training by Role × Department.
export const DEPARTMENTS = [
  "Cultivation",
  "Extraction",
  "Kitchen / Edibles",
  "Production",
  "Packaging & Labeling",
  "Quality / Lab",
  "Inventory / Warehouse",
  "Shipping / Distribution",
] as const;

export type Department = (typeof DEPARTMENTS)[number];
