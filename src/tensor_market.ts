const TENSOR_GRAPHQL_URL = 'https://graphql.tensor.trade/graphql';
export const TENSOR_TAKER_FEE_BPS = 200;

export const STAR_ATLAS_CREW_COLLECTION_UUID = '42c0b80a-5945-4a18-84d3-467af9ccb9a2';
export const STAR_ATLAS_CREW_TARGET_ID = '13oBYyDzdGJxMJPdzRjmCBALL5akjJkarK1C43SUt2Ep';

const ACTIVE_LISTINGS_QUERY = `query ActiveListingsPricesV2($slug: String!, $filters: ActiveListingsFilters) {
  activeListingsPricesV2(slug: $slug, filters: $filters) {
    prices {
      ...ReducedActiveListingPrice
      __typename
    }
    numListed
    maxPrice {
      ...ReducedActiveListingPrice
      __typename
    }
    __typename
  }
}

fragment ReducedActiveListingPrice on ActiveListingPrice {
  tx {
    mint {
      onchainId
      name
      imageUri
      sellRoyaltyFeeBPS
      attributes {
        trait_type
        value
        __typename
      }
      ...MintRarityFields
      __typename
    }
    __typename
  }
  owner
  price
  txAt
  source
  __typename
}

fragment MintRarityFields on TLinkedTxMintTV2 {
  rarityRankHrtt
  rarityRankStat
  rarityRankTeam
  rarityRankTn
  __typename
}`;

const SWAP_ORDERS_QUERY = `query SwapOrders($slug: String!, $owner: String) {
  tswapOrders(slug: $slug, owner: $owner) {
    ...ReducedTSwapPool
    __typename
  }
  hswapOrders(slug: $slug, owner: $owner) {
    ...ReducedHSwapPool
    __typename
  }
  tammOrders(slug: $slug, owner: $owner) {
    ...ReducedTAmmPool
    __typename
  }
  tcompBids(slug: $slug, owner: $owner) {
    ...ReducedTCompBid
    __typename
  }
}

fragment ReducedTSwapPool on TSwapPool {
  address
  ownerAddress
  whitelistAddress
  poolType
  curveType
  startingPrice
  delta
  mmCompoundFees
  mmFeeBalance
  mmFeeBps
  takerSellCount
  takerBuyCount
  nftsHeld
  solBalance
  createdUnix
  statsTakerSellCount
  statsTakerBuyCount
  statsAccumulatedMmProfit
  margin
  marginNr
  lastTransactedAt
  maxTakerSellCount
  nftsForSale {
    ...ReducedMint
    __typename
  }
  __typename
}

fragment ReducedMint on TLinkedTxMintTV2 {
  onchainId
  compressed
  owner
  name
  imageUri
  animationUri
  metadataUri
  metadataFetchedAt
  files {
    type
    uri
    __typename
  }
  sellRoyaltyFeeBPS
  tokenStandard
  tokenEdition
  attributes {
    trait_type
    value
    __typename
  }
  lastSale {
    price
    txAt
    __typename
  }
  accState
  hidden
  ...MintRarityFields
  staked {
    stakedAt
    activatedAt
    stakedByOwner
    __typename
  }
  inscription {
    ...InscriptionData
    __typename
  }
  tokenProgram
  metadataProgram
  transferHookProgram
  listingNormalizedPrice
  hybridAmount
  __typename
}

fragment MintRarityFields on TLinkedTxMintTV2 {
  rarityRankHrtt
  rarityRankStat
  rarityRankTeam
  rarityRankTn
  __typename
}

fragment InscriptionData on InscriptionData {
  inscription
  inscriptionData
  immutable
  order
  spl20 {
    p
    tick
    amt
    __typename
  }
  __typename
}

fragment ReducedHSwapPool on HSwapPool {
  address
  pairType
  delta
  curveType
  baseSpotPrice
  feeBps
  mathCounter
  assetReceiver
  boxes {
    address
    vaultTokenAccount
    mint {
      ...ReducedMint
      __typename
    }
    __typename
  }
  feeBalance
  buyOrdersQuantity
  fundsSolOrTokenBalance
  createdAt
  lastTransactedAt
  __typename
}

fragment ReducedTAmmPool on TAmmPool {
  address
  owner
  whitelist
  poolType
  curveType
  startingPrice
  delta
  mmCompoundFees
  mmFeeBps
  priceOffset
  nftsHeld
  solBalance
  createdUnix
  statsTakerSellCount
  statsTakerBuyCount
  statsAccumulatedMmProfit
  sharedEscrow
  marginNr
  updatedUnix
  maxTakerSellCount
  nftsForSale {
    ...ReducedMint
    __typename
  }
  __typename
}

fragment ReducedTCompBid on TCompBid {
  address
  target
  targetId
  field
  fieldId
  amount
  solBalance
  ownerAddress
  filledQuantity
  quantity
  margin
  marginNr
  createdAt
  attributes {
    trait_type
    value
    __typename
  }
  __typename
}`;

const TCOMP_BID_TX_QUERY = `query TcompBidTx(
  $quantity: Float!
  $price: Decimal!
  $owner: String!
  $slug: String
  $marginNr: Float
  $attributes: [AttributeInput!]
  $priorityMicroLamports: Int!
  $blockhash: String
) {
  tcompBidTx(
    quantity: $quantity
    price: $price
    owner: $owner
    slug: $slug
    marginNr: $marginNr
    attributes: $attributes
    priorityMicroLamports: $priorityMicroLamports
    blockhash: $blockhash
  ) {
    txs {
      tx
      txV0
      lastValidBlockHeight
      metadata
    }
  }
}`;

const TSWAP_MARGIN_ACCOUNTS_QUERY = `query TswapMarginAccounts($owner: String!) {
  tswapMarginAccounts(owner: $owner) {
    address
    nr
    name
    balance
  }
}`;

export type TensorListingPrice = {
  owner: string;
  price: string;
  txAt: number;
  source: string;
  tx?: {
    mint?: {
      onchainId?: string;
      name?: string;
      imageUri?: string;
      sellRoyaltyFeeBPS?: number;
      attributes?: Array<{ trait_type: string; value: string }> | null;
    };
  };
};

export type TensorTcompBid = {
  address: string;
  target: string | null;
  targetId: string | null;
  field: string | null;
  fieldId: string | null;
  amount: string;
  solBalance: string | null;
  ownerAddress: string;
  filledQuantity: number;
  quantity: number;
  margin: string | null;
  marginNr: number | null;
  createdAt: number;
  attributes: Array<{ trait_type: string; value: string }> | null;
};

export type CrewMarketSnapshot = {
  bestAskLamports: number | null;
  bestCompetingBidLamports: number | null;
  competingBidLamports: number[];
  bestCompetingBidAddress: string | null;
  bestCompetingBidOwnerAddress: string | null;
  bestCompetingBidQuantity: number | null;
  bestCompetingBidFilledQuantity: number | null;
  ownBidLamports: number | null;
  ownBidAddress: string | null;
  ownBidQuantity: number | null;
  ownBidFilledQuantity: number | null;
  ownBidSolBalanceLamports: number | null;
  ownBidMarginNr: number | null;
  ownBidMargin: string | null;
  royaltyFeeBps: number | null;
  listings: TensorListingPrice[];
  genericCollectionBids: TensorTcompBid[];
  ownBids: TensorTcompBid[];
};

export type CrewAttributeFilter = {
  trait_type: string;
  value: string;
};

export type TensorMarginAccount = {
  address: string;
  nr: number;
  name: string | null;
  balance: string | null;
};

export type TensorTxResponse = {
  tx?: { type?: string; data?: number[] } | number[] | string | null;
  txV0?: { type?: string; data?: number[] } | number[] | string | null;
  lastValidBlockHeight?: number | null;
  metadata?: unknown;
};

export type TensorTcompBidTxResult = {
  txs: TensorTxResponse[];
};

async function tensorPost<T>(body: unknown): Promise<T> {
  const response = await fetch(TENSOR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.tensor.trade',
      referer: 'https://www.tensor.trade/'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Tensor GraphQL failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchCrewListings(slugUuid = STAR_ATLAS_CREW_COLLECTION_UUID): Promise<{
  prices: TensorListingPrice[];
  royaltyFeeBps: number | null;
}> {
  const json = await tensorPost<
    Array<{
      data?: {
        activeListingsPricesV2?: {
          prices?: TensorListingPrice[];
        };
      };
    }>
  >([
    {
      operationName: 'ActiveListingsPricesV2',
      variables: {
        slug: slugUuid,
        filters: null
      },
      query: ACTIVE_LISTINGS_QUERY
    }
  ]);

  const prices = json?.[0]?.data?.activeListingsPricesV2?.prices ?? [];
  const royaltyFeeBps =
    prices.find((p) => typeof p?.tx?.mint?.sellRoyaltyFeeBPS === 'number')?.tx?.mint
      ?.sellRoyaltyFeeBPS ?? null;

  return { prices, royaltyFeeBps };
}

function normalizeAttributeValue(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeAttributeKey(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function attributesExactlyMatch(
  actual: Array<{ trait_type: string; value: string }> | null | undefined,
  expected: CrewAttributeFilter[]
): boolean {
  const actualList = Array.isArray(actual) ? actual : [];
  if (actualList.length !== expected.length) {
    return false;
  }

  return expected.every((expectedAttribute) =>
    actualList.some(
      (actualAttribute) =>
        normalizeAttributeKey(actualAttribute.trait_type) === normalizeAttributeKey(expectedAttribute.trait_type) &&
        normalizeAttributeValue(actualAttribute.value) === normalizeAttributeValue(expectedAttribute.value)
    )
  );
}

export function attributesIncludeAll(
  actual: Array<{ trait_type: string; value: string }> | null | undefined,
  expected: CrewAttributeFilter[]
): boolean {
  if (!expected.length) {
    return true;
  }

  const actualList = Array.isArray(actual) ? actual : [];
  return expected.every((expectedAttribute) =>
    actualList.some(
      (actualAttribute) =>
        normalizeAttributeKey(actualAttribute.trait_type) === normalizeAttributeKey(expectedAttribute.trait_type) &&
        normalizeAttributeValue(actualAttribute.value) === normalizeAttributeValue(expectedAttribute.value)
    )
  );
}

export async function fetchCrewTcompBids(slugUuid = STAR_ATLAS_CREW_COLLECTION_UUID, owner?: string | null): Promise<TensorTcompBid[]> {
  const json = await tensorPost<
    Array<{
      data?: {
        tcompBids?: TensorTcompBid[];
      };
    }>
  >([
    {
      operationName: 'SwapOrders',
      variables: {
        slug: slugUuid,
        owner: owner ?? null
      },
      query: SWAP_ORDERS_QUERY
    }
  ]);

  return json?.[0]?.data?.tcompBids ?? [];
}

export function isGenericCrewCollectionBid(bid: TensorTcompBid, targetId = STAR_ATLAS_CREW_TARGET_ID): boolean {
  return (
    bid.target === 'WHITELIST' &&
    bid.targetId === targetId &&
    bid.field == null &&
    bid.fieldId == null &&
    (!bid.attributes || bid.attributes.length === 0)
  );
}

export function isMatchingCrewCollectionBid(
  bid: TensorTcompBid,
  targetId = STAR_ATLAS_CREW_TARGET_ID,
  attributes: CrewAttributeFilter[] = []
): boolean {
  return (
    bid.target === 'WHITELIST' &&
    bid.targetId === targetId &&
    bid.field == null &&
    bid.fieldId == null &&
    attributesExactlyMatch(bid.attributes, attributes)
  );
}

export function toLamports(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

export function sortBidsDescByAmount(a: TensorTcompBid, b: TensorTcompBid): number {
  return toLamports(b.amount) - toLamports(a.amount);
}

export function sortListingsAscByPrice(a: TensorListingPrice, b: TensorListingPrice): number {
  return toLamports(a.price) - toLamports(b.price);
}

export function applyTensorTakerFeesLamports(amountLamports: number, royaltyFeeBps: number | null): number {
  const totalBps = 10_000 + TENSOR_TAKER_FEE_BPS + Math.max(0, royaltyFeeBps ?? 0);
  return Math.ceil((amountLamports * totalBps) / 10_000);
}

export async function fetchCrewMarketSnapshot(params: {
  ownerAddress: string;
  ownBidState?: string | null;
  slugUuid?: string;
  targetId?: string;
  minRelevantBidQuantity?: number;
  whitelistOwners?: string[];
  attributes?: CrewAttributeFilter[];
}): Promise<CrewMarketSnapshot> {
  const slugUuid = params.slugUuid ?? STAR_ATLAS_CREW_COLLECTION_UUID;
  const targetId = params.targetId ?? STAR_ATLAS_CREW_TARGET_ID;
  const attributes = params.attributes ?? [];
  const [listingData, bids] = await Promise.all([fetchCrewListings(slugUuid), fetchCrewTcompBids(slugUuid, null)]);
  const whitelistOwners = new Set((params.whitelistOwners ?? []).map((owner) => owner.toLowerCase()));

  const listings = [...listingData.prices]
    .filter((listing) => attributesIncludeAll(listing.tx?.mint?.attributes, attributes))
    .filter((listing) => !whitelistOwners.has(String(listing.owner ?? '').toLowerCase()))
    .sort(sortListingsAscByPrice);
  const bestAskLamports = listings.length
    ? applyTensorTakerFeesLamports(toLamports(listings[0].price), listingData.royaltyFeeBps)
    : null;

  const genericCollectionBids = bids.filter((bid) => isMatchingCrewCollectionBid(bid, targetId, attributes)).sort(sortBidsDescByAmount);
  const minRelevantBidQuantity = Math.max(1, params.minRelevantBidQuantity ?? 1);

  const ownBids = genericCollectionBids.filter(
    (bid) =>
      bid.ownerAddress === params.ownerAddress ||
      (params.ownBidState != null && bid.address === params.ownBidState)
  );

  const competingBids = genericCollectionBids.filter(
    (bid) =>
      bid.ownerAddress !== params.ownerAddress &&
      (params.ownBidState == null || bid.address !== params.ownBidState) &&
      !whitelistOwners.has(String(bid.ownerAddress ?? '').toLowerCase()) &&
      bid.quantity >= minRelevantBidQuantity
  );

  const ownTopBid =
    (params.ownBidState
      ? ownBids.find((bid) => bid.address === params.ownBidState)
      : null) ??
    ownBids.find((bid) => bid.quantity > 0) ??
    (ownBids.length ? ownBids[0] : null);
  const bestCompetingBid = competingBids.length ? competingBids[0] : null;

  return {
    bestAskLamports,
    bestCompetingBidLamports: bestCompetingBid ? toLamports(bestCompetingBid.amount) : null,
    competingBidLamports: competingBids.map((bid) => toLamports(bid.amount)),
    bestCompetingBidAddress: bestCompetingBid?.address ?? null,
    bestCompetingBidOwnerAddress: bestCompetingBid?.ownerAddress ?? null,
    bestCompetingBidQuantity: bestCompetingBid?.quantity ?? null,
    bestCompetingBidFilledQuantity: bestCompetingBid?.filledQuantity ?? null,
    ownBidLamports: ownTopBid ? toLamports(ownTopBid.amount) : null,
    ownBidAddress: ownTopBid?.address ?? null,
    ownBidQuantity: ownTopBid?.quantity ?? null,
    ownBidFilledQuantity: ownTopBid?.filledQuantity ?? null,
    ownBidSolBalanceLamports: ownTopBid?.solBalance != null ? toLamports(ownTopBid.solBalance) : null,
    ownBidMarginNr: ownTopBid?.marginNr ?? null,
    ownBidMargin: ownTopBid?.margin ?? null,
    royaltyFeeBps: listingData.royaltyFeeBps,
    listings,
    genericCollectionBids,
    ownBids
  };
}

export async function fetchTensorMarginAccounts(ownerAddress: string): Promise<TensorMarginAccount[]> {
  const json = await tensorPost<{
    data?: {
      tswapMarginAccounts?: TensorMarginAccount[];
    };
  }>({
    operationName: 'TswapMarginAccounts',
    variables: {
      owner: ownerAddress
    },
    query: TSWAP_MARGIN_ACCOUNTS_QUERY
  });

  return json?.data?.tswapMarginAccounts ?? [];
}

export async function buildTensorTcompBidTx(params: {
  ownerAddress: string;
  slugUuid: string;
  priceLamports: number;
  quantity: number;
  marginNr: number;
  attributes: CrewAttributeFilter[];
  blockhash: string;
  priorityMicroLamports?: number;
}): Promise<TensorTcompBidTxResult> {
  const json = await tensorPost<{
    data?: {
      tcompBidTx?: TensorTcompBidTxResult;
    };
  }>({
    operationName: 'TcompBidTx',
    variables: {
      quantity: params.quantity,
      price: String(params.priceLamports),
      owner: params.ownerAddress,
      slug: params.slugUuid,
      marginNr: params.marginNr,
      attributes: params.attributes,
      priorityMicroLamports: params.priorityMicroLamports ?? 50_000,
      blockhash: params.blockhash
    },
    query: TCOMP_BID_TX_QUERY
  });

  const result = json?.data?.tcompBidTx;
  if (!result?.txs?.length) {
    throw new Error('Tensor did not return a bid transaction');
  }

  return result;
}

export function computeTargetCrewBidLamports(input: {
  bestCompetingBidLamports: number | null;
  competingBidLamports?: number[];
  minBidLamports: number;
  maxBidLamports: number;
  bidStepLamports: number;
  bestAskLamports: number | null;
  minSpreadLamports?: number;
}): number {
  const minSpreadLamports = input.minSpreadLamports ?? 10_000;
  const competingBidLamports = input.competingBidLamports?.length
    ? input.competingBidLamports
    : input.bestCompetingBidLamports != null
      ? [input.bestCompetingBidLamports]
      : [];
  const bestReachableCompetingBidLamports =
    competingBidLamports
      .filter((amount) => amount < input.maxBidLamports)
      .sort((a, b) => b - a)[0] ?? null;
  const anchor =
    bestReachableCompetingBidLamports != null
      ? bestReachableCompetingBidLamports + input.bidStepLamports
      : input.minBidLamports;

  let target = Math.max(input.minBidLamports, Math.min(input.maxBidLamports, anchor));

  if (input.bestAskLamports != null) {
    target = Math.min(target, input.bestAskLamports - minSpreadLamports);
  }

  return Math.max(input.minBidLamports, target);
}
