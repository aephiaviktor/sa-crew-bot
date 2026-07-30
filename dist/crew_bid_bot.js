"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_PROGRAM_ID = exports.CrewBidBot = void 0;
const buffer_1 = require("buffer");
const bs58_1 = __importDefault(require("bs58"));
const anchor_1 = require("@coral-xyz/anchor");
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const tcomp_sdk_1 = require("@tensor-oss/tcomp-sdk");
const rpc_limiter_1 = require("rpc_limiter");
const tensor_market_1 = require("./tensor_market");
const SYSTEM_PROGRAM_ID = new web3_js_1.PublicKey('11111111111111111111111111111111');
exports.SYSTEM_PROGRAM_ID = SYSTEM_PROGRAM_ID;
const RECENT_ACTIVITY_LIMIT = 8;
const CHECK_INTERVAL_MINUTES_TIERS = [5, 10, 20, 30, 60];
const RPC_LIMITER_SLOW_WAIT_LOG_MS = 100;
const RPC_LIMITER_WAIT_LOG_THROTTLE_MS = 60000;
const defaultLogger = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};
function getErrorText(error) {
    if (error instanceof Error) {
        return `${error.name} ${error.message}`.trim();
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
function isRpcRateLimitError(error) {
    const text = getErrorText(error).toLowerCase();
    return text.includes('429') || text.includes('too many requests') || text.includes('rate limit');
}
function decodeSecret(secret) {
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
        return Uint8Array.from(buffer_1.Buffer.from(hexLike, 'hex'));
    }
    return bs58_1.default.decode(trimmed);
}
function solToLamports(sol) {
    return Math.round(sol * 1_000_000_000);
}
function lamportsToSol(lamports) {
    return lamports == null ? null : lamports / 1_000_000_000;
}
function publicKeyFromString(value, label) {
    try {
        return new web3_js_1.PublicKey(value);
    }
    catch {
        throw new Error(`Invalid ${label}: ${value}`);
    }
}
function optionalPublicKeyFromString(value) {
    const trimmed = String(value ?? '').trim();
    return trimmed ? new web3_js_1.PublicKey(trimmed) : null;
}
function sameLamports(a, b) {
    return a === b;
}
class SharedRpcConnectionLimiter {
    logger;
    useSharedLimiter;
    metricsApp;
    metricsProfile;
    sharedLimiter = new rpc_limiter_1.RpcLimiter();
    lastSharedWaitLogAtMs = new Map();
    constructor(logger, useSharedLimiter, metricsApp, metricsProfile = 'default') {
        this.logger = logger;
        this.useSharedLimiter = useSharedLimiter;
        this.metricsApp = metricsApp;
        this.metricsProfile = metricsProfile;
    }
    async wait(label, bucketName = 'rpc:shared', method = label) {
        if (!this.useSharedLimiter()) {
            return;
        }
        const startedAt = Date.now();
        await this.sharedLimiter.wait(bucketName, {
            label,
            metrics: {
                app: this.metricsApp,
                profile: this.metricsProfile,
                method
            }
        });
        const waitMs = Date.now() - startedAt;
        const logKey = `${bucketName}:${label}`;
        const lastLoggedAt = this.lastSharedWaitLogAtMs.get(logKey) ?? 0;
        const now = Date.now();
        if (waitMs > RPC_LIMITER_SLOW_WAIT_LOG_MS && now - lastLoggedAt >= RPC_LIMITER_WAIT_LOG_THROTTLE_MS) {
            const prefix = bucketName === 'tx:shared' ? 'TX limiter' : 'RPC limiter';
            this.logger.info(`${prefix} waiting for ${label}.`);
            this.lastSharedWaitLogAtMs.set(logKey, now);
        }
    }
    /**
     * Wait on the shared limiter and return the provider it picked. Returns
     * `null` when the shared limiter is disabled.
     */
    async waitForProvider(label, bucketName = 'rpc:shared', method = label) {
        if (!this.useSharedLimiter())
            return null;
        return await this.sharedLimiter.wait(bucketName, {
            label,
            metrics: {
                app: this.metricsApp,
                profile: this.metricsProfile,
                method,
            },
        });
    }
    /** Expose the shared limiter so callers can report 429s back. */
    getSharedLimiter() {
        return this.useSharedLimiter() ? this.sharedLimiter : null;
    }
}
function createLimitedConnection(mainUrl, fallbackUrl, logger, useSharedLimiter) {
    const connectionConfig = { commitment: 'confirmed', disableRetryOnRateLimit: true };
    const primary = new web3_js_1.Connection(mainUrl, connectionConfig);
    const fallback = fallbackUrl && fallbackUrl !== mainUrl ? new web3_js_1.Connection(fallbackUrl, connectionConfig) : null;
    const limiter = new SharedRpcConnectionLimiter(logger, useSharedLimiter, 'SA Crew Bot');
    const callWithLimit = (label, bucketName, method, target, value, args) => limiter.wait(label, bucketName, method).then(() => value.apply(target, args));
    return new Proxy(primary, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') {
                return value;
            }
            const fallbackValue = fallback ? Reflect.get(fallback, prop, fallback) : null;
            return async (...args) => {
                const method = String(prop);
                const label = `Connection.${String(prop)}()`;
                const bucketName = prop === 'sendRawTransaction' ? 'tx:shared' : 'rpc:shared';
                // Provider-aware dispatch: ask the shared limiter which provider to
                // use, dispatch to that Connection, and on 429 report back so the
                // failed provider goes into cooldown.
                const sharedLimiter = limiter.getSharedLimiter();
                let pickedProvider = 'main';
                if (sharedLimiter) {
                    try {
                        const pick = await limiter.waitForProvider(label, bucketName, method);
                        if (pick)
                            pickedProvider = pick.provider;
                    }
                    catch (waitError) {
                        logger.warn(`Shared limiter wait failed for ${label}, defaulting to main.`, waitError);
                    }
                }
                const usePickedAsPrimary = pickedProvider === 'main';
                const pickedTarget = usePickedAsPrimary ? target : (fallback ?? target);
                const pickedValue = usePickedAsPrimary ? value : (typeof fallbackValue === 'function' ? fallbackValue : value);
                const otherTarget = usePickedAsPrimary ? (fallback ?? target) : target;
                const otherValue = usePickedAsPrimary
                    ? (typeof fallbackValue === 'function' ? fallbackValue : null)
                    : value;
                const otherLabel = usePickedAsPrimary
                    ? `fallback Connection.${String(prop)}()`
                    : `main Connection.${String(prop)}()`;
                try {
                    return await callWithLimit(label, bucketName, method, pickedTarget, pickedValue, args);
                }
                catch (error) {
                    if (!otherTarget || otherTarget === pickedTarget || typeof otherValue !== 'function') {
                        if (sharedLimiter && isRpcRateLimitError(error)) {
                            await sharedLimiter.recordProviderOutcome(pickedProvider, 'rate_limited').catch(() => undefined);
                        }
                        throw error;
                    }
                    logger.warn(`Provider ${pickedProvider} failed for ${label}, trying other provider.`, error);
                    if (sharedLimiter && isRpcRateLimitError(error)) {
                        try {
                            await sharedLimiter.recordProviderOutcome(pickedProvider, 'rate_limited');
                        }
                        catch (reportError) {
                            logger.warn(`Failed to record provider outcome for ${pickedProvider}.`, reportError);
                        }
                    }
                    return await callWithLimit(otherLabel, bucketName, method, otherTarget, otherValue, args);
                }
            };
        }
    });
}
function normalizeCheckIntervalMinutes(value) {
    const numeric = Number(value);
    const maxTier = CHECK_INTERVAL_MINUTES_TIERS[CHECK_INTERVAL_MINUTES_TIERS.length - 1];
    const bounded = Number.isFinite(numeric)
        ? Math.max(CHECK_INTERVAL_MINUTES_TIERS[0], Math.min(maxTier, numeric))
        : 30;
    let nearest = CHECK_INTERVAL_MINUTES_TIERS[0];
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
function stepCheckIntervalMinutes(current, direction) {
    const normalized = normalizeCheckIntervalMinutes(current);
    const index = CHECK_INTERVAL_MINUTES_TIERS.indexOf(normalized);
    if (index === -1) {
        return 30;
    }
    if (direction === 'shorter') {
        return CHECK_INTERVAL_MINUTES_TIERS[Math.max(0, index - 1)];
    }
    return CHECK_INTERVAL_MINUTES_TIERS[Math.min(CHECK_INTERVAL_MINUTES_TIERS.length - 1, index + 1)];
}
function buildBestCompetingBidSignature(snapshot) {
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
class CrewBidBot {
    config;
    logger;
    connection;
    wallet;
    tcompSdk;
    running = false;
    loopTimer = null;
    cycleInProgress = false;
    resyncAfterCurrentCycle = false;
    startedAt = null;
    lastCycleStartedAt = null;
    lastCycleCompletedAt = null;
    lastCycleDurationMs = null;
    recentActivity = [];
    solBalanceCache = null;
    marginAlertLevel = 'ok';
    pendingMissingBidWarning = null;
    currentCheckIntervalMinutes;
    previousBestCompetingBidSignature = null;
    hasBestCompetingBidBaseline = false;
    state = {
        currentBidLamports: null,
        bestCompetingBidLamports: null,
        competingBidLamports: [],
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
        activeAttributes: [],
        marginAccountSolBalance: null,
        lastCheckAt: null,
        lastAction: null,
        lastUpdatedAt: null,
        solBalance: null
    };
    constructor(config, logger = defaultLogger) {
        this.config = config;
        this.logger = logger;
        const secretKeyBytes = decodeSecret(config.hotWalletSecret);
        this.wallet =
            secretKeyBytes.length === 32
                ? web3_js_1.Keypair.fromSeed(secretKeyBytes)
                : web3_js_1.Keypair.fromSecretKey(secretKeyBytes);
        this.connection = createLimitedConnection(config.rpcUrl, config.rpcUrlFallback, this.logger, () => Boolean(this.config.useRpcLimiter));
        const provider = new anchor_1.AnchorProvider(this.connection, new anchor_1.Wallet(this.wallet), anchor_1.AnchorProvider.defaultOptions());
        this.tcompSdk = new tcomp_sdk_1.TCompSDK({ provider });
        if (config.side !== 'buy') {
            throw new Error(`Unsupported side: ${config.side}. Only buy is currently implemented.`);
        }
        if (config.targetId !== tensor_market_1.STAR_ATLAS_CREW_TARGET_ID) {
            this.logger.warn(`Configured targetId ${config.targetId} does not match expected Star Atlas Crew target ${tensor_market_1.STAR_ATLAS_CREW_TARGET_ID}`);
        }
        this.currentCheckIntervalMinutes = normalizeCheckIntervalMinutes(config.checkIntervalMinutes);
    }
    isRunning() {
        return this.running;
    }
    async getStatus() {
        if (this.running) {
            await this.refreshMarket();
        }
        return {
            rowId: this.config.rowId,
            running: this.running,
            wallet: this.wallet.publicKey.toBase58(),
            bidState: this.config.bidState,
            bidId: this.config.bidId,
            marginAccount: this.config.marginAccount,
            currentBidLamports: this.state.currentBidLamports,
            bestCompetingBidLamports: this.state.bestCompetingBidLamports,
            competingBidLamports: this.state.competingBidLamports,
            bestAskLamports: this.state.bestAskLamports,
            targetBidLamports: this.state.targetBidLamports,
            currentOrderTraitsLabel: (0, tensor_market_1.formatAttributesLabel)(this.state.activeAttributes),
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
    async start() {
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
    async stop() {
        this.running = false;
        if (this.loopTimer) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }
        this.pushActivity('STOP', 'Bot stopped');
        this.logger.info('CrewBidBot stopped');
    }
    applyConfigUpdates(nextConfig) {
        this.config = nextConfig;
        this.currentCheckIntervalMinutes = normalizeCheckIntervalMinutes(nextConfig.checkIntervalMinutes);
        this.previousBestCompetingBidSignature = null;
        this.hasBestCompetingBidBaseline = false;
    }
    async runImmediateCycle() {
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
    async getSolBalance(options) {
        if (!options?.refresh && this.solBalanceCache != null) {
            return this.solBalanceCache;
        }
        const solLamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
        this.solBalanceCache = solLamports / 1_000_000_000;
        return this.solBalanceCache;
    }
    async refreshMarket() {
        const previousBidLamports = this.state.currentBidLamports;
        const previousBidAddress = this.state.ownBidAddress;
        const previousBidQuantity = this.state.ownBidQuantity;
        const previousBidFilledQuantity = this.state.ownBidFilledQuantity ?? 0;
        const marginAccountPk = publicKeyFromString(this.config.marginAccount, 'marginAccount');
        const [snapshot, solBalance, marginSolLamports] = await Promise.all([
            (0, tensor_market_1.fetchCrewMarketSnapshot)({
                ownerAddress: this.wallet.publicKey.toBase58(),
                ownBidState: this.config.bidState,
                slugUuid: this.config.collectionSlugUuid,
                targetId: this.config.targetId,
                minRelevantBidQuantity: this.config.minRelevantBidQuantity
            }),
            this.getSolBalance(),
            this.connection.getBalance(marginAccountPk, 'confirmed').catch(() => 0)
        ]);
        this.state.currentBidLamports = snapshot.ownBidLamports;
        this.state.bestCompetingBidLamports = snapshot.bestCompetingBidLamports;
        this.state.competingBidLamports = snapshot.competingBidLamports;
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
        this.state.activeAttributes = snapshot.activeAttributes;
        this.state.lastCheckAt = new Date().toISOString();
        this.state.solBalance = solBalance;
        this.state.marginAccountSolBalance = marginSolLamports / 1_000_000_000;
        const currentFilledQuantity = snapshot.ownBidFilledQuantity ?? 0;
        const isSameTrackedBid = previousBidLamports != null &&
            previousBidAddress != null &&
            snapshot.ownBidAddress != null &&
            previousBidAddress === snapshot.ownBidAddress;
        if (isSameTrackedBid && currentFilledQuantity > previousBidFilledQuantity) {
            const deltaFilled = currentFilledQuantity - previousBidFilledQuantity;
            const totalQty = snapshot.ownBidQuantity ?? previousBidQuantity ?? this.config.quantity;
            const remaining = Math.max(0, totalQty - currentFilledQuantity);
            this.pushActivity('FILLED', `Filled +${deltaFilled} (filled ${currentFilledQuantity}/${totalQty}, remaining ${remaining}).`);
        }
        if (previousBidLamports != null && snapshot.ownBidLamports == null) {
            const totalQty = previousBidQuantity ?? this.config.quantity;
            const filled = previousBidFilledQuantity;
            const fullyFilled = filled >= totalQty;
            if (fullyFilled) {
                this.pushActivity('FILLED', `Bid ${previousBidAddress ?? this.config.bidId} is no longer open on the market (filled ${filled}/${totalQty}).`);
                await this.rotateBidIdentity('previous bid fully filled/closed');
            }
            else {
                this.pendingMissingBidWarning =
                    `Bid ${previousBidAddress ?? this.config.bidId} disappeared without full fill (${filled}/${totalQty}); keeping bid identity.`;
            }
        }
        this.evaluateMarginAlerts();
    }
    computeFundableQtyForPrice(priceLamports) {
        if (priceLamports == null || priceLamports <= 0) {
            return null;
        }
        const requiredLamports = this.computeEstimatedFillSpendLamports(priceLamports);
        if (this.state.ownBidSolBalanceLamports != null) {
            return Math.max(0, Math.floor(this.state.ownBidSolBalanceLamports / requiredLamports));
        }
        if (this.state.marginAccountSolBalance != null) {
            return Math.max(0, Math.floor((this.state.marginAccountSolBalance * 1_000_000_000) / requiredLamports));
        }
        return null;
    }
    computeEstimatedFillSpendLamports(limitBidLamports) {
        return (0, tensor_market_1.applyTensorTakerFeesLamports)(limitBidLamports, this.state.royaltyFeeBps);
    }
    evaluateMarginAlerts() {
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
        const nextLevel = hasLiveOpenBid ? 'ok' : fundable <= 0 ? 'empty' : fundable < totalQty ? 'low' : 'ok';
        if (nextLevel === this.marginAlertLevel) {
            return;
        }
        if (nextLevel === 'low') {
            this.pushActivity('MARGIN_LOW', `Margin can fund ${fundable}/${totalQty}.`);
        }
        else if (nextLevel === 'empty') {
            this.pushActivity('MARGIN_EMPTY', `Margin can fund 0/${totalQty}. No order capacity.`);
        }
        this.marginAlertLevel = nextLevel;
    }
    computeTargetBid() {
        const target = (0, tensor_market_1.computeTargetCrewBidLamports)({
            bestCompetingBidLamports: this.state.bestCompetingBidLamports,
            competingBidLamports: this.state.competingBidLamports,
            minBidLamports: this.config.minBidSol == null ? null : solToLamports(this.config.minBidSol),
            maxBidLamports: this.config.maxBidSol == null ? null : solToLamports(this.config.maxBidSol),
            bidStepLamports: solToLamports(this.config.bidStepSol),
            bestAskLamports: this.state.bestAskLamports
        });
        this.state.targetBidLamports = target;
        return target;
    }
    shouldCancelInsteadOfBid() {
        const target = this.state.targetBidLamports;
        if (target == null) {
            return false;
        }
        return this.config.minBidSol != null && target < solToLamports(this.config.minBidSol);
    }
    async updateBidIfNeeded() {
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
        const currentQuantity = this.state.ownBidQuantity;
        const filledQuantity = this.state.ownBidFilledQuantity ?? 0;
        const remainingQuantity = currentQuantity == null
            ? null
            : Math.max(0, currentQuantity - filledQuantity);
        const shouldRefill = hasLiveOpenBid &&
            this.config.refillBelowQuantity != null &&
            remainingQuantity != null &&
            remainingQuantity < this.config.refillBelowQuantity;
        const fundableQuantity = shouldRefill ? this.computeFundableQtyForPrice(target) : null;
        const refillFunded = shouldRefill && fundableQuantity != null && fundableQuantity >= this.config.quantity;
        const requestedQuantity = this.config.refillBelowQuantity == null
            ? this.config.quantity
            : refillFunded
                ? filledQuantity + this.config.quantity
                : currentQuantity ?? this.config.quantity;
        const priceChanged = !sameLamports(current, target);
        const quantityChanged = hasLiveOpenBid && currentQuantity != null && currentQuantity !== requestedQuantity;
        if (!priceChanged && !quantityChanged) {
            this.state.lastAction = shouldRefill && !refillFunded
                ? `Refill waiting: margin can fund ${fundableQuantity ?? 0}/${this.config.quantity}`
                : `No change needed (${lamportsToSol(target)} SOL, quantity ${this.config.quantity})`;
            return false;
        }
        await this.sendBidUpdate(target, requestedQuantity);
        this.state.currentBidLamports = target;
        this.state.ownBidQuantity = requestedQuantity;
        const changes = [
            priceChanged ? `price ${lamportsToSol(current)} -> ${lamportsToSol(target)} SOL` : null,
            quantityChanged
                ? refillFunded
                    ? `quantity ${currentQuantity} -> ${requestedQuantity} (refilled remaining to ${this.config.quantity})`
                    : `quantity ${currentQuantity} -> ${requestedQuantity}`
                : null
        ].filter((change) => change != null);
        this.state.lastAction = `Updated bid: ${changes.join(', ')}`;
        this.state.lastUpdatedAt = new Date().toISOString();
        this.pushActivity('BID_UPDATED', this.state.lastAction);
        return true;
    }
    async cancelBidNow() {
        return this.cancelBid();
    }
    buildOpenOrdersSnapshot() {
        if (this.state.currentBidLamports == null) {
            return [];
        }
        const onChainQuantity = this.state.ownBidQuantity ?? this.config.quantity ?? null;
        const filledQuantity = this.state.ownBidFilledQuantity ?? 0;
        const remaining = typeof onChainQuantity === 'number'
            ? Math.max(0, Math.floor(onChainQuantity - filledQuantity))
            : null;
        const isBestBid = this.config.side === 'buy' &&
            this.state.currentBidLamports != null &&
            (this.state.bestCompetingBidLamports == null || this.state.currentBidLamports >= this.state.bestCompetingBidLamports);
        return [
            {
                rowId: this.config.rowId,
                label: 'Star Atlas Crew',
                side: this.config.side,
                priceLamports: this.state.currentBidLamports,
                quantity: this.config.quantity,
                remaining,
                bidState: this.state.ownBidAddress ?? this.config.bidState,
                bidId: this.config.bidId,
                marginAccount: this.state.ownBidMargin ?? this.config.marginAccount,
                traitsLabel: (0, tensor_market_1.formatAttributesLabel)(this.state.activeAttributes),
                marketLeader: isBestBid ? 'bb' : undefined
            }
        ];
    }
    pushActivity(event, message) {
        this.recentActivity.unshift({
            timestamp: new Date().toISOString(),
            event,
            title: this.formatActivityTitle(event),
            message
        });
        this.recentActivity = this.recentActivity.slice(0, RECENT_ACTIVITY_LIMIT);
    }
    formatActivityTitle(event) {
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
    async closeOldBidBestEffort(reason) {
        const oldBidId = this.config.bidId;
        if (!oldBidId) {
            return;
        }
        try {
            const bidId = publicKeyFromString(oldBidId, 'bidId');
            const ownerPk = this.wallet.publicKey;
            const { tx: { ixs, extraSigners = [] } } = await this.tcompSdk.cancelBid({
                bidId,
                owner: ownerPk,
                rentDest: ownerPk
            });
            const sig = await this.signAndSendInstructions(ixs, extraSigners);
            const message = `Closed old bid ${oldBidId} before rotation (${reason}) [${sig}]`;
            this.logger.info(message);
            this.pushActivity('BID_CLOSE_OLD', message);
        }
        catch (err) {
            const message = `Old bid close skipped/failed for ${oldBidId} (${reason}): ${err.message}`;
            this.logger.warn(message);
            this.pushActivity('BID_CLOSE_OLD_FAILED', message);
        }
    }
    async rotateBidIdentity(reason) {
        const previousBidId = this.config.bidId;
        await this.closeOldBidBestEffort(reason);
        const nextBidId = web3_js_1.Keypair.generate().publicKey.toBase58();
        this.config.bidId = nextBidId;
        this.config.bidState = '';
        this.state.ownBidAddress = null;
        this.state.ownBidSolBalanceLamports = null;
        this.state.ownBidMarginNr = null;
        const message = `Rotated bid identity (${reason}): ${previousBidId} -> ${nextBidId}`;
        this.logger.info(message);
        this.pushActivity('BID_ID_ROTATED', message);
    }
    async signAndSendInstructions(ixs, extraSigners = []) {
        const tx = new web3_js_1.Transaction();
        tx.add(...ixs);
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.wallet.publicKey;
        tx.partialSign(this.wallet, ...extraSigners);
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        return signature;
    }
    async sendBidUpdate(limitBidLamports, quantity = this.config.quantity) {
        const ownerPk = this.wallet.publicKey;
        this.logger.info(`Sending Tensor bid update: amount=${limitBidLamports} estimatedFillSpend=${this.computeEstimatedFillSpendLamports(limitBidLamports)} royaltyFeeBps=${this.state.royaltyFeeBps ?? 0} quantity=${quantity} traits=${(0, tensor_market_1.formatAttributesLabel)(this.state.activeAttributes)}`);
        const bidIdPk = publicKeyFromString(this.config.bidId, 'bidId');
        const targetIdPk = publicKeyFromString(this.config.targetId, 'targetId');
        const marginPk = publicKeyFromString(this.config.marginAccount, 'marginAccount');
        const makerBrokerPk = optionalPublicKeyFromString(this.config.makerBroker);
        const { tx: { ixs, extraSigners = [] }, bidState } = await this.tcompSdk.bid({
            owner: ownerPk,
            amount: new bn_js_1.default(limitBidLamports),
            expireInSec: null,
            privateTaker: null,
            bidId: bidIdPk,
            targetId: targetIdPk,
            target: tcomp_sdk_1.Target.Whitelist,
            quantity,
            margin: marginPk,
            field: null,
            fieldId: null,
            makerBroker: makerBrokerPk
        });
        const sig = await this.signAndSendInstructions(ixs, extraSigners);
        this.config.bidState = bidState.toBase58();
        this.state.ownBidAddress = this.config.bidState;
        this.logger.info(`Tensor bid update confirmed: ${sig}`);
    }
    async cancelBid() {
        if (this.state.currentBidLamports == null) {
            this.state.lastAction = 'No active bid to cancel';
            return false;
        }
        const bidId = publicKeyFromString(this.config.bidId, 'bidId');
        const ownerPk = this.wallet.publicKey;
        this.logger.info(`Cancelling Tensor bid: bidId=${bidId.toBase58()}`);
        const { tx: { ixs, extraSigners = [] } } = await this.tcompSdk.cancelBid({
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
    async runCycleCore() {
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
            }
            else {
                const changed = currentBestCompetingSignature !== this.previousBestCompetingBidSignature;
                this.currentCheckIntervalMinutes = changed
                    ? stepCheckIntervalMinutes(this.currentCheckIntervalMinutes, 'shorter')
                    : stepCheckIntervalMinutes(this.currentCheckIntervalMinutes, 'longer');
                this.previousBestCompetingBidSignature = currentBestCompetingSignature;
            }
            this.lastCycleCompletedAt = new Date().toISOString();
            this.lastCycleDurationMs = Date.now() - startedAt;
            this.pushActivity('CYCLE_OK', `Cycle finished in ${this.lastCycleDurationMs} ms`);
        }
        catch (err) {
            this.logger.error('CrewBidBot cycle failed:', err);
            this.state.lastAction = `ERROR: ${err.message}`;
            this.lastCycleCompletedAt = new Date().toISOString();
            this.lastCycleDurationMs = Date.now() - startedAt;
            this.pushActivity('CYCLE_ERROR', this.state.lastAction);
        }
        finally {
            this.cycleInProgress = false;
        }
    }
    async loop() {
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
exports.CrewBidBot = CrewBidBot;
