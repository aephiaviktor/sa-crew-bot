"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAR_ATLAS_CREW_TARGET_ID = exports.STAR_ATLAS_CREW_COLLECTION_UUID = exports.TENSOR_TAKER_FEE_BPS = void 0;
exports.fetchCrewListings = fetchCrewListings;
exports.attributesExactlyMatch = attributesExactlyMatch;
exports.attributesIncludeAll = attributesIncludeAll;
exports.formatAttributesLabel = formatAttributesLabel;
exports.fetchCrewTcompBids = fetchCrewTcompBids;
exports.isGenericCrewCollectionBid = isGenericCrewCollectionBid;
exports.isMatchingCrewCollectionBid = isMatchingCrewCollectionBid;
exports.toLamports = toLamports;
exports.sortBidsDescByAmount = sortBidsDescByAmount;
exports.sortListingsAscByPrice = sortListingsAscByPrice;
exports.applyTensorTakerFeesLamports = applyTensorTakerFeesLamports;
exports.fetchCrewMarketSnapshot = fetchCrewMarketSnapshot;
exports.computeTargetCrewBidLamports = computeTargetCrewBidLamports;
const TENSOR_GRAPHQL_URL = 'https://graphql.tensor.trade/graphql';
exports.TENSOR_TAKER_FEE_BPS = 200;
exports.STAR_ATLAS_CREW_COLLECTION_UUID = '42c0b80a-5945-4a18-84d3-467af9ccb9a2';
exports.STAR_ATLAS_CREW_TARGET_ID = '13oBYyDzdGJxMJPdzRjmCBALL5akjJkarK1C43SUt2Ep';
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
async function tensorPost(body) {
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
    return (await response.json());
}
async function fetchCrewListings(slugUuid = exports.STAR_ATLAS_CREW_COLLECTION_UUID) {
    const json = await tensorPost([
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
    const royaltyFeeBps = prices.find((p) => typeof p?.tx?.mint?.sellRoyaltyFeeBPS === 'number')?.tx?.mint
        ?.sellRoyaltyFeeBPS ?? null;
    return { prices, royaltyFeeBps };
}
function normalizeAttributeValue(value) {
    return String(value || '').trim().toLowerCase();
}
function normalizeAttributeKey(value) {
    return String(value || '').trim().toLowerCase();
}
function attributesExactlyMatch(actual, expected) {
    const actualList = Array.isArray(actual) ? actual : [];
    if (actualList.length !== expected.length) {
        return false;
    }
    return expected.every((expectedAttribute) => actualList.some((actualAttribute) => normalizeAttributeKey(actualAttribute.trait_type) === normalizeAttributeKey(expectedAttribute.trait_type) &&
        normalizeAttributeValue(actualAttribute.value) === normalizeAttributeValue(expectedAttribute.value)));
}
function attributesIncludeAll(actual, expected) {
    if (!expected.length) {
        return true;
    }
    const actualList = Array.isArray(actual) ? actual : [];
    return expected.every((expectedAttribute) => actualList.some((actualAttribute) => normalizeAttributeKey(actualAttribute.trait_type) === normalizeAttributeKey(expectedAttribute.trait_type) &&
        normalizeAttributeValue(actualAttribute.value) === normalizeAttributeValue(expectedAttribute.value)));
}
function cleanAttributes(attributes) {
    return (Array.isArray(attributes) ? attributes : [])
        .map((attribute) => ({
        trait_type: String(attribute.trait_type || '').trim(),
        value: String(attribute.value || '').trim()
    }))
        .filter((attribute) => attribute.trait_type && attribute.value);
}
function formatAttributesLabel(attributes) {
    const cleaned = cleanAttributes(attributes);
    if (!cleaned.length) {
        return 'No traits -> floor';
    }
    return cleaned.map((attribute) => `${attribute.trait_type}: ${attribute.value}`).join(', ');
}
async function fetchCrewTcompBids(slugUuid = exports.STAR_ATLAS_CREW_COLLECTION_UUID, owner) {
    const json = await tensorPost([
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
function isGenericCrewCollectionBid(bid, targetId = exports.STAR_ATLAS_CREW_TARGET_ID) {
    return (bid.target === 'WHITELIST' &&
        bid.targetId === targetId &&
        bid.field == null &&
        bid.fieldId == null &&
        (!bid.attributes || bid.attributes.length === 0));
}
function isMatchingCrewCollectionBid(bid, targetId = exports.STAR_ATLAS_CREW_TARGET_ID, attributes = []) {
    return (bid.target === 'WHITELIST' &&
        bid.targetId === targetId &&
        bid.field == null &&
        bid.fieldId == null &&
        attributesExactlyMatch(bid.attributes, attributes));
}
function toLamports(value) {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}
function sortBidsDescByAmount(a, b) {
    return toLamports(b.amount) - toLamports(a.amount);
}
function sortListingsAscByPrice(a, b) {
    return toLamports(a.price) - toLamports(b.price);
}
function applyTensorTakerFeesLamports(amountLamports, royaltyFeeBps) {
    const totalBps = 10_000 + exports.TENSOR_TAKER_FEE_BPS + Math.max(0, royaltyFeeBps ?? 0);
    return Math.ceil((amountLamports * totalBps) / 10_000);
}
async function fetchCrewMarketSnapshot(params) {
    const slugUuid = params.slugUuid ?? exports.STAR_ATLAS_CREW_COLLECTION_UUID;
    const targetId = params.targetId ?? exports.STAR_ATLAS_CREW_TARGET_ID;
    const [listingData, bids] = await Promise.all([fetchCrewListings(slugUuid), fetchCrewTcompBids(slugUuid, null)]);
    const whitelistOwners = new Set((params.whitelistOwners ?? []).map((owner) => owner.toLowerCase()));
    const ownBidState = params.ownBidState?.trim() || null;
    const allCollectionBids = bids.filter((bid) => bid.target === 'WHITELIST' && bid.targetId === targetId && bid.field == null && bid.fieldId == null);
    const ownBidCandidates = ownBidState
        ? allCollectionBids.filter((bid) => bid.address === ownBidState)
        : allCollectionBids.filter((bid) => bid.ownerAddress === params.ownerAddress);
    const detectedOwnBid = (ownBidState
        ? ownBidCandidates.find((bid) => bid.address === ownBidState)
        : null) ??
        ownBidCandidates.find((bid) => bid.quantity > 0) ??
        (ownBidCandidates.length ? ownBidCandidates[0] : null);
    const attributes = cleanAttributes(detectedOwnBid?.attributes);
    const listings = [...listingData.prices]
        .filter((listing) => attributesIncludeAll(listing.tx?.mint?.attributes, attributes))
        .filter((listing) => !whitelistOwners.has(String(listing.owner ?? '').toLowerCase()))
        .sort(sortListingsAscByPrice);
    const bestAskLamports = listings.length
        ? applyTensorTakerFeesLamports(toLamports(listings[0].price), listingData.royaltyFeeBps)
        : null;
    const genericCollectionBids = bids.filter((bid) => isMatchingCrewCollectionBid(bid, targetId, attributes)).sort(sortBidsDescByAmount);
    const minRelevantBidQuantity = Math.max(1, params.minRelevantBidQuantity ?? 1);
    const ownBids = genericCollectionBids.filter((bid) => (ownBidState ? bid.address === ownBidState : bid.ownerAddress === params.ownerAddress));
    const competingBids = genericCollectionBids.filter((bid) => bid.ownerAddress !== params.ownerAddress &&
        (ownBidState == null || bid.address !== ownBidState) &&
        !whitelistOwners.has(String(bid.ownerAddress ?? '').toLowerCase()) &&
        bid.quantity >= minRelevantBidQuantity);
    const ownTopBid = (ownBidState
        ? ownBids.find((bid) => bid.address === ownBidState)
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
        ownBidAttributes: cleanAttributes(ownTopBid?.attributes),
        activeAttributes: attributes,
        royaltyFeeBps: listingData.royaltyFeeBps,
        listings,
        genericCollectionBids,
        ownBids
    };
}
function computeTargetCrewBidLamports(input) {
    const minSpreadLamports = input.minSpreadLamports ?? 10_000;
    const competingBidLamports = input.competingBidLamports?.length
        ? input.competingBidLamports
        : input.bestCompetingBidLamports != null
            ? [input.bestCompetingBidLamports]
            : [];
    const minimum = input.minBidLamports ?? input.bidStepLamports;
    const maximum = input.maxBidLamports ?? Number.POSITIVE_INFINITY;
    const bestReachableCompetingBidLamports = competingBidLamports
        .filter((amount) => amount < maximum)
        .sort((a, b) => b - a)[0] ?? null;
    const anchor = bestReachableCompetingBidLamports != null
        ? bestReachableCompetingBidLamports + input.bidStepLamports
        : minimum;
    let target = Math.max(minimum, Math.min(maximum, anchor));
    if (input.bestAskLamports != null) {
        target = Math.min(target, input.bestAskLamports - minSpreadLamports);
    }
    return Math.max(minimum, target);
}
