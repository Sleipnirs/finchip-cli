// FinChip CLI v0.3.0 — Protocol layer
// =====================================
// PHILOSOPHY:
//   In v0.2.x we hardcoded 6 contract addresses per chain (5×6 = 30 addresses).
//   That meant every protocol upgrade required a CLI re-release.
//
//   v0.3.0 only hardcodes the AgentRegistry — the on-chain discovery contract.
//   All other addresses (ChipRegistry, Factory, Market, FeeRouter, Deployers)
//   are resolved at runtime via AgentRegistry.getProtocolExtended().
//
//   This means future V2.6+ upgrades require ZERO CLI code changes — the
//   protocol team just calls AgentRegistry.setProtocol() on each chain and
//   every existing CLI installation auto-discovers the new addresses.

// ── AgentRegistry addresses (V2.4 / V2.5 sticky) ─────────────────────────────
// These ARE the only addresses the CLI hardcodes. Verified against on-chain
// state on 2026-05-16.
export const AGENT_REGISTRY = {
  56:    '0x649266FBF0b886369414393aD74F150d8a0f2A0f', // BSC
  8453:  '0x0E89f9d579a8449320F1E9De00Be72138C2F16D0', // Base
  1:     '0xbCd5B962b7a56129b0d2ACBF3765647736fA1FA1', // Ethereum
  42161: '0x98D112621AD92bd61B54c648D59fd505E1F400b5', // Arbitrum
  10:    '0x98D112621AD92bd61B54c648D59fd505E1F400b5', // Optimism (= Arb due to nonce parity)
};

// ── Permission bitmask (from AgentRegistry.sol constants) ────────────────────
export const PERM = {
  READ:    0x01,
  ACQUIRE: 0x02,
  LAUNCH:  0x04,
  TRADE:   0x08,
  FULL:    0x0F,
};

export const WALLET_TYPE = {
  EOA:      1,
  AA:       2,
  MULTISIG: 3,
};

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

// ── AgentRegistry V2.4 ──────────────────────────────────────────────────────
// Full ABI matching the deployed contract on all 5 chains.
export const AGENT_REGISTRY_ABI = [
  // V2.3 base — preserved unchanged
  { type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [
      { name: 'fcKey',       type: 'bytes32' },
      { name: 'agentWallet', type: 'address' },
      { name: 'permissions', type: 'uint8'   },
      { name: 'walletType',  type: 'uint8'   },
      { name: 'label',       type: 'string'  },
    ], outputs: [] },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable',
    inputs: [{ name: 'fcKey', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'updatePermissions', stateMutability: 'nonpayable',
    inputs: [
      { name: 'fcKey',          type: 'bytes32' },
      { name: 'newPermissions', type: 'uint8'   },
    ], outputs: [] },
  { type: 'function', name: 'verify', stateMutability: 'view',
    inputs: [{ name: 'fcKey', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'wallet',       type: 'address' },
      { name: 'permissions',  type: 'uint8'   },
      { name: 'walletType',   type: 'uint8'   },
      { name: 'registeredAt', type: 'uint64'  },
      { name: 'active',       type: 'bool'    },
      { name: 'label',        type: 'string'  },
    ]}] },
  { type: 'function', name: 'hasPermission', stateMutability: 'view',
    inputs: [
      { name: 'fcKey', type: 'bytes32' },
      { name: 'perm',  type: 'uint8'   },
    ],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'keysOf', stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'totalAgents', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },

  // V2.3 protocol discovery
  { type: 'function', name: 'getProtocol', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'chipRegistry', type: 'address' },
      { name: 'factory',      type: 'address' },
      { name: 'market',       type: 'address' },
      { name: 'feeRouter',    type: 'address' },
    ] },
  { type: 'function', name: 'protocolSummary', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'agentRegistry',         type: 'address' },
      { name: 'chipRegistry',          type: 'address' },
      { name: 'factory',               type: 'address' },
      { name: 'market',                type: 'address' },
      { name: 'feeRouter',             type: 'address' },
      { name: 'totalRegisteredAgents', type: 'uint256' },
      { name: 'totalRegisteredChips',  type: 'uint256' },
    ] },
  { type: 'function', name: 'totalChipsOnProtocol', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'resolveChip', stateMutability: 'view',
    inputs: [{ name: 'slug', type: 'string' }],
    outputs: [{ type: 'address' }] },

  // V2.4 NEW — extended discovery
  { type: 'function', name: 'getProtocolExtended', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'chipRegistry',    type: 'address' },
      { name: 'factory',         type: 'address' },
      { name: 'market',          type: 'address' },
      { name: 'feeRouter',       type: 'address' },
      { name: 'erc1155Deployer', type: 'address' },
      { name: 'erc721Deployer',  type: 'address' },
      { name: 'factoryPaused',   type: 'bool'    },
    ] },
  { type: 'function', name: 'protocolSummaryV2', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'agentRegistry',           type: 'address' },
      { name: 'chipRegistry',            type: 'address' },
      { name: 'factory',                 type: 'address' },
      { name: 'market',                  type: 'address' },
      { name: 'feeRouter',               type: 'address' },
      { name: 'totalRegisteredAgents',   type: 'uint256' },
      { name: 'totalRegisteredChips',    type: 'uint256' },
      { name: 'totalRegisteredChips721', type: 'uint256' },
      { name: 'factoryPaused',           type: 'bool'    },
    ] },
  { type: 'function', name: 'totalChips721OnProtocol', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allSlugs', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'chipsOf', stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }],
    outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'chips721Of', stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }],
    outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'isFactoryPaused', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'bool' }] },

  // Version constant getter
  { type: 'function', name: 'VERSION', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string' }] },
];

// ── ChipRegistry ────────────────────────────────────────────────────────────
export const CHIP_REGISTRY_ABI = [
  { type: 'function', name: 'resolve', stateMutability: 'view',
    inputs: [{ name: 'slug', type: 'string' }],
    outputs: [{ type: 'address' }] },
  { type: 'function', name: 'allSlugs', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'totalRegistered', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creatorByChip', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'address' }] },
];

// ── FinChipFactory V2 (V2.4 split — ERC-1155 + ERC-721) ────────────────────
export const FACTORY_ABI = [
  // ERC-1155 path
  { type: 'function', name: 'deployChip', stateMutability: 'nonpayable',
    inputs: [
      { name: 'name',            type: 'string'  },
      { name: 'slug',            type: 'string'  },
      { name: 'metadataURI',     type: 'string'  },
      { name: 'contentHash',     type: 'bytes32' },
      { name: 'sourceUrl',       type: 'string'  },
      { name: 'category',        type: 'string'  },
      { name: 'licenseTypeName', type: 'string'  },
      { name: 'feeModel',        type: 'uint8'   },
      { name: 'licensePrice',    type: 'uint256' },
      { name: 'maxSupply',       type: 'uint256' },
      { name: 'royaltyBPS',      type: 'uint96'  },
      { name: 'imageURI',        type: 'string'  },
      { name: 'usageLimit',      type: 'uint256' },
    ],
    outputs: [{ name: 'chipAddress', type: 'address' }] },
  // ERC-721 path (V2.4 NEW)
  { type: 'function', name: 'deployChip721', stateMutability: 'nonpayable',
    inputs: [
      { name: 'name',            type: 'string'  },
      { name: 'slug',            type: 'string'  },
      { name: 'metadataURI',     type: 'string'  },
      { name: 'contentHash',     type: 'bytes32' },
      { name: 'sourceUrl',       type: 'string'  },
      { name: 'category',        type: 'string'  },
      { name: 'licenseTypeName', type: 'string'  },
      { name: 'forkPrice',       type: 'uint256' },
      { name: 'maxForks',        type: 'uint256' },
      { name: 'royaltyBPS',      type: 'uint96'  },
      { name: 'imageURI',        type: 'string'  },
    ],
    outputs: [{ name: 'chipAddress', type: 'address' }] },
  { type: 'function', name: 'totalChips',     stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalChips721',  stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'chipsOf',        stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'chips721Of',     stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'erc1155Deployer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'erc721Deployer',  stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused',         stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },

  // Events
  { type: 'event', name: 'ChipDeployedV2',
    inputs: [
      { name: 'chipContract', type: 'address', indexed: true  },
      { name: 'creator',      type: 'address', indexed: true  },
      { name: 'slug',         type: 'string',  indexed: false },
    ] },
  { type: 'event', name: 'Chip721DeployedV2',
    inputs: [
      { name: 'chipContract', type: 'address', indexed: true  },
      { name: 'creator',      type: 'address', indexed: true  },
      { name: 'slug',         type: 'string',  indexed: false },
    ] },
];

// ── FinChipERC1155 chip ─────────────────────────────────────────────────────
// Generic chip ABI — covers reads, license purchase, lit data, approvals.
export const CHIP_ABI = [
  // Reads
  { type: 'function', name: 'name',         stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'slug',         stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'licensePrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxSupply',    stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalMinted',  stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creator',      stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'category',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'imageURI',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'usageLimit',   stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'litDataSet',   stateMutability: 'view', inputs: [], outputs: [{ type: 'bool'    }] },
  { type: 'function', name: 'supportsInterface', stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },

  // ERC-1155 license operations
  { type: 'function', name: 'purchaseLicense', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id',      type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [
      { name: 'account',  type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool'    },
    ],
    outputs: [] },

  // Creator-only setters
  { type: 'function', name: 'setLicensePrice', stateMutability: 'nonpayable',
    inputs: [{ name: 'newPrice', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setLitData', stateMutability: 'nonpayable',
    inputs: [
      { name: 'ciphertext',        type: 'string' },
      { name: 'dataToEncryptHash', type: 'bytes32' },
      { name: 'chain',             type: 'string' },
    ], outputs: [] },

  // Events
  { type: 'event', name: 'LicensePurchased',
    inputs: [
      { name: 'buyer',     type: 'address', indexed: true  },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'totalPaid', type: 'uint256', indexed: false },
    ] },
];

// ── FinChipERC721 fork chip (V2.4 NEW) ──────────────────────────────────────
export const CHIP_721_ABI = [
  // Reads (parallel to CHIP_ABI but ERC-721 semantics)
  { type: 'function', name: 'name',       stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'slug',       stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'forkPrice',  stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxForks',   stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalForked',stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply',stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creator',    stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'category',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'imageURI',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'parentChip', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'litDataSet', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool'    }] },
  { type: 'function', name: 'supportsInterface', stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },

  // ERC-721 fork purchase
  { type: 'function', name: 'purchaseFork', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [
      { name: 'owner',    type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool'    },
    ],
    outputs: [] },

  // Creator-only setters
  { type: 'function', name: 'setForkPrice', stateMutability: 'nonpayable',
    inputs: [{ name: 'newPrice', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setLitData', stateMutability: 'nonpayable',
    inputs: [
      { name: 'ciphertext',        type: 'string' },
      { name: 'dataToEncryptHash', type: 'bytes32' },
      { name: 'chain',             type: 'string' },
    ], outputs: [] },

  // Events
  { type: 'event', name: 'ForkPurchased',
    inputs: [
      { name: 'buyer',   type: 'address', indexed: true  },
      { name: 'tokenId', type: 'uint256', indexed: true  },
      { name: 'price',   type: 'uint256', indexed: false },
    ] },
];

// ── FinChipMarket V2 (V2.5 — feeRouterLocked) ───────────────────────────────
export const MARKET_ABI = [
  // Reads
  { type: 'function', name: 'listingCount', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getListing', stateMutability: 'view',
    inputs: [{ name: 'listingId', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'seller',       type: 'address' },
      { name: 'chipAddr',     type: 'address' },
      { name: 'creator',      type: 'address' },
      { name: 'tokenId',      type: 'uint256' },
      { name: 'quantity',     type: 'uint256' },
      { name: 'pricePerUnit', type: 'uint256' },
      { name: 'totalToken1',  type: 'uint256' },
      { name: 'standard',     type: 'uint8'   }, // 0 = ERC1155, 1 = ERC721
      { name: 'active',       type: 'bool'    },
    ]}] },
  { type: 'function', name: 'listingsForChip', stateMutability: 'view',
    inputs: [
      { name: 'chipAddr', type: 'address' },
      { name: 'offset',   type: 'uint256' },
      { name: 'limit',    type: 'uint256' },
    ],
    outputs: [
      { name: 'ids',   type: 'uint256[]' },
      { name: 'count', type: 'uint256' },
    ] },
  { type: 'function', name: 'feeRouter', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'feeRouterLocked', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'bool' }] },

  // Writes
  { type: 'function', name: 'listToken', stateMutability: 'nonpayable',
    inputs: [
      { name: 'chipAddr',     type: 'address' },
      { name: 'creator',      type: 'address' },
      { name: 'tokenId',      type: 'uint256' },
      { name: 'quantity',     type: 'uint256' },
      { name: 'pricePerUnit', type: 'uint256' },
      { name: 'standard',     type: 'uint8'   },
    ],
    outputs: [{ name: 'listingId', type: 'uint256' }] },
  { type: 'function', name: 'buyListing', stateMutability: 'payable',
    inputs: [
      { name: 'listingId', type: 'uint256' },
      { name: 'quantity',  type: 'uint256' },
    ],
    outputs: [] },
  { type: 'function', name: 'cancelListing', stateMutability: 'nonpayable',
    inputs: [{ name: 'listingId', type: 'uint256' }],
    outputs: [] },

  // Events
  { type: 'event', name: 'Listed',
    inputs: [
      { name: 'listingId',    type: 'uint256', indexed: true  },
      { name: 'seller',       type: 'address', indexed: true  },
      { name: 'chip',         type: 'address', indexed: true  },
      { name: 'tokenId',      type: 'uint256', indexed: false },
      { name: 'amount',       type: 'uint256', indexed: false },
      { name: 'pricePerUnit', type: 'uint256', indexed: false },
    ] },
  { type: 'event', name: 'Filled',
    inputs: [
      { name: 'listingId', type: 'uint256', indexed: true  },
      { name: 'buyer',     type: 'address', indexed: true  },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'totalPaid', type: 'uint256', indexed: false },
    ] },
];

// ── FeeRouter V2 (V2.5 — treasuryLocked, BPS constants) ─────────────────────
export const FEE_ROUTER_ABI = [
  { type: 'function', name: 'platformTreasury', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'treasuryLocked', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'DUST_THRESHOLD', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MINT_CREATOR_BPS', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MINT_PLATFORM_BPS', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'TRADE_SELLER_BPS', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'TRADE_CREATOR_BPS', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'TRADE_PLATFORM_BPS', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
];

// ── ERC-20 minimal ABI (for USDC in x402 payments) ──────────────────────────
export const ERC20_ABI = [
  { type: 'function', name: 'name',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'   }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
];

// ── ERC-165 interface IDs ────────────────────────────────────────────────────
export const IFACE_ID = {
  ERC1155: '0xd9b67a26',
  ERC721:  '0x80ac58cd',
};
