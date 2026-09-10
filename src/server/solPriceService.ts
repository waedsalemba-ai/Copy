import { config } from './config';

export class SOLPriceService {
  private static instance: SOLPriceService;
  private currentSolPriceUsd: number = config.solPriceUsd || 145.50;
  private updatedAt: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;

  private constructor() {
    console.log('[SOLPriceService] Initialized central SOL price provider');
  }

  public static getInstance(): SOLPriceService {
    if (!SOLPriceService.instance) {
      SOLPriceService.instance = new SOLPriceService();
    }
    return SOLPriceService.instance;
  }

  public getSolPriceUsd(): number {
    return this.currentSolPriceUsd > 0 ? this.currentSolPriceUsd : (config.solPriceUsd || 145.50);
  }

  public getUpdatedAt(): number {
    return this.updatedAt;
  }

  public updateSolPriceUsd(usdPrice: number): void {
    if (usdPrice > 0) {
      this.currentSolPriceUsd = usdPrice;
      this.updatedAt = Date.now();
    }
  }
}

export const solPriceService = SOLPriceService.getInstance();
