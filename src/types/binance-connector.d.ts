declare module '@binance/connector' {
  export class Spot {
    constructor(apiKey?: string, apiSecret?: string, options?: any);
    account(options?: any): Promise<any>;
    ticker24hr(options?: any): Promise<any>;
    time(): Promise<any>;
    exchangeInfo(options?: any): Promise<any>;
    marginAccount(options?: any): Promise<any>;
    marginBorrow(asset: string, amount: number, options?: any): Promise<any>;
    userAsset(options?: any): Promise<any>;
  }
}
