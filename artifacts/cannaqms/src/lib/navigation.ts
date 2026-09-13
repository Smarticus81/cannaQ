/** Routes outside the authenticated workspace shell. */
export function isPublicRoute(path: string): boolean {
  return path === "/" || /^\/sign-(in|up)(\/|$)/.test(path);
}

/** Only restore an internal workspace destination, never an auth/API redirect. */
export function workspaceReturnTo(value: string | null): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return;
  if (/[\\\u0000-\u0020]/.test(value)) return;
  try {
    const url = new URL(value, "https://cannaq.invalid");
    const path = decodeURIComponent(url.pathname);
    if (
      url.origin !== "https://cannaq.invalid" ||
      /[\\\u0000-\u0020]/.test(path) ||
      path.startsWith("//") ||
      isPublicRoute(path) ||
      /^\/(onboarding|api)(\/|$)/.test(path)
    )
      return;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return;
  }
}

export function onboardingDestination(path: string): string {
  const destination = workspaceReturnTo(path);
  return destination
    ? `/onboarding?returnTo=${encodeURIComponent(destination)}`
    : "/onboarding";
}

/** A record from the previous facility must not be reopened at the new site. */
export function facilityDestination(path: string): string {
  const area = path.split(/[/?#]/)[1];
  if (area === "lots") return "/inventory";
  return workspaceReturnTo(`/${area}`) ?? "/dashboard";
}
