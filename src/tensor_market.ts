const TENSOR_GRAPHQL_URL = 'https://graphql.tensor.trade/graphql';
const TENSOR_TAKER_FEE_BPS = 200;

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

function applyTakerFeesToListingLamports(listingLamports: number, royaltyFeeBps: number | null): number {
  const totalBps = 10_000 + TENSOR_TAKER_FEE_BPS + Math.max(0, royaltyFeeBps ?? 0);
  return Math.ceil((listingLamports * totalBps) / 10_000);
}

export async function fetchCrewMarketSnapshot(params: {
  ownerAddress: string;
  ownBidState?: string | null;
  slugUuid?: string;
  targetId?: string;
  minRelevantBidQuantity?: number;
  whitelistOwners?: string[];
}): Promise<CrewMarketSnapshot> {
  const slugUuid = params.slugUuid ?? STAR_ATLAS_CREW_COLLECTION_UUID;
  const targetId = params.targetId ?? STAR_ATLAS_CREW_TARGET_ID;
  const [listingData, bids] = await Promise.all([fetchCrewListings(slugUuid), fetchCrewTcompBids(slugUuid, null)]);
  const whitelistOwners = new Set((params.whitelistOwners ?? []).map((owner) => owner.toLowerCase()));

  const listings = [...listingData.prices]
    .filter((listing) => !whitelistOwners.has(String(listing.owner ?? '').toLowerCase()))
    .sort(sortListingsAscByPrice);
  const bestAskLamports = listings.length
    ? applyTakerFeesToListingLamports(toLamports(listings[0].price), listingData.royaltyFeeBps)
    : null;

  const genericCollectionBids = bids.filter((bid) => isGenericCrewCollectionBid(bid, targetId)).sort(sortBidsDescByAmount);
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

export function computeTargetCrewBidLamports(input: {
  bestCompetingBidLamports: number | null;
  minBidLamports: number;
  maxBidLamports: number;
  bidStepLamports: number;
  bestAskLamports: number | null;
  minSpreadLamports?: number;
}): number {
  const minSpreadLamports = input.minSpreadLamports ?? 10_000;
  const anchor =
    input.bestCompetingBidLamports != null
      ? input.bestCompetingBidLamports + input.bidStepLamports
      : input.minBidLamports;

  let target = Math.max(input.minBidLamports, Math.min(input.maxBidLamports, anchor));

  if (input.bestAskLamports != null) {
    target = Math.min(target, input.bestAskLamports - minSpreadLamports);
  }

  return Math.max(input.minBidLamports, target);
}
