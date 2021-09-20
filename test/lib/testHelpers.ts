import { BigNumber as EBigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber } from 'bignumber.js';
import cloneDeep from 'lodash.clonedeep';
import * as sorv2 from '../../src';
import {
    SubgraphPoolBase,
    Swap,
    PoolDictionary,
    SwapPairType,
    SwapTypes,
    SwapInfo,
    PoolFilter,
    SwapV2,
} from '../../src/types';
import { bnum } from '../../src/utils/bignumber';
import * as fs from 'fs';
import { assert } from 'chai';
// Mainnet reference tokens with addresses & decimals
import WeightedTokens from '../testData/eligibleTokens.json';
import StableTokens from '../testData/stableTokens.json';
import { WeiPerEther as ONE } from '@ethersproject/constants';

export interface TradeInfo {
    SwapType: string;
    TokenIn: string;
    TokenOut: string;
    NoPools: number;
    SwapAmount: EBigNumber;
    GasPrice: EBigNumber;
    SwapAmountDecimals: number;
    ReturnAmountDecimals: number;
}

export interface TestData {
    pools: SubgraphPoolBase[];
    tradeInfo: TradeInfo;
    v1Result: ResultParsed;
}

export interface Result {
    title: string;
    timeData: TimeData;
    returnAmount: BigNumber;
    swaps: SwapV2[] | Swap[][];
}

interface TimeData {
    fullSwap: number;
}

export interface ResultParsed {
    title: string;
    timeData: TimeData;
    returnAmount: string;
    swaps: Swap[][];
}

// Filters for only pools with balance and returns token list too.
export function filterPoolsAndTokens(
    allPools: SubgraphPoolBase[]
): [Set<unknown>, SubgraphPoolBase[]] {
    const allTokens: string[][] = [];
    let allTokensSet = new Set();
    const allPoolsNonZeroBalances: SubgraphPoolBase[] = [];

    for (const pool of allPools) {
        // Build list of non-zero balance pools
        // Only check first balance since AFAIK either all balances are zero or none are:
        if (pool.tokens.length != 0) {
            if (pool.tokens[0].balance != '0') {
                const tokens: string[] = [];
                pool.tokensList.forEach((token) => {
                    tokens.push(token);
                });

                if (tokens.length > 1) {
                    allTokens.push(tokens.sort()); // Will add without duplicate
                }

                allPoolsNonZeroBalances.push(pool);
            }
        }
    }

    allTokensSet = new Set(
        Array.from(new Set(allTokens.map((a) => JSON.stringify(a))), (json) =>
            JSON.parse(json)
        )
    );

    return [allTokensSet, allPoolsNonZeroBalances];
}

export function loadTestFile(File: string): TestData {
    const fileString = fs.readFileSync(File, 'utf8');
    const fileJson = JSON.parse(fileString);
    if (!fileJson.tradeInfo) return fileJson;

    fileJson.tradeInfo.GasPrice = EBigNumber.from(fileJson.tradeInfo.GasPrice);
    fileJson.tradeInfo.SwapAmount = EBigNumber.from(
        fileJson.tradeInfo.SwapAmount.split('.')[0] // This is getting rid of decimals that shouldn't be there.
    );
    return fileJson;
}

export function displayResults(
    TestTitle: string,
    TradeInfo: TradeInfo,
    Results: Result[],
    Verbose: boolean,
    MaxPools: number
): void {
    let symbolIn, symbolOut;
    const allTokens = WeightedTokens;
    Object.assign(allTokens, StableTokens);
    const symbols = Object.keys(allTokens);
    symbols.forEach((symbol) => {
        if (
            allTokens[symbol].address.toLowerCase() ===
            TradeInfo.TokenIn.toLowerCase()
        )
            symbolIn = symbol;

        if (
            allTokens[symbol].address.toLowerCase() ===
            TradeInfo.TokenOut.toLowerCase()
        )
            symbolOut = symbol;
    });
    console.log(`Pools From File: ${TestTitle}`);
    console.log(`In: ${symbolIn} ${TradeInfo.TokenIn.toLowerCase()}`);
    console.log(`Out: ${symbolOut} ${TradeInfo.TokenOut.toLowerCase()}`);
    console.log(`Swap Amt: ${TradeInfo.SwapAmount.toString()}`);
    console.log(`Max Pools: ${MaxPools}`);
    console.log(TradeInfo.SwapType);

    const tableData: {
        SOR: string;
        'Full SOR Time': number;
        'Return Amt': string;
    }[] = [];
    Results.forEach((result) => {
        tableData.push({
            SOR: result.title,
            'Full SOR Time': result.timeData.fullSwap,
            'Return Amt': result.returnAmount.toString(),
        });
    });

    console.table(tableData);

    if (Verbose) {
        Results.forEach((result) => {
            console.log(`${result.title} Swaps: `);
            console.log(result.swaps);
        });
    }
}

export function assertResults(
    testName: string,
    testData: TestData,
    v1SwapData: Result,
    swapInfo: SwapInfo
): void {
    let swapTypeCorrect = SwapTypes.SwapExactIn;
    if (testData.tradeInfo.SwapType !== 'swapExactIn') {
        swapTypeCorrect = SwapTypes.SwapExactOut;
    }

    testReturnAmountAgainstV1(testName, swapTypeCorrect, v1SwapData, swapInfo);

    testSwapAmounts(swapTypeCorrect, testData, swapInfo);

    testSwapAmountsForDecimals(swapTypeCorrect, swapInfo);
}

/*
Test that current result is within V1 result.
*/
function testReturnAmountAgainstV1(
    testName: string,
    swapType: SwapTypes,
    v1SwapData: Result,
    swapInfo: SwapInfo
): void {
    const relDiffBn = calcRelativeDiffBn(
        swapInfo.returnAmount,
        v1SwapData.returnAmount
    );
    const errorDelta = 10 ** -6;

    if (swapType === SwapTypes.SwapExactIn) {
        // Current result should be better or equal to V1 result or within errorDelta
        if (!swapInfo.returnAmount.gte(v1SwapData.returnAmount)) {
            assert.isAtMost(relDiffBn.toNumber(), errorDelta);
            console.log(
                `!!!!!! V2 < V1 but error delta ok. (${relDiffBn.toString()})`
            );
        }
    } else {
        if (swapInfo.returnAmount.eq(0))
            assert(
                v1SwapData.returnAmount.eq(0),
                `File: ${testName}, V2 Should Not Have 0 Swap If V1 > 0.`
            );

        if (v1SwapData.returnAmount.eq(0) && swapInfo.returnAmount.gt(0)) {
            console.log(`!!!!!! V1 has no swap but V2 has.`);
            return;
        }

        // Current result should be less than or equal to V1 result or within errorDelta
        if (!swapInfo.returnAmount.lte(v1SwapData.returnAmount)) {
            assert.isAtMost(relDiffBn.toNumber(), errorDelta);
            console.log(
                `!!!!!! V2 > V1 but error delta ok. (${relDiffBn.toString()})`
            );
        }
    }
}

/*
Make sure swapInfo swap amount is correct.
Should be 0 when return amount is 0.
Should equal test data amount when return amount > 0.
All swap amounts for swap type should equal test data amount.
*/
function testSwapAmounts(
    swapType: SwapTypes,
    testData: TestData,
    swapInfo: SwapInfo
): void {
    if (swapInfo.returnAmount.gt(0)) {
        // This should be to Scaled format
        assert.equal(
            testData.tradeInfo.SwapAmount.toString(),
            swapInfo.swapAmount.toString(),
            'Swap Amounts Should Be Equal.'
        );

        const totalSwapAmount = getTotalSwapAmount(swapType, swapInfo);
        assert.equal(
            testData.tradeInfo.SwapAmount.toString(),
            totalSwapAmount.toString(),
            'Total From SwapInfo Should Equal Swap Amount.'
        );
    } else
        assert.equal(
            '0',
            swapInfo.swapAmount.toString(),
            'Swap Amount Should Be 0 For No Swaps'
        );
}

/*
Tests to make sure swap amounts are whole numbers.
*/
function testSwapAmountsForDecimals(
    swapType: SwapTypes,
    swapInfo: SwapInfo
): void {
    swapInfo.swaps.forEach((swap) => {
        if (swapType === SwapTypes.SwapExactIn) {
            const check = swap.amount.split('.');
            assert.isTrue(
                check.length === 1,
                `Swap Amounts Should Not Have Decimal: ${swap.amount.toString()}`
            );
        } else {
            const check = swap.amount.split('.');
            assert.isTrue(
                check.length === 1,
                `Swap Amounts Should Not Have Decimal: ${swap.amount.toString()}`
            );
        }
    });
}

// Helper to sum all amounts traded by swaps
function getTotalSwapAmount(
    swapType: SwapTypes,
    swapInfo: SwapInfo
): BigNumber {
    let total = bnum(0);
    const inIndex = swapInfo.tokenAddresses.indexOf(swapInfo.tokenIn);
    const outIndex = swapInfo.tokenAddresses.indexOf(swapInfo.tokenOut);

    swapInfo.swaps.forEach((swap) => {
        if (swapType === SwapTypes.SwapExactIn) {
            if (swap.assetInIndex === inIndex) total = total.plus(swap.amount);
        } else {
            if (swap.assetOutIndex === outIndex)
                total = total.plus(swap.amount);
        }
    });
    return total;
}

export function calcRelativeDiffBn(
    expected: BigNumber,
    actual: BigNumber
): BigNumber {
    return expected.minus(actual).div(expected).abs();
}

export function countPoolSwapPairTypes(
    poolsOfInterestDictionary: PoolDictionary
): [number, number, number] {
    let noDirect = 0,
        noHopIn = 0,
        noHopOut = 0;
    for (const k in poolsOfInterestDictionary) {
        if (poolsOfInterestDictionary[k].swapPairType === SwapPairType.Direct)
            noDirect++;
        else if (
            poolsOfInterestDictionary[k].swapPairType === SwapPairType.HopIn
        )
            noHopIn++;
        else if (
            poolsOfInterestDictionary[k].swapPairType === SwapPairType.HopOut
        )
            noHopOut++;
    }

    return [noDirect, noHopIn, noHopOut];
}

export async function getFullSwap(
    pools: SubgraphPoolBase[],
    tokenIn: string,
    tokenOut: string,
    returnAmountDecimals: number,
    maxPools: number,
    swapType: string | SwapTypes,
    swapAmount: EBigNumber,
    costOutputToken: EBigNumber,
    gasPrice: EBigNumber,
    provider: JsonRpcProvider,
    swapGas: EBigNumber = EBigNumber.from('100000')
): Promise<SwapInfo> {
    const sor = new sorv2.SOR(provider, 1, null, cloneDeep(pools));

    let swapTypeCorrect = SwapTypes.SwapExactIn;

    sor.swapCostCalculator.setTokenDecimals(
        swapType === 'swapExactIn' ? tokenOut : tokenIn,
        returnAmountDecimals
    );

    // We're wanting to set the value of costOutputToken so we calculate
    // a native asset price which will give the desired value
    const effectiveNativeAssetPrice =
        gasPrice.gt(0) && swapGas.gt(0)
            ? costOutputToken.div(gasPrice).div(swapGas).div(ONE).toString()
            : '0';
    if (swapType === 'swapExactIn')
        await sor.swapCostCalculator.setNativeAssetPriceInToken(
            tokenOut,
            effectiveNativeAssetPrice
        );
    else {
        swapTypeCorrect = SwapTypes.SwapExactOut;
        await sor.swapCostCalculator.setNativeAssetPriceInToken(
            tokenIn,
            effectiveNativeAssetPrice
        );
    }

    const isFetched = await sor.fetchPools([], false);
    assert(isFetched, 'Pools should be fetched in wrapper');

    const swapInfo: SwapInfo = await sor.getSwaps(
        tokenIn,
        tokenOut,
        swapTypeCorrect,
        swapAmount,
        { gasPrice, maxPools, timestamp: 0, poolTypeFilter: PoolFilter.All }
    );

    return swapInfo;
}

export function parseV1Result(v1ResultParsed: ResultParsed): Result {
    if (!v1ResultParsed.returnAmount) {
        return {
            title: 'N/A',
            timeData: { fullSwap: 0 },
            returnAmount: bnum(0),
            swaps: [] as SwapV2[],
        };
    }

    return {
        title: v1ResultParsed.title,
        timeData: v1ResultParsed.timeData,
        returnAmount: bnum(v1ResultParsed.returnAmount),
        swaps: v1ResultParsed.swaps,
    };
}
