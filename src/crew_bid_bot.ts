import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, Signer } from '@solana/web3.js';
import { TCompSDK, Target } from '@tensor-oss/tcomp-sdk';
import {
  type CrewMarketSnapshot,
  applyTensorTakerFeesLamports,
  computeTargetCrewBidLamports,
  fetchCrewMarketSnapshot,
  STAR_ATLAS_CREW_TARGET_ID
} from './tensor_market';

const TENSOR_CNFT_PROGRAM_ID = new PublicKey('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const RECENT_ACTIVITY_LIMIT = 8;
const CHECK_INTERVAL_MINUTES_TIERS = [5, 10, 20, 30, 60] as const;

export type CrewBidBotConfig = {
  rpcUrl: string;
  hotWalletSecret: string;

  side: 'buy' | 'sell';
  collectionSlugUuid: string;
  targetId: string;
  makerBroker: string;

  bidState: string;
  bidId: string;
  marginAccount: string;

  quantity: number;

  minBidSol: number;
  maxBidSol: number;
  bidStepSol: number;
  checkIntervalMinutes: number;
  whitelist?: string;
};

export type CrewBidBotLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type CrewBidBotOpenOrder = {
  label: string;
  side: 'buy' | 'sell';
  priceLamports: number | null;
  quantity: number | null;
  remaining: number | null;
  bidState: string | null;
  bidId: string | null;
  marginAccount: string | null;
  marketLeader?: 'bb';
};

export type CrewBidBotActivity = {
  timestamp: string;
  event: string;
  title: string;
  message: string;
};

export type CrewBidBotStatus = {
  running: boolean;
  wallet: string;
  bidState: string;
  bidId: string;
  marginAccount: string;

  currentBidLamports: number | null;
  bestCompetingBidLamports: number | null;
  bestAskLamports: number | null;
  targetBidLamports: number | null;

  lastCheckAt: string | null;
  lastAction: string | null;
  lastUpdatedAt: string | null;

  startedAt: string | null;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  checkIntervalMinutes: number;
  solBalance: number | null;
  marginAccountSolBalance: number | null;
  openOrders: CrewBidBotOpenOrder[];
  recentActivity: CrewBidBotActivity[];
};

const defaultLogger: CrewBidBotLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

type CrewMarketState = {
  currentBidLamports: number | null;
  bestCompetingBidLamports: number | null;
  bestCompetingBidAddress: string | null;
  bestCompetingBidOwnerAddress: string | null;
  bestCompetingBidQuantity: number | null;
  bestCompetingBidFilledQuantity: number | null;
  bestAskLamports: number | null;
  royaltyFeeBps: number | null;
  targetBidLamports: number | null;
  ownBidQuantity: number | null;
  ownBidFilledQuantity: number | null;
  ownBidSolBalanceLamports: number | null;
  ownBidMarginNr: number | null;
  ownBidAddress: string | null;
  ownBidMargin: string | null;
  marginAccountSolBalance: number | null;
  lastCheckAt: string | null;
  lastAction: string | null;
  lastUpdatedAt: string | null;
  solBalance: number | null;
};

function decodeSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('HOT_WALLET_SECRET JSON value must be an array');
    }
    return Uint8Array.from(parsed);
  }

  const hexLike = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]+$/.test(hexLike)) {
    if (hexLike.length % 2 !== 0) {
      throw new Error('HOT_WALLET_SECRET hex value must have an even length');
    }
    return Uint8Array.from(Buffer.from(hexLike, 'hex'));
  }

  return bs58.decode(trimmed);
}

function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}

function lamportsToSol(lamports: number | null): number | null {
  return lamports == null ? null : lamports / 1_000_000_000;
}

function publicKeyFromString(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function optionalPublicKeyFromString(value: string | null | undefined): PublicKey | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? new PublicKey(trimmed) : null;
}

function sameLamports(a: number | null, b: number | null): boolean {
  return a === b;
}

function normalizeCheckIntervalMinutes(value: number | null | undefined): number {
  const numeric = Number(value);
  const maxTier = CHECK_INTERVAL_MINUTES_TIERS[CHECK_INTERVAL_MINUTES_TIERS.length - 1];
  const bounded = Number.isFinite(numeric)
    ? Math.max(CHECK_INTERVAL_MINUTES_TIERS[0], Math.min(maxTier, numeric))
    : 30;

  let nearest: number = CHECK_INTERVAL_MINUTES_TIERS[0];
  let nearestDistance = Math.abs(nearest - bounded);

  for (const tier of CHECK_INTERVAL_MINUTES_TIERS) {
    const distance = Math.abs(tier - bounded);
    if (distance < nearestDistance || (distance === nearestDistance && tier > nearest)) {
      nearest = tier;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function stepCheckIntervalMinutes(current: number, direction: 'shorter' | 'longer'): number {
  const normalized = normalizeCheckIntervalMinutes(current);
  const index = CHECK_INTERVAL_MINUTES_TIERS.indexOf(normalized as (typeof CHECK_INTERVAL_MINUTES_TIERS)[number]);
  if (index === -1) {
    return 30;
  }

  if (direction === 'shorter') {
    return CHECK_INTERVAL_MINUTES_TIERS[Math.max(0, index - 1)];
  }

  return CHECK_INTERVAL_MINUTES_TIERS[Math.min(CHECK_INTERVAL_MINUTES_TIERS.length - 1, index + 1)];
}

function buildBestCompetingBidSignature(snapshot: CrewMarketState): string | null {
  const address = String(snapshot.bestCompetingBidAddress ?? '').trim();
  const ownerAddress = String(snapshot.bestCompetingBidOwnerAddress ?? '').trim();
  const quantity = snapshot.bestCompetingBidQuantity ?? '';
  const filledQuantity = snapshot.bestCompetingBidFilledQuantity ?? '';
  const amount = snapshot.bestCompetingBidLamports ?? '';

  if (!address && !ownerAddress && quantity === '' && filledQuantity === '' && amount === '') {
    return null;
  }

  return [address, ownerAddress, quantity, filledQuantity, amount].join('|');
}

export class CrewBidBot {
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly tcompSdk: TCompSDK;
  private readonly whitelistOwners: Set<string>;

  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private cycleInProgress = false;
  private resyncAfterCurrentCycle = false;
  private startedAt: string | null = null;
  private lastCycleStartedAt: string | null = null;
  private lastCycleCompletedAt: string | null = null;
  private lastCycleDurationMs: number | null = null;
  private recentActivity: CrewBidBotActivity[] = [];
  private solBalanceCache: number | null = null;
  private marginAlertLevel: 'ok' | 'low' | 'empty' = 'ok';
  private pendingMissingBidWarning: string | null = null;
  private currentCheckIntervalMinutes: number;
  private previousBestCompetingBidSignature: string | null = null;
  private hasBestCompetingBidBaseline = false;

  private state: CrewMarketState = {
    currentBidLamports: null,
    bestCompetingBidLamports: null,
    bestCompetingBidAddress: null,
    bestCompetingBidOwnerAddress: null,
    bestCompetingBidQuantity: null,
    bestCompetingBidFilledQuantity: null,
    bestAskLamports: null,
    royaltyFeeBps: null,
    targetBidLamports: null,
    ownBidQuantity: null,
    ownBidFilledQuantity: null,
    ownBidSolBalanceLamports: null,
    ownBidMarginNr: null,
    ownBidAddress: null,
    ownBidMargin: null,
    marginAccountSolBalance: null,
    lastCheckAt: null,
    lastAction: null,
    lastUpdatedAt: null,
    solBalance: null
  };

  constructor(
    private config: CrewBidBotConfig,
    private readonly logger: CrewBidBotLogger = defaultLogger
  ) {
    const secretKeyBytes = decodeSecret(config.hotWalletSecret);
    this.wallet =
      secretKeyBytes.length === 32
        ? Keypair.fromSeed(secretKeyBytes)
        : Keypair.fromSecretKey(secretKeyBytes);

    this.connection = new Connection(config.rpcUrl, { commitment: 'confirmed' });

    const provider = new AnchorProvider(
      this.connection,
      new Wallet(this.wallet),
      AnchorProvider.defaultOptions()
    );

    this.tcompSdk = new TCompSDK({ provider });
    this.whitelistOwners = new Set(
      String(config.whitelist ?? '')
        .split(/[\n,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );

    if (config.side !== 'buy') {
      throw new Error(`Unsupported side: ${config.side}. Only buy is currently implemented.`);
    }

    if (config.targetId !== STAR_ATLAS_CREW_TARGET_ID) {
      this.logger.warn(
        `Configured targetId ${config.targetId} does not match expected Star Atlas Crew target ${STAR_ATLAS_CREW_TARGET_ID}`
      );
    }
    this.currentCheckIntervalMinutes = normalizeCheckIntervalMinutes(config.checkIntervalMinutes);
  }

  isRunning(): boolean {
    return this.running;
  }

  async getStatus(): Promise<CrewBidBotStatus> {
    if (this.running) {
      await this.refreshMarket();
    }

    return {
      running: this.running,
      wallet: this.wallet.publicKey.toBase58(),
      bidState: this.config.bidState,
      bidId: this.config.bidId,
      marginAccount: this.config.marginAccount,
      currentBidLamports: this.state.currentBidLamports,
      bestCompetingBidLamports: this.state.bestCompetingBidLamports,
      bestAskLamports: this.state.bestAskLamports,
      targetBidLamports: this.state.targetBidLamports,
      lastCheckAt: this.state.lastCheckAt,
      lastAction: this.state.lastAction,
      lastUpdatedAt: this.state.lastUpdatedAt,
      startedAt: this.startedAt,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      lastCycleDurationMs: this.lastCycleDurationMs,
      checkIntervalMinutes: this.currentCheckIntervalMinutes,
      solBalance: this.state.solBalance,
      marginAccountSolBalance: this.state.marginAccountSolBalance,
      openOrders: this.buildOpenOrdersSnapshot(),
      recentActivity: [...this.recentActivity]
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastCycleStartedAt = null;
    this.lastCycleCompletedAt = null;
    this.lastCycleDurationMs = null;
    this.pushActivity('START', `Bot started for wallet ${this.wallet.publicKey.toBase58()}`);
    this.logger.info(`CrewBidBot started for wallet ${this.wallet.publicKey.toBase58()}`);
    await this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.pushActivity('STOP', 'Bot stopped');
    this.logger.info('CrewBidBot stopped');
  }

  applyConfigUpdates(nextConfig: CrewBidBotConfig): void {
    this.config = nextConfig;
    this.currentCheckIntervalMinutes = normalizeCheckIntervalMinutes(nextConfig.checkIntervalMinutes);
    this.previousBestCompetingBidSignature = null;
    this.hasBestCompetingBidBaseline = false;
  }

  async runImmediateCycle(): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    if (this.cycleInProgress) {
      this.resyncAfterCurrentCycle = true;
      return;
    }

    await this.loop();
  }

  private async getSolBalance(options?: { refresh?: boolean }): Promise<number> {
    if (!options?.refresh && this.solBalanceCache != null) {
      return this.solBalanceCache;
    }

    const solLamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
    this.solBalanceCache = solLamports / 1_000_000_000;
    return this.solBalanceCache;
  }

  async refreshMarket(): Promise<void> {
    const previousBidLamports = this.state.currentBidLamports;
    const previousBidAddress = this.state.ownBidAddress;
    const previousBidQuantity = this.state.ownBidQuantity;
    const previousBidFilledQuantity = this.state.ownBidFilledQuantity ?? 0;

    const marginAccountPk = publicKeyFromString(this.config.marginAccount, 'marginAccount');

    const [snapshot, solBalance, marginSolLamports] = await Promise.all([
      fetchCrewMarketSnapshot({
        ownerAddress: this.wallet.publicKey.toBase58(),
        ownBidState: this.config.bidState,
        slugUuid: this.config.collectionSlugUuid,
        targetId: this.config.targetId,
        minRelevantBidQuantity: this.config.quantity,
        whitelistOwners: Array.from(this.whitelistOwners)
      }),
      this.getSolBalance(),
      this.connection.getBalance(marginAccountPk, 'confirmed').catch(() => 0)
    ]);

    this.state.currentBidLamports = snapshot.ownBidLamports;
    this.state.bestCompetingBidLamports = snapshot.bestCompetingBidLamports;
    this.state.bestCompetingBidAddress = snapshot.bestCompetingBidAddress;
    this.state.bestCompetingBidOwnerAddress = snapshot.bestCompetingBidOwnerAddress;
    this.state.bestCompetingBidQuantity = snapshot.bestCompetingBidQuantity;
    this.state.bestCompetingBidFilledQuantity = snapshot.bestCompetingBidFilledQuantity;
    this.state.bestAskLamports = snapshot.bestAskLamports;
    this.state.royaltyFeeBps = snapshot.royaltyFeeBps;
    this.state.ownBidQuantity = snapshot.ownBidQuantity;
    this.state.ownBidFilledQuantity = snapshot.ownBidFilledQuantity;
    this.state.ownBidSolBalanceLamports = snapshot.ownBidSolBalanceLamports;
    this.state.ownBidMarginNr = snapshot.ownBidMarginNr;
    this.state.ownBidAddress = snapshot.ownBidAddress;
    this.state.ownBidMargin = snapshot.ownBidMargin;
    this.state.lastCheckAt = new Date().toISOString();
    this.state.solBalance = solBalance;
    this.state.marginAccountSolBalance = marginSolLamports / 1_000_000_000;

    const currentFilledQuantity = snapshot.ownBidFilledQuantity ?? 0;
    const isSameTrackedBid =
      previousBidLamports != null &&
      previousBidAddress != null &&
      snapshot.ownBidAddress != null &&
      previousBidAddress === snapshot.ownBidAddress;

    if (isSameTrackedBid && currentFilledQuantity > previousBidFilledQuantity) {
      const deltaFilled = currentFilledQuantity - previousBidFilledQuantity;
      const totalQty = snapshot.ownBidQuantity ?? previousBidQuantity ?? this.config.quantity;
      const remaining = Math.max(0, totalQty - currentFilledQuantity);
      this.pushActivity(
        'FILLED',
        `Filled +${deltaFilled} (filled ${currentFilledQuantity}/${totalQty}, remaining ${remaining}).`
      );
    }

    if (previousBidLamports != null && snapshot.ownBidLamports == null) {
      const totalQty = previousBidQuantity ?? this.config.quantity;
      const filled = previousBidFilledQuantity;
      const fullyFilled = filled >= totalQty;

      if (fullyFilled) {
        this.pushActivity(
          'FILLED',
          `Bid ${previousBidAddress ?? this.config.bidId} is no longer open on the market (filled ${filled}/${totalQty}).`
        );
        await this.rotateBidIdentity('previous bid fully filled/closed');
      } else {
        this.pendingMissingBidWarning =
          `Bid ${previousBidAddress ?? this.config.bidId} disappeared without full fill (${filled}/${totalQty}); keeping bid identity.`;
      }
    }

    this.evaluateMarginAlerts();
  }

  private computeFundableQtyForPrice(priceLamports: number | null): number | null {
    if (priceLamports == null || priceLamports <= 0) {
      return null;
    }

    const requiredLamports = this.computeTensorBidSpendLamports(priceLamports);

    if (this.state.ownBidSolBalanceLamports != null) {
      return Math.max(0, Math.floor(this.state.ownBidSolBalanceLamports / requiredLamports));
    }

    if (this.state.marginAccountSolBalance != null) {
      return Math.max(0, Math.floor((this.state.marginAccountSolBalance * 1_000_000_000) / requiredLamports));
    }

    return null;
  }

  private computeTensorBidSpendLamports(limitBidLamports: number): number {
    return applyTensorTakerFeesLamports(limitBidLamports, this.state.royaltyFeeBps);
  }

  private evaluateMarginAlerts() {
    const totalQty = this.state.ownBidQuantity ?? this.config.quantity;

    if (totalQty <= 0) {
      this.marginAlertLevel = 'ok';
      return;
    }

    const hasLiveOpenBid = this.state.currentBidLamports != null && (this.state.ownBidQuantity ?? 0) > 0;
    const fundable = this.computeFundableQtyForPrice(this.state.currentBidLamports);
    if (fundable == null) {
      this.marginAlertLevel = 'ok';
      return;
    }

    const nextLevel: 'ok' | 'low' | 'empty' = hasLiveOpenBid ? 'ok' : fundable <= 0 ? 'empty' : fundable < totalQty ? 'low' : 'ok';

    if (nextLevel === this.marginAlertLevel) {
      return;
    }

    if (nextLevel === 'low') {
      this.pushActivity('MARGIN_LOW', `Margin can fund ${fundable}/${totalQty}.`);
    } else if (nextLevel === 'empty') {
      this.pushActivity('MARGIN_EMPTY', `Margin can fund 0/${totalQty}. No order capacity.`);
    }

    this.marginAlertLevel = nextLevel;
  }

  computeTargetBid(): number {
    const target = computeTargetCrewBidLamports({
      bestCompetingBidLamports: this.state.bestCompetingBidLamports,
      minBidLamports: solToLamports(this.config.minBidSol),
      maxBidLamports: solToLamports(this.config.maxBidSol),
      bidStepLamports: solToLamports(this.config.bidStepSol),
      bestAskLamports: this.state.bestAskLamports
    });

    this.state.targetBidLamports = target;
    return target;
  }

  shouldCancelInsteadOfBid(): boolean {
    const target = this.state.targetBidLamports;

    if (target == null) {
      return false;
    }

    return target < solToLamports(this.config.minBidSol);
  }

  async updateBidIfNeeded(): Promise<boolean> {
    const current = this.state.currentBidLamports;
    const target = this.state.targetBidLamports;

    if (target == null) {
      throw new Error('Target bid is not computed');
    }

    if (this.shouldCancelInsteadOfBid()) {
      return this.cancelBid();
    }

    const hasLiveOpenBid = this.state.currentBidLamports != null && (this.state.ownBidQuantity ?? 0) > 0;
    const fundableQty = this.computeFundableQtyForPrice(target);
    if (!hasLiveOpenBid && fundableQty !== null && fundableQty <= 0) {
      this.state.lastAction = 'Skipped bid update: margin capacity is zero';
      if (this.marginAlertLevel !== 'empty') {
        this.pushActivity('MARGIN_EMPTY', 'Skipped bid update because margin capacity is zero.');
      }
      return false;
    }

    if (sameLamports(current, target)) {
      this.state.lastAction = `No change needed (${lamportsToSol(target)} SOL)`;
      return false;
    }

    await this.sendBidUpdate(target);

    this.state.currentBidLamports = target;
    this.state.lastAction = `Updated bid from ${lamportsToSol(current)} to ${lamportsToSol(target)} SOL`;
    this.state.lastUpdatedAt = new Date().toISOString();
    this.pushActivity('BID_UPDATED', this.state.lastAction);

    return true;
  }

  async cancelBidNow(): Promise<boolean> {
    return this.cancelBid();
  }

  private buildOpenOrdersSnapshot(): CrewBidBotOpenOrder[] {
    if (this.state.currentBidLamports == null) {
      return [];
    }

    const quantity = this.state.ownBidQuantity ?? this.config.quantity ?? null;
    const remainingByFunding = this.computeFundableQtyForPrice(this.state.currentBidLamports);

    const remainingCandidates = [
      typeof quantity === 'number' ? Math.max(0, Math.floor(quantity)) : null,
      remainingByFunding
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    const remaining = remainingCandidates.length > 0 ? Math.max(0, Math.min(...remainingCandidates)) : quantity;

    const isBestBid =
      this.config.side === 'buy' &&
      this.state.currentBidLamports != null &&
      (this.state.bestCompetingBidLamports == null || this.state.currentBidLamports >= this.state.bestCompetingBidLamports);

    return [
      {
        label: 'Star Atlas Crew',
        side: this.config.side,
        priceLamports: this.state.currentBidLamports,
        quantity,
        remaining,
        bidState: this.state.ownBidAddress ?? this.config.bidState,
        bidId: this.config.bidId,
        marginAccount: this.state.ownBidMargin ?? this.config.marginAccount,
        marketLeader: isBestBid ? 'bb' : undefined
      }
    ];
  }

  private pushActivity(event: string, message: string) {
    this.recentActivity.unshift({
      timestamp: new Date().toISOString(),
      event,
      title: this.formatActivityTitle(event),
      message
    });
    this.recentActivity = this.recentActivity.slice(0, RECENT_ACTIVITY_LIMIT);
  }

  private formatActivityTitle(event: string): string {
    switch (event) {
      case 'START':
        return 'Bot Start';
      case 'STOP':
        return 'Bot Stop';
      case 'BID_UPDATED':
        return 'Bid Updated';
      case 'BID_CANCELLED':
        return 'Bid Cancelled';
      case 'BID_ID_ROTATED':
        return 'Bid Identity Rotated';
      case 'BID_CLOSE_OLD':
        return 'Old Bid Closed';
      case 'BID_CLOSE_OLD_FAILED':
        return 'Old Bid Close Failed';
      case 'FILLED':
        return 'Bid Filled';
      case 'MARGIN_LOW':
        return 'Margin Warning';
      case 'MARGIN_EMPTY':
        return 'Margin Critical';
      case 'CYCLE_OK':
        return 'Cycle Complete';
      case 'CYCLE_ERROR':
        return 'Cycle Error';
      default:
        return event.replace(/_/g, ' ');
    }
  }

  private async closeOldBidBestEffort(reason: string) {
    const oldBidId = this.config.bidId;
    if (!oldBidId) {
      return;
    }

    try {
      const bidId = publicKeyFromString(oldBidId, 'bidId');
      const ownerPk = this.wallet.publicKey;

      const {
        tx: { ixs, extraSigners = [] }
      } = await this.tcompSdk.cancelBid({
        bidId,
        owner: ownerPk,
        rentDest: ownerPk
      });

      const sig = await this.signAndSendInstructions(ixs, extraSigners);
      const message = `Closed old bid ${oldBidId} before rotation (${reason}) [${sig}]`;
      this.logger.info(message);
      this.pushActivity('BID_CLOSE_OLD', message);
    } catch (err) {
      const message = `Old bid close skipped/failed for ${oldBidId} (${reason}): ${(err as Error).message}`;
      this.logger.warn(message);
      this.pushActivity('BID_CLOSE_OLD_FAILED', message);
    }
  }

  private async rotateBidIdentity(reason: string) {
    const previousBidId = this.config.bidId;
    await this.closeOldBidBestEffort(reason);

    const nextBidId = Keypair.generate().publicKey.toBase58();
    this.config.bidId = nextBidId;
    this.config.bidState = '';
    this.state.ownBidAddress = null;
    this.state.ownBidSolBalanceLamports = null;
    this.state.ownBidMarginNr = null;

    const message = `Rotated bid identity (${reason}): ${previousBidId} -> ${nextBidId}`;
    this.logger.info(message);
    this.pushActivity('BID_ID_ROTATED', message);
  }

  private async signAndSendInstructions(
    ixs: TransactionInstruction[],
    extraSigners: Signer[] = []
  ): Promise<string> {
    const tx = new Transaction();
    tx.add(...ixs);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    tx.partialSign(this.wallet, ...(extraSigners as Keypair[]));

    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    return signature;
  }

  private async sendBidUpdate(limitBidLamports: number): Promise<void> {
    const ownerPk = this.wallet.publicKey;
    const amountLamports = this.computeTensorBidSpendLamports(limitBidLamports);

    const bidIdPk = publicKeyFromString(this.config.bidId, 'bidId');
    const targetIdPk = publicKeyFromString(this.config.targetId, 'targetId');
    const marginPk = publicKeyFromString(this.config.marginAccount, 'marginAccount');
    const makerBrokerPk = optionalPublicKeyFromString(this.config.makerBroker);

    this.logger.info(
      `Sending Tensor bid update: limit=${limitBidLamports} amount=${amountLamports} royaltyFeeBps=${this.state.royaltyFeeBps ?? 0} quantity=${this.config.quantity}`
    );

    const {
      tx: { ixs, extraSigners = [] },
      bidState
    } = await this.tcompSdk.bid({
      owner: ownerPk,
      amount: new BN(amountLamports),
      expireInSec: null,
      privateTaker: null,
      bidId: bidIdPk,
      targetId: targetIdPk,
      target: Target.Whitelist,
      quantity: this.config.quantity,
      margin: marginPk,
      field: null,
      fieldId: null,
      makerBroker: makerBrokerPk
    });

    const sig = await this.signAndSendInstructions(ixs, extraSigners);

    this.config.bidState = bidState.toBase58();
    this.state.ownBidAddress = this.config.bidState;
    this.state.ownBidFilledQuantity = 0;
    this.logger.info(`Tensor bid update confirmed: ${sig}`);
  }

  private async cancelBid(): Promise<boolean> {
    if (this.state.currentBidLamports == null) {
      this.state.lastAction = 'No active bid to cancel';
      return false;
    }

    const bidId = publicKeyFromString(this.config.bidId, 'bidId');
    const ownerPk = this.wallet.publicKey;

    this.logger.info(`Cancelling Tensor bid: bidId=${bidId.toBase58()}`);

    const {
      tx: { ixs, extraSigners = [] }
    } = await this.tcompSdk.cancelBid({
      bidId,
      owner: ownerPk,
      rentDest: ownerPk
    });

    const sig = await this.signAndSendInstructions(ixs, extraSigners);

    this.logger.info(`Tensor bid cancel confirmed: ${sig}`);

    this.state.currentBidLamports = null;
    this.state.targetBidLamports = null;
    this.state.ownBidQuantity = null;
    this.state.ownBidFilledQuantity = null;
    this.state.ownBidSolBalanceLamports = null;
    this.state.ownBidAddress = null;
    this.state.ownBidMargin = null;
    this.state.lastAction = `Cancelled bid ${bidId.toBase58()}`;
    this.state.lastUpdatedAt = new Date().toISOString();
    this.pushActivity('BID_CANCELLED', `${this.state.lastAction} (${sig})`);

    return true;
  }

  private async runCycleCore(): Promise<void> {
    this.cycleInProgress = true;
    this.solBalanceCache = null;
    this.pendingMissingBidWarning = null;

    const startedAt = Date.now();
    this.lastCycleStartedAt = new Date(startedAt).toISOString();

    try {
      await this.refreshMarket();
      this.computeTargetBid();
      const changed = await this.updateBidIfNeeded();
      if (changed) {
        await this.refreshMarket();
        this.computeTargetBid();
      }

      if (this.pendingMissingBidWarning) {
        if (this.state.currentBidLamports == null) {
          this.pushActivity('MARGIN_EMPTY', this.pendingMissingBidWarning);
        }
        this.pendingMissingBidWarning = null;
      }

      this.evaluateMarginAlerts();
      const currentBestCompetingSignature = buildBestCompetingBidSignature(this.state);
      if (!this.hasBestCompetingBidBaseline) {
        this.previousBestCompetingBidSignature = currentBestCompetingSignature;
        this.hasBestCompetingBidBaseline = true;
      } else {
        const changed = currentBestCompetingSignature !== this.previousBestCompetingBidSignature;
        this.currentCheckIntervalMinutes = changed
          ? stepCheckIntervalMinutes(this.currentCheckIntervalMinutes, 'shorter')
          : stepCheckIntervalMinutes(this.currentCheckIntervalMinutes, 'longer');
        this.previousBestCompetingBidSignature = currentBestCompetingSignature;
      }

      this.lastCycleCompletedAt = new Date().toISOString();
      this.lastCycleDurationMs = Date.now() - startedAt;
      this.pushActivity('CYCLE_OK', `Cycle finished in ${this.lastCycleDurationMs} ms`);
    } catch (err) {
      this.logger.error('CrewBidBot cycle failed:', err);
      this.state.lastAction = `ERROR: ${(err as Error).message}`;
      this.lastCycleCompletedAt = new Date().toISOString();
      this.lastCycleDurationMs = Date.now() - startedAt;
      this.pushActivity('CYCLE_ERROR', this.state.lastAction);
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async loop(): Promise<void> {
    if (!this.running) {
      return;
    }

    await this.runCycleCore();

    if (!this.running) {
      return;
    }

    if (this.resyncAfterCurrentCycle) {
      this.resyncAfterCurrentCycle = false;
      this.loopTimer = setTimeout(() => {
        void this.loop();
      }, 0);
      return;
    }

    const elapsedMs = this.lastCycleDurationMs ?? 0;
    const delayMs = Math.max(0, this.currentCheckIntervalMinutes * 60 * 1000 - elapsedMs);

    this.loopTimer = setTimeout(() => {
      void this.loop();
    }, delayMs);
  }
}

export { TENSOR_CNFT_PROGRAM_ID, SYSTEM_PROGRAM_ID };
