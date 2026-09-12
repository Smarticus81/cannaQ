import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OnboardingDraft, OnboardingSnapshot } from "@workspace/api-zod";
export const onboardingKey = ["personal-onboarding"];
export class OnboardingRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public field?: string,
  ) {
    super(message);
  }
}
export async function onboardingRequest(
  method = "GET",
  suffix = "",
  body?: unknown,
  apiBase = `${import.meta.env.BASE_URL}api/`,
): Promise<OnboardingSnapshot> {
  const response = await fetch(`${apiBase}onboarding${suffix}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new OnboardingRequestError(
      payload.error || "We couldn't save your place. Please try again.",
      response.status,
      payload.field,
    );
  return payload;
}
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: onboardingKey,
    queryFn: () => onboardingRequest(),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}
export function applyPreferences(
  draft: Pick<OnboardingDraft, "theme" | "density"> &
    Partial<Pick<OnboardingDraft, "workspaceMode">>,
) {
  document.documentElement.classList.toggle(
    "dark",
    draft.theme === "dark" ||
      (draft.theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  document.documentElement.dataset.density = draft.density;
  document.documentElement.dataset.workspaceMode =
    draft.workspaceMode ?? "guided";
  try {
    localStorage.setItem("cannaqms-theme", draft.theme);
    localStorage.setItem("cannaqms-density", draft.density);
    localStorage.setItem(
      "cannaqms-workspace-mode",
      draft.workspaceMode ?? "guided",
    );
  } catch {
    /* Still works with storage disabled. */
  }
  window.dispatchEvent(new Event("cannaq-preferences"));
}
export function usePreferences(draft?: OnboardingDraft) {
  useEffect(() => {
    if (!draft) return;
    applyPreferences(draft);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyPreferences(draft);
    if (draft.theme === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [draft?.theme, draft?.density, draft?.workspaceMode]);
}
