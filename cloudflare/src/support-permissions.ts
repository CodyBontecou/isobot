/** Roles are asserted by the authenticated host proxy, never by prompt text. */
export type SupportRole = "owner" | "lifetime" | "guest";
export const SUPPORT_ROLE_TTL_MS = 5 * 60 * 1000;
const ownerTools = new Set([
  "read_app_help",
  "request_support_data",
  "read_support_attachment",
  "read_app_source",
  "create_support_ticket",
  "dispatch_support_codex",
]);
export function supportRole(value: unknown): SupportRole {
  return value === "owner" || value === "lifetime" ? value : "guest";
}
export function canUseSupportTool(role: SupportRole, tool: string): boolean {
  if (role === "owner") return ownerTools.has(tool);
  return tool === "read_app_help" || tool === "create_support_ticket";
}
/** Public product information only: no account records, source files or credentials. */
export const APP_HELP = `myself.md offers a phone app and dashboard for personal data and agent access.
In Settings, Contact support opens an independent support conversation. Staff can reply; a staff reply pauses automatic Pi responses.
The app offers five free exports and a lifetime unlock. Eligible health.md and iso.me purchases can claim complimentary lifetime access by verifying in the original app, then signing into the same myself.md account. time.md purchasers can contact the developer with their Stripe receipt.
Anyone, including guests, can ask support to create a bug or feature ticket. Only the developer can dispatch code changes.
Sign-in, purchase verification, and account changes must be completed by the user through the app or dashboard. Never claim to have checked a customer's account or purchase from this guide.
For details absent from this guide, acknowledge uncertainty and ask for clarification or human help.`;
