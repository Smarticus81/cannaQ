let ready = false;

export function isReady(): boolean {
  return ready;
}
export function markReady(): void {
  ready = true;
}
