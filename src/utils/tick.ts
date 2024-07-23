import {
  BigDecimal,
  TickEntity,
  CLPoolContract_MintEvent_eventArgs,
  eventLog,
} from "generated";
import { bigDecimalExponated, fastExponentiation, safeDiv } from ".";
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
  // const price0 = BigDecimal("1.0001")
  //   .pow(BigDecimal(tickIdx.toString()))
  //   .decimalPlaces(18);

  // let price0 = bigDecimalExponated(BigDecimal("1.0001"), tickIdx);

  const price0 = BigDecimal(
    fastExponentiation(1.0001, parseInt(tickIdx.toString()))
  );

  const price1 = safeDiv(ONE_BD, price0).decimalPlaces(18);

  tick = {
    ...tick,
    price0,
    price1,
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
