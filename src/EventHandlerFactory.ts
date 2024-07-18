import { PoolEntity, CLFactoryContract } from "generated";
import { getSubgraphConfig, SubgraphConfig } from "./utils/chains";
import {
  fetchTokenDecimals,
  fetchTokenName,
  fetchTokenSymbol,
  fetchTokenTotalSupply,
} from "./utils/token";
import {
  ADDRESS_ZERO,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
  BASE_FACTORY_CONTRACT,
  BASE_MAINNET_ID,
  ETH_MAINNET_ID,
  poolsToSkip,
} from "./utils/constants";
import { publicClients } from "./utils/viem";
import { poolAbi } from "./utils/abis";
import { findNativePerToken } from "./utils/pricing";

CLFactoryContract.PoolCreated.loader(({ event, context }) => {
  // context.Factory.load(BASE_FACTORY_CONTRACT);
  context.contractRegistration.addCLPool(event.params.pool);
});

CLFactoryContract.PoolCreated.handlerAsync(async ({ event, context }) => {
  context.log.info("Starting a Factory Pool Add");
  const subgraphConfig = getSubgraphConfig(event.chainId);
  const whitelistTokens = subgraphConfig.whitelistTokens;
  const tokenOverrides = subgraphConfig.tokenOverrides;
  const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress;
  const stablecoinAddresses = subgraphConfig.stablecoinAddresses;
  const minimumNativeLocked = subgraphConfig.minimumNativeLocked;

  // load factory
  let [factory, bundle] = await Promise.all([
    context.Factory.get(event.srcAddress),
    context.Bundle.get(event.chainId.toString()),
  ]);

  if (!factory) {
    context.log.info(`Theres no factory`);

    factory = {
      id: event.srcAddress,
      poolCount: ZERO_BI,
      totalVolumeETH: ZERO_BD,
      totalVolumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      totalFeesUSD: ZERO_BD,
      totalFeesETH: ZERO_BD,
      totalValueLockedETH: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      totalValueLockedETHUntracked: ZERO_BD,
      txCount: ZERO_BI,
      owner: ADDRESS_ZERO,
    };
  }

  if (!bundle) {
    // create new bundle for tracking eth price
    bundle = {
      id: event.chainId.toString(),
      ethPriceUSD: ZERO_BD,
    };

    context.Bundle.set(bundle);
  }

  factory = {
    ...factory,
    poolCount: factory.poolCount + ONE_BI,
  };

  const [feeTier, tickSpacing] = await Promise.all([
    publicClients[event.chainId as keyof typeof publicClients].readContract({
      address: event.params.pool as `0x${string}`,
      abi: poolAbi,
      functionName: "fee",
    }),
    publicClients[event.chainId as keyof typeof publicClients].readContract({
      address: event.params.pool as `0x${string}`,
      abi: poolAbi,
      functionName: "tickSpacing",
    }),
  ]);

  context.log.info(
    `About to Call tickSpacing for address ${event.params.pool}`
  );

  context.log.info(
    `TickSpacing is ${tickSpacing} for Pool ${event.params.pool}`
  );

  let pool: PoolEntity = {
    id: event.params.pool,
    token0_id: event.params.token0,
    token1_id: event.params.token1,
    feeTier: feeTier as bigint,
    tickSpacing: tickSpacing as bigint,
    createdAtTimestamp: event.blockTimestamp,
    createdAtBlockNumber: event.blockNumber,
    liquidityProviderCount: ZERO_BI,
    txCount: ZERO_BI,
    liquidity: ZERO_BI,
    sqrtPrice: ZERO_BI,
    token0Price: ZERO_BD,
    token1Price: ZERO_BD,
    observationIndex: ZERO_BI,
    totalValueLockedToken0: ZERO_BD,
    totalValueLockedToken1: ZERO_BD,
    totalValueLockedUSD: ZERO_BD,
    totalValueLockedETH: ZERO_BD,
    totalValueLockedUSDUntracked: ZERO_BD,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    collectedFeesUSD: ZERO_BD,
    tick: undefined,
  };

  let [token0, token1] = await Promise.all([
    context.Token.get(event.params.token0),
    context.Token.get(event.params.token1),
  ]);

  // fetch info if null
  if (!token0) {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      fetchTokenDecimals(
        event.params.token0,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenSymbol(
        event.params.token0,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenName(
        event.params.token0,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenTotalSupply(
        event.params.token0,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
    ]);

    // bail if we couldn't figure out the decimals
    if (!decimals) {
      context.log.debug("mybug the decimal on token 0 was null");
      return;
    }

    token0 = {
      id: event.params.token0,
      symbol,
      name,
      totalSupply,
      decimals,
      derivedETH: ZERO_BD,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      txCount: ZERO_BI,
      poolCount: ZERO_BI,
      whitelistPools: [],
    };
  }

  if (!token1) {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      fetchTokenDecimals(
        event.params.token1,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenSymbol(
        event.params.token1,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenName(
        event.params.token1,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
      fetchTokenTotalSupply(
        event.params.token1,
        tokenOverrides,
        event.chainId as keyof typeof publicClients
      ),
    ]);

    // bail if we couldn't figure out the decimals
    if (!decimals) {
      context.log.debug("mybug the decimal on token 1 was null");
      return;
    }

    token1 = {
      id: event.params.token1,
      symbol,
      name,
      totalSupply,
      decimals,
      derivedETH: ZERO_BD,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      txCount: ZERO_BI,
      poolCount: ZERO_BI,
      whitelistPools: [],
    };
  }

  // update white listed pools
  if (whitelistTokens.includes(token0.id)) {
    const newPools = token1.whitelistPools;
    newPools.push(pool.id);
    token1 = {
      ...token1,
      whitelistPools: newPools,
    };
  }
  if (whitelistTokens.includes(token1.id)) {
    const newPools = token0.whitelistPools;
    newPools.push(pool.id);
    token0 = {
      ...token0,
      whitelistPools: newPools,
    };
  }

  context.Pool.set(pool);
  context.Token.set(token0);
  context.Token.set(token1);
  context.Factory.set(factory);

  // update token prices
  if (token0 && token1) {
    let [token0DerivedEth, token1DerivedEth] = await Promise.all([
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
    ]);

    token0 = {
      ...token0,
      derivedETH: token0DerivedEth,
    };

    token1 = {
      ...token1,
      derivedETH: token1DerivedEth,
    };

    context.Token.set(token0);
    context.Token.set(token1);
  }
});
