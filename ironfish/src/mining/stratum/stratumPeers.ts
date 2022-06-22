/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from 'net'
import { Config } from '../../fileStores/config'
import { createRootLogger, Logger } from '../../logger'
import { SetTimeoutToken } from '../../utils'
import { StratumServerClient } from './stratumServerClient'

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const PEERS_TICK_MS = 10000

export class StratumPeers {
  readonly logger: Logger
  readonly maxConnectionsByIp: number
  readonly connectionsByIp: Map<string, number>
  readonly bannedByIp: Map<string, number>
  readonly scoreByIp: Map<string, number>

  protected eventLoopTimeout: SetTimeoutToken | null = null

  constructor(options: { maxConnectionsPerIp?: number; config: Config; logger?: Logger }) {
    this.logger = options.logger ?? createRootLogger()

    this.maxConnectionsByIp =
      options.maxConnectionsPerIp ?? options.config.get('poolMaxConnectionsPerIp')

    this.bannedByIp = new Map()
    this.scoreByIp = new Map()
    this.connectionsByIp = new Map()
  }

  start(): void {
    this.eventLoop()
  }

  stop(): void {
    if (this.eventLoopTimeout) {
      clearTimeout(this.eventLoopTimeout)
    }
  }

  punish(client: StratumServerClient, reason?: string, amount = 1): void {
    if (this.isBanned(client.socket)) {
      return
    }

    let banScore = this.scoreByIp.get(client.remoteAddress) ?? 0
    banScore += amount

    if (banScore < 10) {
      this.scoreByIp.set(client.remoteAddress, banScore)
      return
    }

    this.ban(client, reason)
    this.scoreByIp.delete(client.remoteAddress)
  }

  ban(client: StratumServerClient, reason = 'unknown', until?: number): void {
    const existing = this.bannedByIp.get(client.remoteAddress) ?? 0
    until = Math.max(existing, until ?? Date.now() + TWO_HOURS_MS)

    this.bannedByIp.set(client.remoteAddress, until)
    this.scoreByIp.delete(client.remoteAddress)

    const message = `Banned ${client.remoteAddress}: ${reason} until: ${new Date(
      until,
    ).toUTCString()}`

    client.close(new Error(message))
    this.logger.info(message)
  }

  isBanned(socket: net.Socket): boolean {
    if (!socket.remoteAddress) {
      return false
    }

    const bannedUntil = this.bannedByIp.get(socket.remoteAddress)
    if (!bannedUntil) {
      return false
    }

    return bannedUntil < Date.now()
  }

  isAllowed(socket: net.Socket): boolean {
    if (!socket.remoteAddress) {
      return false
    }

    if (this.isBanned(socket)) {
      return false
    }

    const connections = this.connectionsByIp.get(socket.remoteAddress) ?? 0
    if (this.maxConnectionsByIp > 0 && connections >= this.maxConnectionsByIp) {
      return false
    }

    return true
  }

  addConnectionCount(client: StratumServerClient): void {
    const count = this.connectionsByIp.get(client.remoteAddress) ?? 0
    this.connectionsByIp.set(client.remoteAddress, count + 1)
  }

  removeConnectionCount(client: StratumServerClient): void {
    const count = this.connectionsByIp.get(client.remoteAddress) ?? 0
    this.connectionsByIp.set(client.remoteAddress, count - 1)

    if (count - 1 <= 0) {
      this.connectionsByIp.delete(client.remoteAddress)
    }
  }

  unpunish(remoteAddress: string, reduceBy = 1): void {
    let score = this.scoreByIp.get(remoteAddress)

    if (score === undefined) {
      return
    }

    score -= reduceBy

    if (score > 0) {
      this.scoreByIp.set(remoteAddress, score)
    } else {
      this.scoreByIp.delete(remoteAddress)
    }
  }

  eventLoop(): void {
    for (const remoteAddress of this.scoreByIp.keys()) {
      this.unpunish(remoteAddress)
    }

    this.eventLoopTimeout = setTimeout(() => this.eventLoop(), PEERS_TICK_MS)
  }
}
