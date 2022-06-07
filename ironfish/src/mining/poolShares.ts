/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Config } from '../fileStores/config'
import { Logger } from '../logger'
import { IronfishRpcClient } from '../rpc/clients/rpcClient'
import { ErrorUtils } from '../utils'
import { BigIntUtils } from '../utils/bigint'
import { MapUtils } from '../utils/map'
import { SetTimeoutToken } from '../utils/types'
import { Discord } from './discord'
import { Lark } from './lark'
import { DatabaseShare, PoolDatabase } from './poolDatabase'

export class MiningPoolShares {
  readonly rpc: IronfishRpcClient
  readonly config: Config
  readonly logger: Logger
  readonly discord: Discord | null
  readonly lark: Lark | null

  private readonly db: PoolDatabase
  private enablePayouts: boolean
  private payoutInterval: SetTimeoutToken | null

  private poolName: string
  private recentShareCutoff: number
  private attemptPayoutInterval: number
  private accountName: string
  private balancePercentPayout: bigint
  private balancePercentPayoutFlag: number | undefined
  private payoutExpirationSequenceDelta: number

  private constructor(options: {
    db: PoolDatabase
    rpc: IronfishRpcClient
    config: Config
    logger: Logger
    discord?: Discord
    lark?: Lark
    enablePayouts?: boolean
    balancePercentPayoutFlag?: number
  }) {
    this.db = options.db
    this.rpc = options.rpc
    this.config = options.config
    this.logger = options.logger
    this.discord = options.discord ?? null
    this.lark = options.lark ?? null
    this.enablePayouts = options.enablePayouts ?? true

    this.poolName = this.config.get('poolName')
    this.recentShareCutoff = this.config.get('poolRecentShareCutoff')
    this.attemptPayoutInterval = this.config.get('poolAttemptPayoutInterval')
    this.accountName = this.config.get('poolAccountName')
    this.balancePercentPayout = BigInt(this.config.get('poolBalancePercentPayout'))
    this.balancePercentPayoutFlag = options.balancePercentPayoutFlag
    this.payoutExpirationSequenceDelta = this.config.get('poolPayoutExpirationSequenceDelta')

    this.payoutInterval = null
  }

  static async init(options: {
    rpc: IronfishRpcClient
    config: Config
    logger: Logger
    discord?: Discord
    lark?: Lark
    enablePayouts?: boolean
    balancePercentPayoutFlag?: number
  }): Promise<MiningPoolShares> {
    const db = await PoolDatabase.init({
      config: options.config,
      logger: options.logger,
    })

    return new MiningPoolShares({
      db,
      rpc: options.rpc,
      config: options.config,
      logger: options.logger,
      discord: options.discord,
      lark: options.lark,
      enablePayouts: options.enablePayouts,
      balancePercentPayoutFlag: options.balancePercentPayoutFlag,
    })
  }

  async start(): Promise<void> {
    if (this.enablePayouts) {
      this.startPayoutInterval()
    }
    await this.db.start()
  }

  async stop(): Promise<void> {
    this.stopPayoutInterval()
    await this.db.stop()
  }

  async submitShare(publicAddress: string): Promise<void> {
    await this.db.newShare(publicAddress)
  }

  async createPayout(): Promise<void> {
    // TODO: Make a max payout amount per transaction
    //   - its currently possible to have a payout include so many inputs that it expires before it
    //     gets added to the mempool. suspect this would cause issues elsewhere
    //  As a simple stop-gap, we could probably make payout interval = every x hours OR if confirmed balance > 200 or something
    //  OR we could combine them, every x minutes, pay 10 inputs into 1 output?

    // Since timestamps have a 1 second granularity, make the cutoff 1 second ago, just to avoid potential issues
    const shareCutoff = new Date()
    shareCutoff.setSeconds(shareCutoff.getSeconds() - 1)
    const timestamp = Math.floor(shareCutoff.getTime() / 1000)

    // Create a payout in the DB as a form of a lock
    const payoutId = await this.db.newPayout(timestamp)
    if (payoutId == null) {
      this.logger.info(
        'Another payout may be in progress or a payout was made too recently, skipping.',
      )
      return
    }

    const shares = await this.db.getSharesForPayout(timestamp)
    const shareCounts = this.sumShares(shares)

    if (shareCounts.totalShares === 0) {
      this.logger.info('No shares submitted since last payout, skipping.')
      return
    }

    const balance = await this.rpc.getAccountBalance({ account: this.accountName })
    const confirmedBalance = BigInt(balance.content.confirmed)

    let payoutAmount: number
    if (this.balancePercentPayoutFlag !== undefined) {
      payoutAmount = BigIntUtils.divide(
        confirmedBalance * BigInt(this.balancePercentPayoutFlag),
        100n,
      )
    } else {
      payoutAmount = BigIntUtils.divide(confirmedBalance, this.balancePercentPayout)
    }

    if (payoutAmount <= shareCounts.totalShares + shareCounts.shares.size) {
      // If the pool cannot pay out at least 1 ORE per share and pay transaction fees, no payout can be made.
      this.logger.info('Insufficient funds for payout, skipping.')
      return
    }

    const transactionReceives = MapUtils.map(
      shareCounts.shares,
      (shareCount, publicAddress) => {
        const payoutPercentage = shareCount / shareCounts.totalShares
        const amt = Math.floor(payoutPercentage * payoutAmount)

        return {
          publicAddress,
          amount: amt.toString(),
          memo: `${this.poolName} payout ${shareCutoff.toUTCString()}`,
        }
      },
    )

    try {
      const transaction = await this.rpc.sendTransaction({
        fromAccountName: this.accountName,
        receives: transactionReceives,
        fee: transactionReceives.length.toString(),
        expirationSequenceDelta: this.payoutExpirationSequenceDelta,
      })

      await this.db.markPayoutSuccess(payoutId, timestamp, transaction.content.hash)

      this.discord?.poolPayoutSuccess(
        payoutId,
        transaction.content.hash,
        transactionReceives,
        shareCounts.totalShares,
      )

      this.lark?.poolPayoutSuccess(
        payoutId,
        transaction.content.hash,
        transactionReceives,
        shareCounts.totalShares,
      )
    } catch (e) {
      this.logger.error(`There was an error with the transaction ${ErrorUtils.renderError(e)}`)
      this.discord?.poolPayoutError(e)
      this.lark?.poolPayoutError(e)
    }
  }

  sumShares(shares: DatabaseShare[]): { totalShares: number; shares: Map<string, number> } {
    let totalShares = 0
    const shareMap = new Map<string, number>()

    shares.forEach((share) => {
      const address = share.publicAddress
      const shareCount = shareMap.get(address)

      if (shareCount != null) {
        shareMap.set(address, shareCount + 1)
      } else {
        shareMap.set(address, 1)
      }

      totalShares += 1
    })

    return {
      totalShares,
      shares: shareMap,
    }
  }

  async shareRate(): Promise<number> {
    return (await this.recentShareCount()) / this.recentShareCutoff
  }

  private async recentShareCount(): Promise<number> {
    const timestamp = Math.floor(new Date().getTime() / 1000) - this.recentShareCutoff
    return await this.db.shareCountSince(timestamp)
  }

  private startPayoutInterval() {
    this.payoutInterval = setInterval(() => {
      void this.createPayout()
    }, this.attemptPayoutInterval * 1000)
  }

  private stopPayoutInterval() {
    if (this.payoutInterval) {
      clearInterval(this.payoutInterval)
    }
  }
}
