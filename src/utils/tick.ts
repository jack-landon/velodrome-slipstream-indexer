import {
  BigDecimal,
  TickEntity,
  CLPoolContract_MintEvent_eventArgs,
  eventLog,
} from "generated";
import { fastExponentiation, safeDiv } from ".";
import { ONE_BD, ZERO_BI } from "./constants";

export function createTick(
  tickId: string,
  tickIdx: bigint,
  poolId: string,
  timestamp: number,
  blockNumber: number
): TickEntity {
  let tick: TickEntity = {
    id: tickId,
    tickIdx: tickIdx,
    pool_id: poolId,
    poolAddress: poolId,
    createdAtTimestamp: timestamp,
    createdAtBlockNumber: blockNumber,
    liquidityGross: ZERO_BI,
    liquidityNet: ZERO_BI,
    price0: ONE_BD,
    price1: ONE_BD,
  };

  // 1.0001^tick is token1/token0.
  const price0 = fastExponentiation(
    BigDecimal("1.0001"),
    parseInt(tickIdx.toString())
  );

  tick = {
    ...tick,
    price0: price0,
    price1: safeDiv(ONE_BD, price0),
  };

  return tick;
}

export function feeTierToTickSpacing(feeTier: BigInt): BigInt {
  if (feeTier === BigInt(10000)) {
    return BigInt(200);
  }
  if (feeTier === BigInt(3000)) {
    return BigInt(60);
  }
  if (feeTier === BigInt(500)) {
    return BigInt(10);
  }
  if (feeTier === BigInt(100)) {
    return BigInt(1);
  }

  throw Error("Unexpected fee tier");
}
