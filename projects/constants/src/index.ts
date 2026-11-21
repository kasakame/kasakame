/** MicroAlgos in one ALGO. */
export const MICRO_ALGOS_PER_ALGO = 1_000_000n

/** Maximum claim-tree positions: 2^19 - 1. */
export const MAX_TREE_SIZE = 524_287n

/** The empty-tree root and consumed-leaf marker. */
export const ZERO_ROOT_HEX = '0000000000000000000000000000000000000000000000000000000000000000'

/** Minimum campaign goal, in microAlgos. */
export const MIN_GOAL_MICRO_ALGOS = 100_000n

/** Maximum campaign goal, in microAlgos. */
export const MAX_GOAL_MICRO_ALGOS = 10_000_000_000_000_000n

/** Minimum pledge, in microAlgos. */
export const MIN_PLEDGE_MICRO_ALGOS = 100_000n

/** Maximum pledge, in microAlgos: the total ALGO supply, the same bound as the goal. */
export const MAX_PLEDGE_MICRO_ALGOS = 10_000_000_000_000_000n

/** Maximum bytes in one AVM state key. */
export const MAX_STATE_KEY_BYTES = 128

/** Maximum campaign title bytes (the 5-byte `title` state key counts toward the 128-byte entry cap). */
export const MAX_TITLE_BYTES = MAX_STATE_KEY_BYTES - 5

/** Maximum campaign metadata URI bytes (the 11-byte `metadataUri` key counts toward the entry cap). */
export const MAX_METADATA_URI_BYTES = MAX_STATE_KEY_BYTES - 11

/** Seconds in one day. */
export const SECONDS_PER_DAY = 86_400

/** Minimum campaign duration, in seconds. */
export const MIN_CAMPAIGN_DURATION_SECONDS = SECONDS_PER_DAY

/** Maximum campaign duration, in seconds. */
export const MAX_CAMPAIGN_DURATION_SECONDS = 180 * SECONDS_PER_DAY

/** Final-day window for the goal-protection cancel rule, in seconds. */
export const FINAL_DAY_SECONDS = SECONDS_PER_DAY

/** Minimum vault refund window, in seconds. */
export const MIN_REFUND_WINDOW_SECONDS = 30 * SECONDS_PER_DAY

/** Maximum vault refund window, in seconds. */
export const MAX_REFUND_WINDOW_SECONDS = 10 * 365 * SECONDS_PER_DAY

/** Registry registration deposit, in microAlgos. */
export const REGISTER_DEPOSIT_MICRO_ALGOS = 18_900n

/** Platform storage reserve funded to each deployed app account, in microAlgos. */
export const PLATFORM_STORAGE_RESERVE_MICRO_ALGOS = 1_000_000n

/** Minimum transaction fee, in microAlgos. */
export const FEE_MICRO_ALGOS = 1_000n

/** Extra fee for the first-touch Registry check inside `credit`. */
export const FEE_CREDIT_EXTRA_MICRO_ALGOS = 1_000n

/** Extra fee for the claim inner app call plus payment. */
export const FEE_CLAIM_EXTRA_MICRO_ALGOS = 2_000n

/** Extra fee for the delete settle/notify inner call plus escrow close. */
export const FEE_DELETE_EXTRA_MICRO_ALGOS = 2_000n

/** Extra fee for the unregister inner deposit return. */
export const FEE_UNREGISTER_EXTRA_MICRO_ALGOS = 1_000n

/** Credit call fee: outer call plus the first-touch Registry check. */
export const CREDIT_FEE_MICRO_ALGOS = FEE_MICRO_ALGOS + FEE_CREDIT_EXTRA_MICRO_ALGOS

/** Claim call fee: outer call plus the inner app call and payment. */
export const CLAIM_FEE_MICRO_ALGOS = FEE_MICRO_ALGOS + FEE_CLAIM_EXTRA_MICRO_ALGOS

/** Delete call fee: outer call plus the settle/notify inner call and escrow close. */
export const DELETE_FEE_MICRO_ALGOS = FEE_MICRO_ALGOS + FEE_DELETE_EXTRA_MICRO_ALGOS

/** Unregister call fee: outer call plus the inner deposit return. */
export const UNREGISTER_FEE_MICRO_ALGOS = FEE_MICRO_ALGOS + FEE_UNREGISTER_EXTRA_MICRO_ALGOS

/** Pledge group fee before OpUp takes: payment, pledge, and credit. */
export const PLEDGE_GROUP_FEE_MICRO_ALGOS = 2n * FEE_MICRO_ALGOS + CREDIT_FEE_MICRO_ALGOS

/** Register group fee: register and its payment. */
export const REGISTER_GROUP_FEE_MICRO_ALGOS = 2n * FEE_MICRO_ALGOS

/** Cleanup group fee: unregister and delete. */
export const CLEANUP_GROUP_FEE_MICRO_ALGOS = UNREGISTER_FEE_MICRO_ALGOS + DELETE_FEE_MICRO_ALGOS

/** Budget cost per frontier peak in `pledge`. */
export const PLEDGE_PEAK_COST = 240

/** Base budget cost in `pledge`. */
export const PLEDGE_BASE_COST = 400

/** Budget cost per path element in a spend. */
export const SPEND_ELEMENT_COST = 250

/** Base budget cost in a spend. */
export const SPEND_BASE_COST = 700

/** Opcode budget added per OpUp take. */
export const OPUP_BUDGET_PER_ITERATION = 700

/** Conservative budget available before the first OpUp take. */
export const OPUP_AVAILABLE_BUDGET = 1_000

/** Net budget a spend take makes available after its loop cost. */
export const OPUP_SPEND_NET_BUDGET = 670

/** Safety margin in the off-chain spend top-up estimate. */
export const SPEND_TOP_UP_OVERHEAD = 12

/** Safety margin in the off-chain pledge top-up estimate. */
export const OPUP_ITERATION_SLACK = 10

/** Bytes in one AVM program page. */
export const APP_PAGE_BYTES = 2_048

/** Maximum extra pages allowed without the surcharge path. */
export const MAX_EXTRA_PAGES = 3

/** Account base minimum balance, in microAlgos. */
export const ACCOUNT_BASE_MICRO_ALGOS = 100_000n

/** App-account base minimum balance, in microAlgos. */
export const APP_MBR_BASE_MICRO_ALGOS = 100_000

/** App MBR per global/local byte-slice, in microAlgos. */
export const APP_MBR_BYTE_MICRO_ALGOS = 50_000

/** App MBR per global/local uint, in microAlgos. */
export const APP_MBR_UINT_MICRO_ALGOS = 28_500

/** App MBR per extra program page, in microAlgos. */
export const APP_MBR_PAGE_MICRO_ALGOS = 100_000

/** Vault campaign box MBR, in microAlgos. */
export const VAULT_BOX_MBR_MICRO_ALGOS = 32_100n
