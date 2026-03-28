import type { AccountId } from '../charting_library';

export const ACCOUNT_ID = 'demo-account-1' as unknown as AccountId;
export const ACCOUNT_TITLE = 'FX Hero Demo';
export const SYMBOL = 'FX_GAME';
export const CONTRACT_SIZE = 100000;
export const COMMISSION_PER_LOT = 6;
export const LEVERAGE = 500;

export const CONNECTION_STATUS_CONNECTED = 1;
export const ORDER_STATUS_CANCELED = 1;
export const ORDER_STATUS_FILLED = 2;
export const ORDER_STATUS_REJECTED = 5;
export const ORDER_STATUS_WORKING = 6;
export const ORDER_TYPE_LIMIT = 1;
export const ORDER_TYPE_MARKET = 2;
export const ORDER_TYPE_STOP = 3;
export const SIDE_BUY = 1;
export const SIDE_SELL = -1;
export const PARENT_TYPE_POSITION = 2;

export const FINAL_ORDER_STATUSES = new Set([
    ORDER_STATUS_CANCELED,
    ORDER_STATUS_FILLED,
    ORDER_STATUS_REJECTED,
]);

export const FORMATTERS = {
    fixedInCurrency: 'fixedInCurrency',
    text: 'text',
    symbol: 'symbol',
    side: 'side',
    positionSide: 'positionSide',
    formatQuantity: 'formatQuantity',
    status: 'status',
    formatPrice: 'formatPrice',
} as const;
