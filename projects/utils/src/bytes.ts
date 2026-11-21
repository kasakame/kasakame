import { decodeAddress } from 'algosdk'

/**
 * @param addr An Algorand address.
 * @returns Its 32-byte public key as hex.
 */
export function addrHex(addr: string): string {
  return Buffer.from(decodeAddress(addr).publicKey).toString('hex')
}

/**
 * @param hexes Hex strings.
 * @returns The concatenated bytes.
 */
export function concatHex(hexes: string[]): Uint8Array {
  return new Uint8Array(Buffer.concat(hexes.map((hex) => Buffer.from(hex, 'hex'))))
}

/**
 * @param appId An application id.
 * @returns Its 8-byte big-endian encoding.
 */
export function appIdBytes(appId: bigint): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(appId)
  return buffer
}

/**
 * Decode an unpadded RFC 4648 base32 string (confirmed TxIDs) to bytes.
 *
 * @param input Unpadded base32 input.
 * @returns The decoded bytes.
 */
export function base32ToBytes(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of input) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out)
}
