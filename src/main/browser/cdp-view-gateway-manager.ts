import { startCdpViewGateway } from './cdp-view-gateway'
import type {
  CdpViewGateway,
  CdpViewGatewayController,
  CdpViewTab
} from './cdp-view-gateway-protocol'

export class CdpViewGatewayManager {
  private readonly gateways = new Map<string, CdpViewGateway>()
  private readonly controllers = new Map<string, CdpViewGatewayController>()

  get(viewId: string): CdpViewGateway | undefined {
    return this.gateways.get(viewId)
  }

  listRunning(): CdpViewGateway[] {
    return [...this.gateways.values()]
  }

  async ensure(controller: CdpViewGatewayController): Promise<CdpViewGateway> {
    const existing = this.gateways.get(controller.viewId)
    if (existing) {
      this.controllers.set(controller.viewId, controller)
      return existing
    }
    const gateway = await startCdpViewGateway(controller)
    this.gateways.set(controller.viewId, gateway)
    this.controllers.set(controller.viewId, controller)
    return gateway
  }

  async stop(viewId: string): Promise<boolean> {
    const gateway = this.gateways.get(viewId)
    if (!gateway) {
      return false
    }
    this.gateways.delete(viewId)
    this.controllers.delete(viewId)
    await gateway.close()
    return true
  }

  async stopAll(): Promise<void> {
    const running = [...this.gateways.values()]
    this.gateways.clear()
    this.controllers.clear()
    await Promise.all(running.map((gateway) => gateway.close()))
  }

  notifyTargetCreated(viewId: string, tab: CdpViewTab): void {
    this.gateways.get(viewId)?.notifyTargetCreated(tab)
  }

  notifyTargetDestroyed(viewId: string, targetId: string): void {
    this.gateways.get(viewId)?.notifyTargetDestroyed(targetId)
  }

  notifyTargetInfoChanged(viewId: string, tab: CdpViewTab): void {
    this.gateways.get(viewId)?.notifyTargetInfoChanged(tab)
  }
}

export const cdpViewGatewayManager = new CdpViewGatewayManager()
