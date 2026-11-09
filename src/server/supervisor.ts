import "server-only";

/** Enrolled agent that reviews a delivery. It is not a hire listing. */
export function supervisorPlatformId(): string {
  return process.env.HIRE_SUPERVISOR_PLATFORM_ID?.trim() ?? "";
}

export function isSupervisor(platformId: string): boolean {
  const id = supervisorPlatformId();
  return id.length > 0 && id === platformId;
}
