/** MicroAlgos in one ALGO. */
export declare const MICRO_ALGOS_PER_ALGO = 1000000n;
/** Maximum uint64 value, for the explicit overflow guards. */
export declare const MAX_UINT64 = 18446744073709551615n;
/** Maximum claim-tree positions: 2^19 - 1. */
export declare const MAX_TREE_SIZE = 524287n;
/** The empty-tree root and consumed-leaf marker. */
export declare const ZERO_ROOT_HEX = "0000000000000000000000000000000000000000000000000000000000000000";
/** Domain prefix for leaves: `H(0x01 ‖ backer ‖ amount-be64 ‖ txid)`. */
export declare const LEAF_DOMAIN_HEX = "01";
/** Minimum campaign goal, in microAlgos. */
export declare const MIN_GOAL_MICRO_ALGOS = 100000n;
/** Maximum campaign goal, in microAlgos. */
export declare const MAX_GOAL_MICRO_ALGOS = 10000000000000000n;
/** Minimum pledge, in microAlgos. */
export declare const MIN_PLEDGE_MICRO_ALGOS = 100000n;
/** Maximum pledge, in microAlgos: the total ALGO supply, the same bound as the goal. */
export declare const MAX_PLEDGE_MICRO_ALGOS = 10000000000000000n;
/** Maximum bytes in one AVM state entry (key + value). */
export declare const MAX_STATE_ENTRY_BYTES = 128;
/** Maximum campaign title bytes (the 5-byte `title` state key counts toward the 128-byte entry cap). */
export declare const MAX_TITLE_BYTES: number;
/** Maximum campaign metadata URI bytes (the 11-byte `metadataUri` key counts toward the entry cap). */
export declare const MAX_METADATA_URI_BYTES: number;
/** Seconds in one day. */
export declare const SECONDS_PER_DAY = 86400;
/** Minimum campaign duration, in seconds. */
export declare const MIN_CAMPAIGN_DURATION_SECONDS = 86400;
/** Maximum campaign duration, in seconds. */
export declare const MAX_CAMPAIGN_DURATION_SECONDS: number;
/** Final-day window for the goal-protection cancel rule, in seconds. */
export declare const FINAL_DAY_SECONDS = 86400;
/** Minimum vault refund window, in seconds. */
export declare const MIN_REFUND_WINDOW_SECONDS: number;
/** Maximum vault refund window, in seconds. */
export declare const MAX_REFUND_WINDOW_SECONDS: number;
/** Box MBR base per box, in microAlgos. */
export declare const BOX_MBR_BASE_MICRO_ALGOS = 2500n;
/** Box MBR per key/value byte, in microAlgos. */
export declare const BOX_MBR_PER_BYTE_MICRO_ALGOS = 400n;
/** Registry registration deposit, in microAlgos: 2,500 + 400 × (9 + 32). */
export declare const REGISTER_DEPOSIT_MICRO_ALGOS = 18900n;
/** Vault campaign box MBR, in microAlgos: 2,500 + 400 × (9 + 65). */
export declare const VAULT_BOX_MBR_MICRO_ALGOS = 32100n;
/** Platform storage reserve funded to each deployed app account, in microAlgos. */
export declare const PLATFORM_STORAGE_RESERVE_MICRO_ALGOS = 1000000n;
/** Minimum transaction fee, in microAlgos. */
export declare const FEE_MICRO_ALGOS = 1000n;
/** Inner transactions funded by the credit call: the first-touch Registry check. */
export declare const CREDIT_EXTRA_INNERS = 1n;
/** Inner transactions funded by the claim call: the vault app call and payment. */
export declare const CLAIM_EXTRA_INNERS = 2n;
/** Inner transactions funded by the delete call: settle/notify and the escrow close. */
export declare const DELETE_EXTRA_INNERS = 2n;
/** Inner transactions funded by the unregister call: the deposit return. */
export declare const UNREGISTER_EXTRA_INNERS = 1n;
/** Extra fee for the first-touch Registry check inside `credit`. */
export declare const FEE_CREDIT_EXTRA_MICRO_ALGOS: bigint;
/** Extra fee for the claim inner app call plus payment. */
export declare const FEE_CLAIM_EXTRA_MICRO_ALGOS: bigint;
/** Extra fee for the delete settle/notify inner call plus escrow close. */
export declare const FEE_DELETE_EXTRA_MICRO_ALGOS: bigint;
/** Extra fee for the unregister inner deposit return. */
export declare const FEE_UNREGISTER_EXTRA_MICRO_ALGOS: bigint;
/** Credit call fee: outer call plus the first-touch Registry check. */
export declare const CREDIT_FEE_MICRO_ALGOS: bigint;
/** Claim call fee: outer call plus the inner app call and payment. */
export declare const CLAIM_FEE_MICRO_ALGOS: bigint;
/** Delete call fee: outer call plus the settle/notify inner call and escrow close. */
export declare const DELETE_FEE_MICRO_ALGOS: bigint;
/** Unregister call fee: outer call plus the inner deposit return. */
export declare const UNREGISTER_FEE_MICRO_ALGOS: bigint;
/** Pledge group fee before OpUp takes: payment, pledge, and credit. */
export declare const PLEDGE_GROUP_FEE_MICRO_ALGOS: bigint;
/** Register group fee: register and its payment. */
export declare const REGISTER_GROUP_FEE_MICRO_ALGOS: bigint;
/** Cleanup group fee: unregister and delete. */
export declare const CLEANUP_GROUP_FEE_MICRO_ALGOS: bigint;
/** Budget cost per frontier peak in `pledge`. */
export declare const PLEDGE_PEAK_COST = 240;
/** Base budget cost in `pledge`. */
export declare const PLEDGE_BASE_COST = 400;
/** Budget cost per path element in a spend. */
export declare const SPEND_ELEMENT_COST = 250;
/** Base budget cost in a spend. */
export declare const SPEND_BASE_COST = 700;
/** Opcode budget added per OpUp take. */
export declare const OPUP_BUDGET_PER_ITERATION = 700;
/** Conservative budget available before the first OpUp take. */
export declare const OPUP_AVAILABLE_BUDGET = 1000;
/** Net budget a spend take makes available after its loop cost. */
export declare const OPUP_SPEND_NET_BUDGET = 670;
/** Safety margin in the off-chain spend top-up estimate. */
export declare const SPEND_TOP_UP_OVERHEAD = 12;
/** Safety margin in the off-chain pledge top-up estimate. */
export declare const OPUP_ITERATION_SLACK = 10;
/** Bytes in one AVM program page. */
export declare const APP_PAGE_BYTES = 2048;
/** Maximum extra pages allowed without the surcharge path. */
export declare const MAX_EXTRA_PAGES = 3;
/** Account base minimum balance, in microAlgos. */
export declare const ACCOUNT_BASE_MICRO_ALGOS = 100000n;
/** App-account base minimum balance, in microAlgos (`AppFlatParamsMinBalance`). */
export declare const APP_MBR_BASE_MICRO_ALGOS = 100000;
/** App MBR per global/local schema entry, in microAlgos (`SchemaMinBalancePerEntry`). */
export declare const APP_MBR_ENTRY_MICRO_ALGOS = 25000;
/** App MBR per byte-slice schema value, in microAlgos (`SchemaBytesMinBalance`). */
export declare const APP_MBR_BYTES_MICRO_ALGOS = 25000;
/** App MBR per uint schema value, in microAlgos (`SchemaUintMinBalance`). */
export declare const APP_MBR_UINT_MICRO_ALGOS = 3500;
/** App MBR per extra program page, in microAlgos (`AppFlatParamsMinBalance`). */
export declare const APP_MBR_PAGE_MICRO_ALGOS = 100000;
/** Campaign status: Open. */
export declare const CAMPAIGN_STATUS_OPEN = 0n;
/** Campaign status: Failed. */
export declare const CAMPAIGN_STATUS_FAILED = 1n;
/** Campaign status: Claimed. */
export declare const CAMPAIGN_STATUS_CLAIMED = 2n;
/** Vault box status byte: Open. */
export declare const VAULT_BOX_STATUS_OPEN_HEX = "01";
/** Vault box status byte: Failed. */
export declare const VAULT_BOX_STATUS_FAILED_HEX = "02";
/** Vault box status byte: Claimed. */
export declare const VAULT_BOX_STATUS_CLAIMED_HEX = "03";
/** Packed vault campaign box length, in bytes. */
export declare const VAULT_BOX_BYTES = 65;
/** `paidIn` offset in the packed vault box. */
export declare const VAULT_BOX_PAID_IN_OFFSET = 0;
/** `paidOut` offset in the packed vault box. */
export declare const VAULT_BOX_PAID_OUT_OFFSET = 8;
/** Root offset in the packed vault box. */
export declare const VAULT_BOX_ROOT_OFFSET = 16;
/** `n` offset in the packed vault box. */
export declare const VAULT_BOX_N_OFFSET = 48;
/** Status byte offset in the packed vault box. */
export declare const VAULT_BOX_STATUS_OFFSET = 56;
/** `settledAt` offset in the packed vault box. */
export declare const VAULT_BOX_SETTLED_AT_OFFSET = 57;
/** Bytes in one box key prefix. */
export declare const BOX_KEY_PREFIX_BYTES = 1;
/** Bytes in an AVM application id (and in an app-id box key suffix). */
export declare const APP_ID_BYTES = 8;
/** Bytes in an Algorand address (and in a Registry box value). */
export declare const ADDRESS_BYTES = 32;
/** Vault campaign box key prefix (the box key is `c` + 8-byte app id). */
export declare const VAULT_BOX_PREFIX = "c";
/** Registry registration box key prefix (the box key is `r` + 8-byte app id). */
export declare const REGISTRY_BOX_PREFIX = "r";
//# sourceMappingURL=index.d.ts.map