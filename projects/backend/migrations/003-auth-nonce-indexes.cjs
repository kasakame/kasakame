/** Bound and index the single-use sign-in nonces. */

/**
 * Keep the newest live nonce per address, then index address lookups.
 *
 * @param pgm Migration builder.
 */
exports.up = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.sql(`
    UPDATE auth_nonces SET used_at = now()
    WHERE nonce IN (
      SELECT nonce FROM (
        SELECT nonce, row_number() OVER (PARTITION BY address ORDER BY created_at DESC, nonce) AS rn
        FROM auth_nonces WHERE used_at IS NULL
      ) ranked WHERE rn > 1
    )
  `)
  pgm.sql('CREATE INDEX auth_nonces_address_idx ON auth_nonces (address)')
  pgm.sql('CREATE UNIQUE INDEX auth_nonces_live_address_idx ON auth_nonces (address) WHERE used_at IS NULL')
}

/**
 * Drop the nonce indexes.
 *
 * @param pgm Migration builder.
 */
exports.down = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.sql('DROP INDEX auth_nonces_live_address_idx')
  pgm.sql('DROP INDEX auth_nonces_address_idx')
}
