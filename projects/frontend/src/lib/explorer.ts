/**
 * Lora transaction URL for the configured network.
 *
 * @param txId Base32 transaction id.
 * @returns The explorer URL.
 */
export function explorerTxUrl(txId: string): string {
  const network = import.meta.env.VITE_ALGOD_NETWORK || 'localnet'
  return `https://lora.algokit.io/${network}/tx/${txId}`
}
