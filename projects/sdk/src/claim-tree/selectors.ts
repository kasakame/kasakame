// ARC-4 selectors of the methods the SDK replays from indexer history and routes on; `selectors.spec.ts` recomputes them from the generated clients' ARC-56 specs.

/** Campaign `pledge(pay,byte[])void` selector. */
export const SELECTOR_PLEDGE = 'a4030bd2'

/** Campaign `cancelPledge(uint64,uint64,byte[],byte[])void` selector. */
export const SELECTOR_CANCEL = '457e292e'

/** Campaign `refund(uint64,uint64,byte[],byte[])void` selector. */
export const SELECTOR_REFUND = '4b1a1d96'

/** ClaimsVault `refund(uint64,uint64,uint64,byte[],byte[])void` selector. */
export const SELECTOR_VAULT_REFUND = '0fe03dd2'
