import {
  BigDecimal,
  BurnEntity,
  CollectEntity,
  MintEntity,
  SwapEntity,
  CLPoolContract,
} from "generated";
import { ONE_BI, ZERO_BD, ZERO_BI } from "./utils/constants";
import {
  convertTokenToDecimal,
  getFactoryAddress,
  loadTransaction,
  safeDiv,
} from "./utils";
import {
  findNativePerToken,
  getNativePriceInUSD,
  getTrackedAmountUSD,
  sqrtPriceX96ToTokenPrices,
} from "./utils/pricing";
import { getSubgraphConfig } from "./utils/chains";
import {
  getDayID,
  getDayStartTimestamp,
  getHourIndex,
  getHourStartUnix,
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
  updateUniswapDayData,
} from "./utils/intervalUpdates";
import { createTick } from "./utils/tick";

// CLPoolContract.Burn.loader(({ event, context }) => {
//   const poolAddress = event.srcAddress;
//   const lowerTickId =
//     poolAddress + "#" + BigInt(event.params.tickLower).toString();
//   const upperTickId =
//     poolAddress + "#" + BigInt(event.params.tickUpper).toString();

//   context.Tick.load(lowerTickId, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
//   context.Tick.load(upperTickId, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
//   context.Bundle.load(event.chainId.toString());

//   const dayID = getDayID(event.blockTimestamp);
//   context.UniswapDayData.load(dayID.toString());

//   const dayPoolID = event.srcAddress.concat("-").concat(dayID.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.PoolDayData.load(dayPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });

//   const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
//   const hourPoolID = event.srcAddress.concat("-").concat(hourIndex.toString());
//   context.PoolHourData.load(hourPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
// });

CLPoolContract.Burn.handlerAsync(async ({ event, context }) => {
  const factoryAddress = getFactoryAddress(event.chainId);

  let [bundle, pool, factory] = await Promise.all([
    context.Bundle.get(event.chainId.toString())!,
    context.Pool.get(event.srcAddress)!,
    context.Factory.get(factoryAddress)!,
  ]);

  if (!bundle) {
    return context.log.error(`Bundle not found for chain ${event.chainId}`);
  }

  if (!pool || !pool.token0_id || !pool.token1_id) {
    return context.log.error(
      `Pool or Pool Tokens ID's not found for chain ${event.chainId}`
    );
  }

  if (!factory) {
    return context.log.error(`Factory not found for chain ${event.chainId}`);
  }

  // tick entities
  const lowerTickId =
    event.srcAddress + "#" + event.params.tickLower.toString();
  const upperTickId =
    event.srcAddress + "#" + event.params.tickUpper.toString();

  let [token0, token1, lowerTick, upperTick] = await Promise.all([
    context.Token.get(pool.token0_id),
    context.Token.get(pool.token1_id),
    context.Tick.get(lowerTickId),
    context.Tick.get(upperTickId),
  ]);

  if (token0 && token1) {
    const amount0 = convertTokenToDecimal(
      event.params.amount0,
      token0.decimals
    );
    const amount1 = convertTokenToDecimal(
      event.params.amount1,
      token1.decimals
    );

    const amountUSD = amount0
      .times(token0.derivedETH.times(bundle.ethPriceUSD))
      .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

    // update globals
    factory = {
      ...factory,
      txCount: factory.txCount + ONE_BI,
    };

    token0 = {
      ...token0,
      txCount: token0.txCount + ONE_BI,
    };

    token1 = {
      ...token1,
      txCount: token1.txCount + ONE_BI,
    };

    pool = {
      ...pool,
      txCount: pool.txCount + ONE_BI,
    };

    // Pools liquidity tracks the currently active liquidity given pools current tick.
    // We only want to update it on burn if the position being burnt includes the current tick.
    if (
      pool.tick &&
      event.params.tickLower <= pool.tick &&
      event.params.tickUpper > pool.tick
    ) {
      // todo: this liquidity can be calculated from the real reserves and
      // current price instead of incrementally from every burned amount which
      // may not be accurate: https://linear.app/uniswap/issue/DAT-336/fix-pool-liquidity

      pool = {
        ...pool,
        liquidity: pool.liquidity - event.params.amount,
      };
    }

    // burn entity
    const transaction = await loadTransaction(
      event.transactionHash,
      event.blockNumber,
      event.blockTimestamp,
      context
    );

    if (!pool.token0_id || !pool.token1_id) {
      return context.log.error(`Pool Tokens ID's not found in Burn Event`);
    }

    let burn: BurnEntity = {
      id: transaction.id + "-" + event.logIndex.toString(),
      transaction_id: transaction.id,
      timestamp: BigInt(transaction.timestamp),
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      owner: event.params.owner,
      origin: event.txOrigin,
      amount: event.params.amount,
      amount0: amount0,
      amount1: amount1,
      amountUSD: amountUSD,
      tickLower: event.params.tickLower,
      tickUpper: event.params.tickUpper,
      logIndex: event.logIndex,
    };

    if (lowerTick && upperTick) {
      const amount = event.params.amount;

      lowerTick = {
        ...lowerTick,
        liquidityGross: lowerTick.liquidityGross - amount,
        liquidityNet: lowerTick.liquidityNet - amount,
      };

      upperTick = {
        ...upperTick,
        liquidityGross: upperTick.liquidityGross - amount,
        liquidityNet: upperTick.liquidityNet + amount,
      };

      context.Tick.set(lowerTick);
      context.Tick.set(upperTick);
    }

    const dayID = getDayID(event.blockTimestamp);
    const dayPoolID = pool.id.concat("-").concat(dayID.toString());
    const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
    const hourPoolID = pool.id.concat("-").concat(hourIndex.toString());
    const tokenDayID0 = token0.id.concat("-").concat(dayID.toString());
    const tokenDayID1 = token1.id.concat("-").concat(dayID.toString());
    const tokenHourID0 = token0.id.concat("-").concat(hourIndex.toString());
    const tokenHourID1 = token1.id.concat("-").concat(hourIndex.toString());

    let [
      uniswapDayData,
      poolDayData,
      poolHourData,
      tokenDayData0,
      tokenDayData1,
      tokenHourData0,
      tokenHourData1,
    ] = await Promise.all([
      context.UniswapDayData.get(dayID.toString()),
      context.PoolDayData.get(dayPoolID),
      context.PoolHourData.get(hourPoolID),
      context.TokenDayData.get(tokenDayID0),
      context.TokenDayData.get(tokenDayID1),
      context.TokenHourData.get(tokenHourID0),
      context.TokenHourData.get(tokenHourID1),
    ]);

    updateUniswapDayData(dayID, factory, uniswapDayData, context);
    updatePoolDayData(dayID, pool, poolDayData, context);
    updatePoolHourData(event.blockTimestamp, pool, poolHourData, context);
    updateTokenDayData(token0, bundle, dayID, tokenDayData0, context);
    updateTokenDayData(token1, bundle, dayID, tokenDayData1, context);
    updateTokenHourData(
      token0,
      bundle,
      event.blockTimestamp,
      tokenHourData0,
      context
    );
    updateTokenHourData(
      token1,
      bundle,
      event.blockTimestamp,
      tokenHourData1,
      context
    );

    context.Token.set(token0);
    context.Token.set(token1);
    context.Pool.set(pool);
    context.Factory.set(factory);
    context.Burn.set(burn);
  }
});

// CLPoolContract.Collect.loader(({ event, context }) => {
//   context.Bundle.load(event.chainId.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });

//   const dayID = getDayID(event.blockTimestamp);
//   context.UniswapDayData.load(dayID.toString());

//   const dayPoolID = event.srcAddress.concat("-").concat(dayID.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.PoolDayData.load(dayPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });

//   const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
//   const hourPoolID = event.srcAddress.concat("-").concat(hourIndex.toString());
//   context.PoolHourData.load(hourPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
// });

CLPoolContract.Collect.handlerAsync(async ({ event, context }) => {
  const subgraphConfig = getSubgraphConfig(event.chainId);
  const factoryAddress = getFactoryAddress(event.chainId);

  const whitelistTokens = subgraphConfig.whitelistTokens;

  let [bundle, pool, factory] = await Promise.all([
    context.Bundle.get(event.chainId.toString())!,
    context.Pool.get(event.srcAddress),
    context.Factory.get(factoryAddress)!,
  ]);

  if (!bundle) {
    return context.log.error(`Bundle not found for chain ${event.chainId}`);
  }

  if (!pool || !pool.token0_id || !pool.token1_id) {
    return;
  }

  const transaction = await loadTransaction(
    event.transactionHash,
    event.blockNumber,
    event.blockTimestamp,
    context
  );

  if (!factory) {
    return context.log.error(`Factory not found for chain ${event.chainId}`);
  }

  let [token0, token1] = await Promise.all([
    context.Token.get(pool.token0_id),
    context.Token.get(pool.token1_id),
  ]);

  if (!token0 || !token1) return;

  // Get formatted amounts collected.
  const collectedAmountToken0 = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  );
  const collectedAmountToken1 = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  );
  const trackedCollectedAmountUSD = getTrackedAmountUSD(
    collectedAmountToken0,
    token0,
    collectedAmountToken1,
    token1,
    whitelistTokens,
    bundle
  );

  // Reset tvl aggregates until new amounts calculated
  factory = {
    ...factory,
    totalValueLockedETH: factory.totalValueLockedETH.minus(
      pool.totalValueLockedETH
    ),
    txCount: factory.txCount + ONE_BI,
  };

  // update token data
  token0 = {
    ...token0,
    txCount: token0.txCount + ONE_BI,
    totalValueLocked: token0.totalValueLocked.minus(collectedAmountToken0),
  };

  token0 = {
    ...token0,
    totalValueLockedUSD: token0.totalValueLocked.times(
      token0.derivedETH.times(bundle.ethPriceUSD)
    ),
  };

  token1 = {
    ...token1,
    txCount: token1.txCount + ONE_BI,
    totalValueLocked: token1.totalValueLocked.minus(collectedAmountToken1),
  };

  token1 = {
    ...token1,
    totalValueLockedUSD: token1.totalValueLocked.times(
      token1.derivedETH.times(bundle.ethPriceUSD)
    ),
  };

  // Adjust pool TVL based on amount collected.
  pool = {
    ...pool,
    txCount: pool.txCount + ONE_BI,
    totalValueLockedToken0: pool.totalValueLockedToken0.minus(
      collectedAmountToken0
    ),
    totalValueLockedToken1: pool.totalValueLockedToken1.minus(
      collectedAmountToken1
    ),
  };

  pool = {
    ...pool,
    totalValueLockedETH: pool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
  };

  pool = {
    ...pool,
    totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
    collectedFeesToken0: pool.collectedFeesToken0.plus(collectedAmountToken0),
    collectedFeesToken1: pool.collectedFeesToken1.plus(collectedAmountToken1),
    collectedFeesUSD: pool.collectedFeesUSD.plus(trackedCollectedAmountUSD),
  };

  factory = {
    ...factory,
    totalValueLockedETH: factory.totalValueLockedETH.plus(
      pool.totalValueLockedETH
    ),
  };

  factory = {
    ...factory,
    totalValueLockedUSD: factory.totalValueLockedETH.times(bundle.ethPriceUSD),
  };

  let collect: CollectEntity = {
    id: transaction.id + "-" + event.logIndex.toString(),
    transaction_id: transaction.id,
    timestamp: BigInt(event.blockTimestamp),
    pool_id: pool.id,
    owner: event.params.owner,
    amount0: collectedAmountToken0,
    amount1: collectedAmountToken1,
    amountUSD: trackedCollectedAmountUSD,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    logIndex: event.logIndex,
  };

  const dayID = getDayID(event.blockTimestamp);
  const dayPoolID = pool.id.concat("-").concat(dayID.toString());
  const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
  const hourStartUnix = getHourStartUnix(hourIndex); // want the rounded effect
  const hourPoolID = pool.id.concat("-").concat(hourIndex.toString());
  const tokenDayID0 = token0.id.concat("-").concat(dayID.toString());
  const tokenDayID1 = token1.id.concat("-").concat(dayID.toString());
  const tokenHourID0 = token0.id.concat("-").concat(hourIndex.toString());
  const tokenHourID1 = token1.id.concat("-").concat(hourIndex.toString());

  let [
    uniswapDayData,
    poolDayData,
    poolHourData,
    tokenDayData0,
    tokenDayData1,
    tokenHourData0,
    tokenHourData1,
  ] = await Promise.all([
    context.UniswapDayData.get(dayID.toString()),
    context.PoolDayData.get(dayPoolID),
    context.PoolHourData.get(hourPoolID),
    context.TokenDayData.get(tokenDayID0),
    context.TokenDayData.get(tokenDayID1),
    context.TokenHourData.get(tokenHourID0),
    context.TokenHourData.get(tokenHourID1),
  ]);

  updateUniswapDayData(dayID, factory, uniswapDayData, context);
  updatePoolDayData(dayID, pool, poolDayData, context);
  updatePoolHourData(event.blockTimestamp, pool, poolHourData, context);
  updateTokenDayData(token0, bundle, dayID, tokenDayData0, context);
  updateTokenDayData(token1, bundle, dayID, tokenDayData1, context);
  updateTokenHourData(
    token0,
    bundle,
    event.blockTimestamp,
    tokenHourData0,
    context
  );
  updateTokenHourData(
    token1,
    bundle,
    event.blockTimestamp,
    tokenHourData1,
    context
  );

  context.Token.set(token0);
  context.Token.set(token1);
  context.Factory.set(factory);
  context.Pool.set(pool);
  context.Collect.set(collect);
});

// CLPoolContract.Initialize.loader(({ event, context }) => {
//   const subgraphConfig = getSubgraphConfig(event.chainId);

//   context.Pool.load(event.srcAddress, {
//     loadToken0: true,
//     loadToken1: true,
//   });
//   context.Bundle.load(event.chainId.toString());
//   context.Pool.load(subgraphConfig.stablecoinWrappedNativePoolAddress, {
//     loadToken0: true,
//     loadToken1: true,
//   });

//   const dayID = getDayID(event.blockTimestamp);

//   const dayPoolID = event.srcAddress.concat("-").concat(dayID.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.PoolDayData.load(dayPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
// });

// CLPoolContract.Initialize.handlerAsync(async ({ event, context }) => {
//   const subgraphConfig = getSubgraphConfig(event.chainId);

//   const stablecoinWrappedNativePoolAddress =
//     subgraphConfig.stablecoinWrappedNativePoolAddress;
//   const stablecoinIsToken0 = subgraphConfig.stablecoinIsToken0;
//   const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress;
//   const stablecoinAddresses = subgraphConfig.stablecoinAddresses;
//   const minimumNativeLocked = subgraphConfig.minimumNativeLocked;

//   // update pool sqrt price and tick
//   let [bundle, pool, stablecoinWrappedNativePool] = await Promise.all([
//     context.Bundle.get(event.chainId.toString())!,
//     context.Pool.get(event.srcAddress)!,
//     context.Pool.get(stablecoinWrappedNativePoolAddress),
//   ]);

//   if (!pool) {
//     return context.log.error(`Pool not found for chain ${event.chainId}`);
//   }

//   pool = {
//     ...pool,
//     sqrtPrice: event.params.sqrtPriceX96,
//     tick: event.params.tick,
//   };

//   context.Pool.set(pool);

//   if (!bundle) {
//     return context.log.error(`Bundle not found for chain ${event.chainId}`);
//   }

//   bundle = {
//     ...bundle,
//     ethPriceUSD: getNativePriceInUSD(
//       stablecoinIsToken0,
//       stablecoinWrappedNativePool
//     ),
//   };

//   context.Bundle.set(bundle);

//   const dayID = getDayID(event.blockTimestamp);

//   // update token prices
//   let [token0, token1] = await Promise.all([
//     context.Token.get(pool.token0_id),
//     context.Token.get(pool.token1_id),
//     updatePoolDayData(dayID, pool, context),
//     updatePoolHourData(event.blockTimestamp, pool, context),
//   ]);

//   // update token prices
//   if (token0 && token1) {
//     let [token0DerivedEth, token1DerivedEth] = await Promise.all([
//       findNativePerToken(
//         token0,
//         wrappedNativeAddress,
//         stablecoinAddresses,
//         minimumNativeLocked,
//         bundle,
//         context
//       ),
//       findNativePerToken(
//         token1,
//         wrappedNativeAddress,
//         stablecoinAddresses,
//         minimumNativeLocked,
//         bundle,
//         context
//       ),
//     ]);

//     token0 = {
//       ...token0,
//       derivedETH: token0DerivedEth,
//     };

//     token1 = {
//       ...token1,
//       derivedETH: token1DerivedEth,
//     };

//     context.Token.set(token0);
//     context.Token.set(token1);
//   }
// });

// CLPoolContract.Mint.loader(({ event, context }) => {
//   context.Bundle.load(event.chainId.toString());
//   context.Factory.load(getFactoryAddress(event.chainId));
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });

//   const lowerTickId =
//     event.srcAddress + "#" + BigInt(event.params.tickLower).toString();
//   const upperTickId =
//     event.srcAddress + "#" + BigInt(event.params.tickUpper).toString();

//   context.Tick.load(lowerTickId, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
//   context.Tick.load(upperTickId, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });

//   const dayID = getDayID(event.blockTimestamp);
//   context.UniswapDayData.load(dayID.toString());

//   const dayPoolID = event.srcAddress.concat("-").concat(dayID.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.PoolDayData.load(dayPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });

//   const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
//   const hourPoolID = event.srcAddress.concat("-").concat(hourIndex.toString());
//   context.PoolHourData.load(hourPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
// });

CLPoolContract.Mint.handlerAsync(async ({ event, context }) => {
  const factoryAddress = getFactoryAddress(event.chainId);

  let [bundle, pool, factory] = await Promise.all([
    context.Bundle.get(event.chainId.toString())!,
    context.Pool.get(event.srcAddress)!,
    context.Factory.get(factoryAddress)!,
  ]);

  if (!bundle) {
    return context.log.error(`Bundle not found for chain ${event.chainId}`);
  }

  if (!pool || !pool.token0_id || !pool.token1_id) {
    return context.log.error(
      `Pool or Pool ID's not found for chain ${event.chainId}`
    );
  }

  if (!factory) {
    return context.log.error(`Factory not found for chain ${event.chainId}`);
  }

  const lowerTickId =
    event.srcAddress + "#" + event.params.tickLower.toString();
  const upperTickId =
    event.srcAddress + "#" + event.params.tickUpper.toString();

  let [token0, token1, transaction, lowerTick, upperTick] = await Promise.all([
    context.Token.get(pool.token0_id),
    context.Token.get(pool.token1_id),
    loadTransaction(
      event.transactionHash,
      event.blockNumber,
      event.blockTimestamp,
      context
    ),
    context.Tick.get(lowerTickId),
    context.Tick.get(upperTickId),
  ]);

  if (token0 && token1) {
    const amount0 = convertTokenToDecimal(
      event.params.amount0,
      token0.decimals
    );
    const amount1 = convertTokenToDecimal(
      event.params.amount1,
      token1.decimals
    );

    const amountUSD = amount0
      .times(token0.derivedETH.times(bundle.ethPriceUSD))
      .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

    // reset tvl aggregates until new amounts calculated
    factory = {
      ...factory,
      totalValueLockedETH: factory.totalValueLockedETH.minus(
        pool.totalValueLockedETH
      ),
      txCount: factory.txCount + ONE_BI,
    };

    token0 = {
      ...token0,
      txCount: token0.txCount + ONE_BI,
      totalValueLocked: token0.totalValueLocked.plus(amount0),
    };

    token0 = {
      ...token0,
      totalValueLockedUSD: token0.totalValueLocked.times(
        token0.derivedETH.times(bundle.ethPriceUSD)
      ),
    };

    token1 = {
      ...token1,
      txCount: token1.txCount + ONE_BI,
      totalValueLocked: token1.totalValueLocked.plus(amount1),
    };

    token1 = {
      ...token1,
      totalValueLockedUSD: token1.totalValueLocked.times(
        token1.derivedETH.times(bundle.ethPriceUSD)
      ),
    };

    pool = {
      ...pool,
      txCount: pool.txCount + ONE_BI,
    };

    // Pools liquidity tracks the currently active liquidity given pools current tick.
    // We only want to update it on mint if the new position includes the current tick.
    if (
      pool.tick &&
      event.params.tickLower <= pool.tick &&
      event.params.tickUpper > pool.tick
    ) {
      pool = {
        ...pool,
        liquidity: pool.liquidity + event.params.amount,
      };
    }

    pool = {
      ...pool,
      totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
      totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
    };

    pool = {
      ...pool,
      totalValueLockedETH: pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
    };

    pool = {
      ...pool,
      totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
    };

    factory = {
      ...factory,
      totalValueLockedETH: factory.totalValueLockedETH.plus(
        pool.totalValueLockedETH
      ),
    };

    factory = {
      ...factory,
      totalValueLockedUSD: factory.totalValueLockedETH.times(
        bundle.ethPriceUSD
      ),
    };

    if (!pool.token0_id || !pool.token1_id) {
      return context.log.error(`Pool Tokens ID's not found in Mint Event`);
    }

    let mint: MintEntity = {
      id: transaction.id.toString() + "-" + event.logIndex.toString(),
      transaction_id: transaction.id,
      timestamp: BigInt(transaction.timestamp),
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      owner: event.params.owner,
      sender: event.params.sender,
      origin: event.txOrigin,
      amount: event.params.amount,
      amount0: amount0,
      amount1: amount1,
      amountUSD: amountUSD,
      tickLower: event.params.tickLower,
      tickUpper: event.params.tickUpper,
      logIndex: event.logIndex,
    };

    // tick entities
    const lowerTickIdx = event.params.tickLower;
    const upperTickIdx = event.params.tickUpper;

    if (!lowerTick) {
      lowerTick = createTick(
        lowerTickId,
        lowerTickIdx,
        pool.id,
        event.blockTimestamp,
        event.blockNumber
      );
    }

    if (!upperTick) {
      upperTick = createTick(
        upperTickId,
        upperTickIdx,
        pool.id,
        event.blockTimestamp,
        event.blockNumber
      );
    }

    const amount = event.params.amount;
    lowerTick = {
      ...lowerTick,
      liquidityGross: lowerTick.liquidityGross + amount,
      liquidityNet: lowerTick.liquidityNet + amount,
    };

    upperTick = {
      ...upperTick,
      liquidityGross: upperTick.liquidityGross + amount,
      liquidityNet: upperTick.liquidityNet - amount,
    };

    context.Tick.set(lowerTick);
    context.Tick.set(upperTick);

    // TODO: Update Tick's volume, fees, and liquidity provider count. Computing these on the tick
    // level requires reimplementing some of the swapping code from v3-core.

    const dayID = getDayID(event.blockTimestamp);
    const dayPoolID = pool.id.concat("-").concat(dayID.toString());
    const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
    const hourStartUnix = getHourStartUnix(hourIndex); // want the rounded effect
    const hourPoolID = pool.id.concat("-").concat(hourIndex.toString());
    const tokenDayID0 = token0.id.concat("-").concat(dayID.toString());
    const tokenDayID1 = token1.id.concat("-").concat(dayID.toString());
    const tokenHourID0 = token0.id.concat("-").concat(hourIndex.toString());
    const tokenHourID1 = token1.id.concat("-").concat(hourIndex.toString());

    let [
      uniswapDayData,
      poolDayData,
      poolHourData,
      tokenDayData0,
      tokenDayData1,
      tokenHourData0,
      tokenHourData1,
    ] = await Promise.all([
      context.UniswapDayData.get(dayID.toString()),
      context.PoolDayData.get(dayPoolID),
      context.PoolHourData.get(hourPoolID),
      context.TokenDayData.get(tokenDayID0),
      context.TokenDayData.get(tokenDayID1),
      context.TokenHourData.get(tokenHourID0),
      context.TokenHourData.get(tokenHourID1),
    ]);

    updateUniswapDayData(dayID, factory, uniswapDayData, context);
    updatePoolDayData(dayID, pool, poolDayData, context);
    updatePoolHourData(event.blockTimestamp, pool, poolHourData, context);
    updateTokenDayData(token0, bundle, dayID, tokenDayData0, context);
    updateTokenDayData(token1, bundle, dayID, tokenDayData1, context);
    updateTokenHourData(
      token0,
      bundle,
      event.blockTimestamp,
      tokenHourData0,
      context
    );
    updateTokenHourData(
      token1,
      bundle,
      event.blockTimestamp,
      tokenHourData1,
      context
    );

    context.Token.set(token0);
    context.Token.set(token1);
    context.Pool.set(pool);
    context.Factory.set(factory);
    context.Mint.set(mint);
  }
});

// CLPoolContract.Swap.loader(({ event, context }) => {
//   const subgraphConfig = getSubgraphConfig(event.chainId);

//   context.Bundle.load(event.chainId.toString());
//   context.Factory.load(getFactoryAddress(event.chainId));
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.Pool.load(subgraphConfig.stablecoinWrappedNativePoolAddress, {
//     loadToken0: true,
//     loadToken1: true,
//   });

//   const dayID = getDayID(event.blockTimestamp);
//   context.UniswapDayData.load(dayID.toString());

//   const dayPoolID = event.srcAddress.concat("-").concat(dayID.toString());
//   context.Pool.load(event.srcAddress, { loadToken0: true, loadToken1: true });
//   context.PoolDayData.load(dayPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });

//   const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
//   const hourPoolID = event.srcAddress.concat("-").concat(hourIndex.toString());
//   context.PoolHourData.load(hourPoolID, {
//     loadPool: { loadToken0: true, loadToken1: true },
//   });
// });

CLPoolContract.Swap.handlerAsync(async ({ event, context }) => {
  const factoryAddress = getFactoryAddress(event.chainId);
  const subgraphConfig = getSubgraphConfig(event.chainId);

  const stablecoinWrappedNativePoolAddress =
    subgraphConfig.stablecoinWrappedNativePoolAddress;
  const stablecoinIsToken0 = subgraphConfig.stablecoinIsToken0;
  const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress;
  const stablecoinAddresses = subgraphConfig.stablecoinAddresses;
  const minimumNativeLocked = subgraphConfig.minimumNativeLocked;
  const whitelistTokens = subgraphConfig.whitelistTokens;

  let [bundle, pool, factory] = await Promise.all([
    context.Bundle.get(event.chainId.toString())!,
    context.Pool.get(event.srcAddress)!,
    context.Factory.get(factoryAddress)!,
  ]);

  if (!bundle) {
    return context.log.error(`Bundle not found for chain ${event.chainId}`);
  }

  if (!factory) {
    return context.log.error(`Factory not found for chain ${event.chainId}`);
  }

  if (!pool || !pool.token0_id || !pool.token1_id) {
    return context.log.error(
      `Pool or Pool ID's not found in Swap Event for chain ${event.chainId}`
    );
  }

  // hot fix for bad pricing
  if (pool.id == "0x9663f2ca0454accad3e094448ea6f77443880454") {
    return;
  }

  let [token0, token1] = await Promise.all([
    context.Token.get(pool.token0_id),
    context.Token.get(pool.token1_id),
  ]);

  if (token0 && token1) {
    // amounts - 0/1 are token deltas: can be positive or negative
    const amount0 = convertTokenToDecimal(
      event.params.amount0,
      token0.decimals
    );
    const amount1 = convertTokenToDecimal(
      event.params.amount1,
      token1.decimals
    );

    // need absolute amounts for volume
    let amount0Abs = amount0;
    if (amount0.lt(ZERO_BD)) {
      amount0Abs = amount0.times(BigDecimal("-1"));
    }
    let amount1Abs = amount1;
    if (amount1.lt(ZERO_BD)) {
      amount1Abs = amount1.times(BigDecimal("-1"));
    }

    const amount0ETH = amount0Abs.times(token0.derivedETH);
    const amount1ETH = amount1Abs.times(token1.derivedETH);
    const amount0USD = amount0ETH.times(bundle.ethPriceUSD);
    const amount1USD = amount1ETH.times(bundle.ethPriceUSD);

    // get amount that should be tracked only - div 2 because cant count both input and output as volume
    const amountTotalUSDTracked = getTrackedAmountUSD(
      amount0Abs,
      token0,
      amount1Abs,
      token1,
      whitelistTokens,
      bundle
    ).div(BigDecimal("2"));
    const amountTotalETHTracked = safeDiv(
      amountTotalUSDTracked,
      bundle.ethPriceUSD
    );
    const amountTotalUSDUntracked = amount0USD
      .plus(amount1USD)
      .div(BigDecimal("2"));

    const feesETH = amountTotalETHTracked
      .times(BigDecimal(pool.feeTier.toString()))
      .div(BigDecimal("1000000"));
    const feesUSD = amountTotalUSDTracked
      .times(BigDecimal(pool.feeTier.toString()))
      .div(BigDecimal("1000000"));

    // reset aggregate tvl before individual pool tvl updates
    const currentPoolTvlETH = pool.totalValueLockedETH;

    factory = {
      ...factory,
      txCount: factory.txCount + ONE_BI,
      totalVolumeETH: factory.totalVolumeETH.plus(amountTotalETHTracked),
      totalVolumeUSD: factory.totalVolumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: factory.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      totalFeesETH: factory.totalFeesETH.plus(feesETH),
      totalFeesUSD: factory.totalFeesUSD.plus(feesUSD),
      totalValueLockedETH: factory.totalValueLockedETH.minus(currentPoolTvlETH),
    };

    pool = {
      ...pool,
      txCount: pool.txCount + ONE_BI,
      volumeToken0: pool.volumeToken0.plus(amount0Abs),
      volumeToken1: pool.volumeToken1.plus(amount1Abs),
      volumeUSD: pool.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
      feesUSD: pool.feesUSD.plus(feesUSD),
      liquidity: event.params.liquidity,
      tick: event.params.tick,
      sqrtPrice: event.params.sqrtPriceX96,
      totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
      totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
    };

    token0 = {
      ...token0,
      volume: token0.volume.plus(amount0Abs),
      totalValueLocked: token0.totalValueLocked.plus(amount0),
      volumeUSD: token0.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token0.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      feesUSD: token0.feesUSD.plus(feesUSD),
      txCount: token0.txCount + ONE_BI,
    };

    token1 = {
      ...token1,
      volume: token1.volume.plus(amount1Abs),
      totalValueLocked: token1.totalValueLocked.plus(amount1),
      volumeUSD: token1.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token1.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      feesUSD: token1.feesUSD.plus(feesUSD),
      txCount: token1.txCount + ONE_BI,
    };

    // updated pool ratess
    const prices = sqrtPriceX96ToTokenPrices(pool.sqrtPrice, token0, token1);

    pool = {
      ...pool,
      token0Price: prices[0],
      token1Price: prices[1],
    };

    context.Pool.set(pool);

    let stablecoinWrappedNativePool = await context.Pool.get(
      stablecoinWrappedNativePoolAddress
    );

    bundle = {
      ...bundle,
      ethPriceUSD: getNativePriceInUSD(
        stablecoinIsToken0,
        stablecoinWrappedNativePool
      ),
    };

    context.Bundle.set(bundle);

    const [token0DerivedEth, token1DerivedEth, transaction] = await Promise.all(
      [
        findNativePerToken(
          token0,
          wrappedNativeAddress,
          stablecoinAddresses,
          minimumNativeLocked,
          bundle,
          context
        ),
        findNativePerToken(
          token1,
          wrappedNativeAddress,
          stablecoinAddresses,
          minimumNativeLocked,
          bundle,
          context
        ),
        loadTransaction(
          event.transactionHash,
          event.blockNumber,
          event.blockTimestamp,
          context
        ),
      ]
    );

    token0 = {
      ...token0,
      derivedETH: token0DerivedEth,
    };

    token1 = {
      ...token1,
      derivedETH: token1DerivedEth,
    };

    /**
     * Things afffected by new USD rates
     */
    pool = {
      ...pool,
      totalValueLockedETH: pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
    };

    pool = {
      ...pool,
      totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
    };

    factory = {
      ...factory,
      totalValueLockedETH: factory.totalValueLockedETH.plus(
        pool.totalValueLockedETH
      ),
    };

    factory = {
      ...factory,
      totalValueLockedUSD: factory.totalValueLockedETH.times(
        bundle.ethPriceUSD
      ),
    };

    token0 = {
      ...token0,
      totalValueLockedUSD: token0.totalValueLocked
        .times(token0.derivedETH)
        .times(bundle.ethPriceUSD),
    };

    token1 = {
      ...token1,
      totalValueLockedUSD: token1.totalValueLocked
        .times(token1.derivedETH)
        .times(bundle.ethPriceUSD),
    };

    if (!pool.token0_id || !pool.token1_id) {
      return context.log.error(`Pool Tokens ID's not found in Swap Event`);
    }

    // create Swap event
    let swap: SwapEntity = {
      id: transaction.id + "-" + event.logIndex.toString(),
      transaction_id: transaction.id,
      timestamp: BigInt(transaction.timestamp),
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      sender: event.params.sender,
      origin: event.txOrigin,
      recipient: event.params.recipient,
      amount0: amount0,
      amount1: amount1,
      amountUSD: amountTotalUSDTracked,
      tick: event.params.tick,
      sqrtPriceX96: event.params.sqrtPriceX96,
      logIndex: event.logIndex,
    };

    // interval data
    const dayID = getDayID(event.blockTimestamp);
    const dayPoolID = pool.id.concat("-").concat(dayID.toString());
    const hourIndex = getHourIndex(event.blockTimestamp); // get unique hour within unix history
    const hourPoolID = pool.id.concat("-").concat(hourIndex.toString());
    const tokenDayID0 = token0.id.concat("-").concat(dayID.toString());
    const tokenDayID1 = token1.id.concat("-").concat(dayID.toString());
    const tokenHourID0 = token0.id.concat("-").concat(hourIndex.toString());
    const tokenHourID1 = token1.id.concat("-").concat(hourIndex.toString());

    let [
      _uniswapDayData,
      _poolDayData,
      _poolHourData,
      tokenDayData0,
      tokenDayData1,
      tokenHourData0,
      tokenHourData1,
    ] = await Promise.all([
      context.UniswapDayData.get(dayID.toString()),
      context.PoolDayData.get(dayPoolID),
      context.PoolHourData.get(hourPoolID),
      context.TokenDayData.get(tokenDayID0),
      context.TokenDayData.get(tokenDayID1),
      context.TokenHourData.get(tokenHourID0),
      context.TokenHourData.get(tokenHourID1),
    ]);

    let uniswapDayData = updateUniswapDayData(
      dayID,
      factory,
      _uniswapDayData,
      context
    );
    let poolDayData = updatePoolDayData(dayID, pool, _poolDayData, context);
    let poolHourData = updatePoolHourData(
      event.blockTimestamp,
      pool,
      _poolHourData,
      context
    );
    let token0DayData = updateTokenDayData(
      token0,
      bundle,
      dayID,
      tokenDayData0,
      context
    );
    let token1DayData = updateTokenDayData(
      token1,
      bundle,
      dayID,
      tokenDayData1,
      context
    );
    let token0HourData = updateTokenHourData(
      token0,
      bundle,
      event.blockTimestamp,
      tokenHourData0,
      context
    );
    let token1HourData = updateTokenHourData(
      token1,
      bundle,
      event.blockTimestamp,
      tokenHourData1,
      context
    );

    // update volume metrics
    uniswapDayData = {
      ...uniswapDayData,
      volumeETH: uniswapDayData.volumeETH.plus(amountTotalETHTracked),
      volumeUSD: uniswapDayData.volumeUSD.plus(amountTotalUSDTracked),
      feesUSD: uniswapDayData.feesUSD.plus(feesUSD),
    };

    poolDayData = {
      ...poolDayData,
      volumeUSD: poolDayData.volumeUSD.plus(amountTotalUSDTracked),
      volumeToken0: poolDayData.volumeToken0.plus(amount0Abs),
      volumeToken1: poolDayData.volumeToken1.plus(amount1Abs),
      feesUSD: poolDayData.feesUSD.plus(feesUSD),
    };

    poolHourData = {
      ...poolHourData,
      volumeUSD: poolHourData.volumeUSD.plus(amountTotalUSDTracked),
      volumeToken0: poolHourData.volumeToken0.plus(amount0Abs),
      volumeToken1: poolHourData.volumeToken1.plus(amount1Abs),
      feesUSD: poolHourData.feesUSD.plus(feesUSD),
    };

    token0DayData = {
      ...token0DayData,
      volume: token0DayData.volume.plus(amount0Abs),
      volumeUSD: token0DayData.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token0DayData.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      feesUSD: token0DayData.feesUSD.plus(feesUSD),
    };

    token0HourData = {
      ...token0HourData,
      volume: token0HourData.volume.plus(amount0Abs),
      volumeUSD: token0HourData.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token0HourData.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ), // Check this isnt supposed to be amountTotalUSDTracked as is below
      feesUSD: token0HourData.feesUSD.plus(feesUSD),
    };

    // WAS THIS A BUG???? ITS ADDING USDTRACK to the untrackedVolumeUSD
    // token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(
    //   amountTotalUSDTracked
    // );

    token1DayData = {
      ...token1DayData,
      volume: token1DayData.volume.plus(amount1Abs),
      volumeUSD: token1DayData.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token1DayData.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ), // Check this isnt supposed to be amountTotalUSDTracked as is below
      feesUSD: token1DayData.feesUSD.plus(feesUSD),
    };

    // WAS THIS A BUG???? ITS ADDING USDTRACK to the untrackedVolumeUSD
    // token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(
    //   amountTotalUSDTracked
    // );

    token1HourData = {
      ...token1HourData,
      volume: token1HourData.volume.plus(amount1Abs),
      volumeUSD: token1HourData.volumeUSD.plus(amountTotalUSDTracked),
      untrackedVolumeUSD: token1HourData.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ), // Check this isnt supposed to be amountTotalUSDTracked as is below
      feesUSD: token1HourData.feesUSD.plus(feesUSD),
    };

    // WAS THIS A BUG???? ITS ADDING USDTRACK to the untrackedVolumeUSD
    // token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(
    //   amountTotalUSDTracked
    // );

    context.Swap.set(swap);
    context.TokenDayData.set(token0DayData);
    context.TokenDayData.set(token1DayData);
    context.UniswapDayData.set(uniswapDayData);
    context.PoolDayData.set(poolDayData);
    context.PoolHourData.set(poolHourData);
    context.TokenHourData.set(token0HourData);
    context.TokenHourData.set(token1HourData);
    context.PoolHourData.set(poolHourData);
    context.Factory.set(factory);
    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
  }
});
