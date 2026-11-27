import algosdk from 'algosdk'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SignJWT, jwtVerify } from 'jose'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { pool } from './db.js'

declare module 'fastify' {
  interface FastifyRequest {
    address?: string | undefined
  }
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MIN_SECRET_BYTES = 32
const PLACEHOLDER_SECRETS = new Set(['change-me', 'changeme', 'replace-me', 'secret', 'test-secret', 'your-secret-here'])
const TOKEN_TTL = '7d'
const TOKEN_ISSUER = 'kasakame'

/** A sign-in challenge for one address: the client embeds the nonce in its SIWA request. */
export interface Challenge {
  nonce: string
  expiresAt: string
}

/**
 * Concat two byte arrays (tweetnacl works on plain Uint8Arrays in every realm).
 *
 * @param first First bytes.
 * @param second Second bytes.
 * @returns Concatenated bytes.
 */
function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}

/**
 * Narrow an unknown value to a string-keyed record.
 *
 * @param value Value to check.
 * @returns True for non-null objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * SHA-256 digest (ARC-60 signing input hashing).
 *
 * @param bytes Input bytes.
 * @returns The 32-byte digest.
 */
function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest()
}

/**
 * Decode base64 to bytes (atob/btoa work in every runtime, unlike Node's Buffer).
 *
 * @param base64 Base64 input.
 * @returns Decoded bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function appDomain(): string {
  const domain = process.env.APP_DOMAIN
  if (!domain) {
    throw new Error('APP_DOMAIN is not set (see .env.template)')
  }
  return domain
}

function appUri(): string {
  const uri = process.env.APP_URI
  if (!uri) {
    throw new Error('APP_URI is not set (see .env.template)')
  }
  return uri
}

function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set (see .env.template)')
  }
  if (PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error('SESSION_SECRET is a placeholder (generate one with: openssl rand -hex 32)')
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error('SESSION_SECRET must be at least 32 bytes (generate one with: openssl rand -hex 32)')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Fail fast on a missing, placeholder, or short session secret.
 */
export function assertSessionSecret(): void {
  sessionSecret()
}

/**
 * Issue a single-use sign-in nonce that the client embeds in the SIWA request it signs.
 *
 * @param address Algorand address to challenge.
 * @returns The nonce and expiry.
 */
export async function createChallenge(address: string): Promise<Challenge> {
  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const nonce = Buffer.from(nonceBytes).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  await pool().query('DELETE FROM auth_nonces WHERE expires_at <= now()')
  await pool().query(
    `INSERT INTO auth_nonces (nonce, address, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) WHERE used_at IS NULL
     DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [nonce, address, expiresAt.toISOString()],
  )
  return { nonce, expiresAt: expiresAt.toISOString() }
}

/**
 * Claim a live nonce exactly once; a concurrent request finds no row and fails.
 *
 * @param nonce Challenge nonce.
 * @param address Claimed address.
 * @returns Nothing when this call consumed the nonce.
 */
async function consumeNonce(nonce: string, address: string): Promise<void> {
  const claimed = await pool().query(
    'UPDATE auth_nonces SET used_at = now() WHERE nonce = $1 AND address = $2 AND used_at IS NULL AND expires_at > now() RETURNING nonce',
    [nonce, address],
  )
  if (claimed.rowCount !== 1) {
    throw new Error('invalid or expired challenge')
  }
}

/**
 * The exact note a login payment must carry, binding this deployment's domain to a live challenge nonce; the frontend builds the same string.
 *
 * @param domain Deployment domain (matches `APP_DOMAIN`).
 * @param nonce Live challenge nonce for the address.
 * @returns The note text.
 */
export function loginNote(domain: string, nonce: string): string {
  return `kasakame login ${domain} ${nonce}`
}

/**
 * Decode a signed login payment and check its shape: a single-key zero self-payment with no close-out or rekey.
 *
 * @param signedTxn Base64 signed transaction bytes.
 * @returns The decoded payment and its signature.
 */
export function decodeLoginPayment(signedTxn: string): { txn: algosdk.Transaction; sig: Uint8Array } {
  let decoded: algosdk.SignedTransaction
  try {
    decoded = algosdk.decodeSignedTransaction(base64ToBytes(signedTxn))
  } catch {
    throw new Error('malformed signed transaction')
  }
  const { txn, sig, msig, lsig, sgnr } = decoded
  if (sig === undefined) {
    throw new Error('expected a single key signature')
  }
  if ([msig, lsig, sgnr].some((part) => part !== undefined)) {
    throw new Error('expected a single key signature')
  }
  const payment = txn.payment
  if (payment === undefined || payment.receiver.toString() !== txn.sender.toString()) {
    throw new Error('expected a self payment')
  }
  if (payment.amount !== BigInt(0)) {
    throw new Error('expected a zero payment')
  }
  if (payment.closeRemainderTo !== undefined || txn.rekeyTo !== undefined) {
    throw new Error('close-out and rekey are not allowed')
  }
  return { txn, sig }
}

/**
 * Issue a session JWT for an address. Single place minting tokens for both proof paths.
 *
 * @param address Verified Algorand address.
 * @returns Session JWT (Bearer token, seven days).
 */
function issueSessionToken(address: string): Promise<string> {
  return new SignJWT({ address })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .setIssuer(TOKEN_ISSUER)
    .sign(sessionSecret())
}

/**
 * Verify an ARC-60 SIWA request: the wallet signs `sha256(data) || sha256(authenticatorData)` with the domain hash leading the authenticator data; nonces are single-use, rekeyed accounts unsupported.
 *
 * @param address Claimed Algorand address.
 * @param data The exact canonified SIWA JSON string that was signed.
 * @param authenticatorData Base64 ARC-60 authenticator data.
 * @param signature Base64 signature over the ARC-60 signing input.
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyChallenge(address: string, data: string, authenticatorData: string, signature: string): Promise<string> {
  let siwa: unknown
  try {
    siwa = JSON.parse(data) as unknown
  } catch {
    throw new Error('malformed SIWA request')
  }
  if (!isRecord(siwa)) {
    throw new Error('malformed SIWA request')
  }
  const { domain, uri, account_address, type, version, nonce } = siwa
  if (typeof nonce !== 'string' || nonce === '') {
    throw new Error('malformed SIWA request')
  }
  if (domain !== appDomain() || uri !== appUri() || account_address !== address || type !== 'ed25519' || version !== '1') {
    throw new Error('SIWA request is not bound to this deployment')
  }
  // ARC-60 binds the domain via the authenticator data's leading hash; trailing fields are allowed, so only the prefix is compared.
  const authenticatorBytes = base64ToBytes(authenticatorData)
  const domainHash = sha256(new TextEncoder().encode(appDomain()))
  if (
    authenticatorBytes.length < domainHash.length ||
    !Buffer.from(authenticatorBytes.subarray(0, domainHash.length)).equals(Buffer.from(domainHash))
  ) {
    throw new Error('signature is not bound to this deployment')
  }
  const valid = nacl.sign.detached.verify(
    concatBytes(sha256(new TextEncoder().encode(data)), sha256(base64ToBytes(authenticatorData))),
    base64ToBytes(signature),
    algosdk.decodeAddress(address).publicKey,
  )
  if (!valid) {
    throw new Error('invalid signature')
  }
  await consumeNonce(nonce, address)
  return issueSessionToken(address)
}

/**
 * Verify a wallet-signed zero self-payment login (fallback for wallets without message signing); it is never broadcast, so no fee is paid.
 *
 * @param address Claimed Algorand address.
 * @param signedTxn Base64 signed payment bytes (sender and receiver are the address, amount zero).
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyTransactionChallenge(address: string, signedTxn: string): Promise<string> {
  const { txn, sig } = decodeLoginPayment(signedTxn)
  if (txn.sender.toString() !== address) {
    throw new Error('transaction is not from the claimed address')
  }
  const note = Buffer.from(txn.note).toString('utf8')
  const domain = appDomain()
  const live = (
    await pool().query<{ nonce: string }>('SELECT nonce FROM auth_nonces WHERE address = $1 AND used_at IS NULL AND expires_at > now()', [
      address,
    ])
  ).rows.map((row) => row.nonce)
  const nonce = live.find((candidate) => note === loginNote(domain, candidate))
  if (nonce === undefined) {
    throw new Error('invalid or expired challenge')
  }
  const valid = nacl.sign.detached.verify(txn.bytesToSign(), sig, algosdk.decodeAddress(address).publicKey)
  if (!valid) {
    throw new Error('invalid signature')
  }
  await consumeNonce(nonce, address)
  return issueSessionToken(address)
}

/**
 * Fastify pre-handler: accepts a valid session JWT and sets `request.address`, else 401.
 *
 * @param request Incoming request.
 * @param reply Outgoing reply.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  const token = header !== undefined && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  if (token === undefined) {
    await reply.code(401).send({ error: 'missing token' })
    return
  }
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { issuer: TOKEN_ISSUER })
    if (typeof payload.address !== 'string' || payload.address === '') {
      throw new Error('token has no address')
    }
    request.address = payload.address
  } catch {
    await reply.code(401).send({ error: 'invalid token' })
  }
}
