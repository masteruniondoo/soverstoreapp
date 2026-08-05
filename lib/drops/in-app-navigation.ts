import { validateDropId } from "@/lib/drops/drop-route";

export const DROP_ROUTE_CHANGE_EVENT = "soverstore:drop-route-change";

/** Opens a validated Drop route without asking the native host to reload it. */
export function openDropInCurrentApp(dropId: string): void {
  const validated = validateDropId(dropId);
  if (validated === null) throw new Error("Enter a valid Drop link or Drop ID.");

  window.history.pushState(null, "", `/drop/${encodeURIComponent(validated)}`);
  window.dispatchEvent(new Event(DROP_ROUTE_CHANGE_EVENT));
}
