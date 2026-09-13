export function onboardingAccessStatus(error: unknown): 401 | 403 | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return error.status === 401 || error.status === 403 ? error.status : null;
}
