import {
  BigDecimal,
  TransactionEntity,
  CLPoolContract_BurnEvent_handlerContextAsync,
  CLPoolContract_CollectEvent_handlerContextAsync,
  CLPoolContract_MintEvent_handlerContextAsync,
  CLPoolContract_SwapEvent_handlerContextAsync,
} from "generated";
import {
  BASE_FACTORY_CONTRACT,
  ONE_BD,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
} from "../utils/constants";

export function getFactoryAddress(chainId: number) {
  return BASE_FACTORY_CONTRACT;
}

export function exponentToBigDecimal(decimals: number): BigDecimal {
  let resultString = "1";

  for (let i = 0; i < decimals; i++) {
    resultString += "0";
  }

  return BigDecimal(resultString);
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.isEqualTo(ZERO_BD)) {
    return ZERO_BD;
  } else {
    return amount0.div(amount1);
  }
}

/**
 * Implements exponentiation by squaring
 * (see https://en.wikipedia.org/wiki/Exponentiation_by_squaring )
 * to minimize the number of BigDecimal operations and their impact on performance.
 */
export function fastExponentiation(
  value: BigDecimal,
  power: BigDecimal
): BigDecimal {
  console.log(
    `Starting fastExponentiation... Value: ${value}, Power: ${power}`
  );
  if (power.lt(BigDecimal(0))) {
    console.log(`Power Below 0`);
    const result = fastExponentiation(value, power.absoluteValue());
    console.log(`Power Below 0... Result = ${result}`);
    // console.log(`Power Below 0... About to return = ${safeDiv(ONE_BD, result)}`);
    console.log(`Power Below 0... About to return`);
    return safeDiv(ONE_BD, result);
  }

  if (power.eq(BigDecimal(0))) {
    console.log(`fastExponentiation.. power = 0 about to return ONE_BD`);
    return ONE_BD;
  }

  if (power.eq(BigDecimal(1))) {
    console.log(`fastExponentiation.. power = 1 about to return value`);
    return value;
  }

  const halfPower = power.div(2);
  const halfResult = fastExponentiation(value, halfPower.decimalPlaces(18));

  // Use the fact that x ^ (2n) = (x ^ n) * (x ^ n) and we can compute (x ^ n) only once.
  let result = halfResult
    .decimalPlaces(18)
    .times(halfResult.decimalPlaces(18))
    .decimalPlaces(18);

  console.log(`fastExponentiation.. Result = ${result}`);

  // For odd powers, x ^ (2n + 1) = (x ^ 2n) * x
  if (power.mod(BigDecimal(2)).eq(BigDecimal(1))) {
    result = result.decimalPlaces(18).times(value.decimalPlaces(18));
  }

  console.log(`fastExponentiation End: ${result.decimalPlaces(18)}`);
  return result.decimalPlaces(18);
}

export function bigDecimalExponated(
  value: BigDecimal,
  power: bigint
): BigDecimal {
  if (power == ZERO_BI) {
    return ONE_BD;
  }
  let negativePower = power < ZERO_BI;
  let result = ZERO_BD.plus(value);
  let powerAbs = power < 0n ? -power : power;
  for (let i = ONE_BI; i < powerAbs; i = i + ONE_BI) {
    result = result.times(value);
  }

  if (negativePower) {
    result = safeDiv(ONE_BD, result);
  }

  return result;
}

export function tokenAmountToDecimal(
  tokenAmount: BigInt,
  exchangeDecimals: number
): BigDecimal {
  if (exchangeDecimals == 0) {
    return BigDecimal(tokenAmount.toString());
  }
  return BigDecimal(tokenAmount.toString()).div(
    exponentToBigDecimal(exchangeDecimals)
  );
}

export function priceToDecimal(
  amount: BigDecimal,
  exchangeDecimals: number
): BigDecimal {
  if (exchangeDecimals == 0) {
    return amount;
  }
  return safeDiv(amount, exponentToBigDecimal(exchangeDecimals));
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString());
  const zero = parseFloat(ZERO_BD.toString());
  if (zero == formattedVal) {
    return true;
  }
  return false;
}

export const NULL_ETH_HEX_STRING =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export function isNullEthValue(value: string): boolean {
  return value == NULL_ETH_HEX_STRING;
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal("1000000000000000000");
}

export function convertTokenToDecimal(
  tokenAmount: BigInt,
  exchangeDecimals: number
): BigDecimal {
  if (exchangeDecimals == 0) {
    return BigDecimal(tokenAmount.toString());
  }
  return BigDecimal(tokenAmount.toString()).div(
    exponentToBigDecimal(exchangeDecimals)
  );
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  return BigDecimal(eth.toString()).div(exponentToBigDecimal(18));
}

export async function loadTransaction(
  transactionHash: string,
  blockNumber: number,
  timestamp: number,
  context:
    | CLPoolContract_BurnEvent_handlerContextAsync
    | CLPoolContract_CollectEvent_handlerContextAsync
    | CLPoolContract_MintEvent_handlerContextAsync
    | CLPoolContract_SwapEvent_handlerContextAsync
): Promise<TransactionEntity> {
  let transaction = await context.Transaction.get(transactionHash);
  if (!transaction) {
    transaction = {
      id: transactionHash,
      blockNumber: blockNumber,
      timestamp: timestamp,
      gasUsed: ZERO_BI, // needs to be moved to transaction receipt
      gasPrice: ZERO_BI, // We don't get gas price from indexer
    };
  }

  transaction = {
    ...transaction,
    blockNumber: blockNumber,
    timestamp: timestamp,
    gasUsed: ZERO_BI, //needs to be moved to transaction receipt
    gasPrice: ZERO_BI,
  };

  context.Transaction.set(transaction);

  return transaction;
}
