// Device mode: is the vault open in this tab? (read by every database call; set by src/ui/vault.tsx)
let open = true
export function setVaultOpen(v: boolean) {
  open = v
}
export const isVaultOpen = () => open
