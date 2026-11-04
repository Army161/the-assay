// The one piece of the caller module the browser needs: the exact message a wallet signs (must match the server).
export function registrationMessage(wallet: string, nonce: string) {
  return `The Assay caller registration\nwallet: ${wallet}\nnonce: ${nonce}\n\nSigning costs nothing and moves no funds.`;
}
