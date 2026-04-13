// FinChip Protocol V2.3 — Contract addresses and ABIs
// BSC (56) + Base (8453)

export const ADDRESSES = {
  agentRegistry: {
    56:   '0xD234DD9982ECcc0972A495C8BFF8A502d8AAdC86',
    8453: '0x82382275825f0309cCEC6Aa8c7Ab681E4E57f309',
  },
  chipRegistry: {
    56:   '0xa0FAc185363F88f2D731258A9dC73765c0F33083',
    8453: '0xC8A1C5F9f20DB316763bB5e792E47155414558EE',
  },
  factory: {
    56:   '0x1CCd85B48f5744Ff8f375551af0A68598Fb353C6',
    8453: '0xF245D0C3667855F3756bEa73c36f6e946C037418',
  },
  market: {
    56:   '0xB9Db99459715b13128B2a0362e914cf51D038532',
    8453: '0xb897f9b04994cB135220757Bc05E60F2d5a52750',
  },
  feeRouter: {
    56:   '0x16Fe95f3BBAa2242f4fbb137151cb54f253f0664',
    8453: '0x7952099ceC252a2fB22E75022D4473c004178199',
  },
};

export const RPCS = {
  56:   'https://bsc-dataseed.binance.org',
  8453: 'https://mainnet.base.org',
};

export const CHAIN_NAMES = {
  56:   'BSC Mainnet',
  8453: 'Base Mainnet',
};

export const PERM = {
  READ:    0x01,
  ACQUIRE: 0x02,
  LAUNCH:  0x04,
  TRADE:   0x08,
  FULL:    0x0F,
};

// ── ABIs ──────────────────────────────────────────────────────────────────────

export const AGENT_REGISTRY_ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [
      { name: 'fcKey',       type: 'bytes32' },
      { name: 'agentWallet', type: 'address' },
      { name: 'permissions', type: 'uint8'   },
      { name: 'walletType',  type: 'uint8'   },
      { name: 'label',       type: 'string'  },
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
  { type: 'function', name: 'getProtocol', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'chipRegistry', type: 'address' },
      { name: 'factory',      type: 'address' },
      { name: 'market',       type: 'address' },
      { name: 'feeRouter',    type: 'address' },
    ] },
  { type: 'function', name: 'hasPermission', stateMutability: 'view',
    inputs: [{ name: 'fcKey', type: 'bytes32' }, { name: 'perm', type: 'uint8' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'keysOf', stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'totalAgents', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable',
    inputs: [{ name: 'fcKey', type: 'bytes32' }], outputs: [] },
];

export const CHIP_REGISTRY_ABI = [
  { type: 'function', name: 'allSlugs', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'resolve', stateMutability: 'view',
    inputs: [{ name: 'slug', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalRegistered', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creatorByChip', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
];

export const CHIP_ABI = [
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
  { type: 'function', name: 'purchaseLicense', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setLicensePrice', stateMutability: 'nonpayable',
    inputs: [{ name: 'newPrice', type: 'uint256' }], outputs: [] },
];

export const FACTORY_ABI = [
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
    ], outputs: [{ name: 'chipAddress', type: 'address' }] },
  { type: 'function', name: 'totalChips', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'chipsOf', stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address' }], outputs: [{ type: 'address[]' }] },
  { type: 'event', name: 'ChipDeployedV2',
    inputs: [
      { name: 'chipContract', type: 'address', indexed: true  },
      { name: 'creator',      type: 'address', indexed: true  },
      { name: 'slug',         type: 'string',  indexed: false },
    ] },
];

export const MARKET_ABI = [
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
      { name: 'standard',     type: 'uint8'   },
      { name: 'active',       type: 'bool'    },
    ]}] },
  { type: 'function', name: 'listToken', stateMutability: 'nonpayable',
    inputs: [
      { name: 'chipAddr',     type: 'address' },
      { name: 'creator',      type: 'address' },
      { name: 'tokenId',      type: 'uint256' },
      { name: 'quantity',     type: 'uint256' },
      { name: 'pricePerUnit', type: 'uint256' },
      { name: 'standard',     type: 'uint8'   },
    ], outputs: [{ name: 'listingId', type: 'uint256' }] },
  { type: 'function', name: 'buyListing', stateMutability: 'payable',
    inputs: [{ name: 'listingId', type: 'uint256' }, { name: 'quantity', type: 'uint256' }],
    outputs: [] },
  { type: 'function', name: 'cancelListing', stateMutability: 'nonpayable',
    inputs: [{ name: 'listingId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'listingsForChip', stateMutability: 'view',
    inputs: [
      { name: 'chipAddr', type: 'address' },
      { name: 'offset',   type: 'uint256' },
      { name: 'limit',    type: 'uint256' },
    ], outputs: [{ name: 'ids', type: 'uint256[]' }, { name: 'count', type: 'uint256' }] },
];
