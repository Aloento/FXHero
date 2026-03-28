import type { Position } from '../charting_library';

export type TradeRecord = {
    id: string;
    type: 'LONG' | 'SHORT';
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    pnl: number;
    commission: number;
    netPnl: number;
};

export type InternalPosition = {
    id: string;
    symbol: string;
    side: number;
    qty: number;
    avgPrice: number;
    updateTime: number;
    entryTime: number;
    takeProfit?: number;
    stopLoss?: number;
};

export type BrokerSnapshot = {
    balance: number;
    equity: number;
    floatingPnl: number;
    position: Position | null;
    trades: TradeRecord[];
};
