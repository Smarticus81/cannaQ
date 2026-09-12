export const onboardingPaths = {
  quality: {
    href: "/documents",
    title: "Review controlled documents",
    description:
      "Find the current effective procedures and specifications for your work.",
  },
  production: {
    href: "/batches",
    title: "Open production records",
    description: "See how ingredients, process steps, and review fit together.",
  },
  operations: {
    href: "/inventory",
    title: "Open inventory and traceability",
    description: "Trace material from its arrival to the work it supports.",
  },
} as const;
