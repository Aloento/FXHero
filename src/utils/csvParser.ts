import Papa from 'papaparse';

export interface CsvRow {
  Time: string;
  Open: string;
  High: string;
  Low: string;
  Close: string;
  XL_Color?: string;
  TTW_Upper?: string;
  TTW_Middle?: string;
  TTW_Lower?: string;
  Fox_IsPivot?: string;
  Fox_Level?: string;
  Est_IsPivot?: string;
  Est_Level?: string;
  "HS_B0(High)"?: string;
  "HS_B1(Low)"?: string;
  "HS_B2(Open)"?: string;
  "HS_B3(Close)"?: string;
  [key: string]: any;
}

export type PivotLevel = 'HIGH' | 'LOW';

export interface TvBar {
  time: number; // in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  xlColor?: string;
  ttwUpper?: number | null;
  ttwMiddle?: number | null;
  ttwLower?: number | null;
  hsHigh?: number | null;
  hsLow?: number | null;
  hsOpen?: number | null;
  hsClose?: number | null;
  foxIsPivot?: boolean;
  foxLevel?: PivotLevel | null;
  estIsPivot?: boolean;
  estLevel?: PivotLevel | null;
}

export interface ParsedCsvData {
  bars: TvBar[];
  precision: number;
  minMove: number;
}

const calculatePrecision = (rawData: any[]): number => {
  let maxDecimals = 2;
  for (let i = rawData.length - 1; i >= 0; i--) {
    const row = rawData[i];
    if (row.Open && row.High && row.Low && row.Close) {
      const lengths = [row.Open, row.High, row.Low, row.Close]
        .filter((v) => typeof v === "string" && v.includes("."))
        .map((v) => v.split(".")[1].length);

      const validLengths = lengths.filter((l) => l <= 6);
      if (validLengths.length > 0) {
        maxDecimals = Math.max(...validLengths);
        break;
      }
    }
  }
  return Math.min(Math.max(maxDecimals, 2), 6);
};

const parseOptionalNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
};

const parseBooleanFlag = (value: unknown): boolean => {
  return String(value ?? '').trim().toUpperCase() === 'TRUE';
};

const parsePivotLevel = (value: unknown): PivotLevel | null => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'HIGH') return 'HIGH';
  if (normalized === 'LOW') return 'LOW';
  return null;
};

export const parseCsvFile = (file: File): Promise<ParsedCsvData> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const rawData = results.data as CsvRow[];
          const maxDecimals = calculatePrecision(rawData);
          const minMove = 1 / Math.pow(10, maxDecimals);

          const bars: TvBar[] = [];

          rawData.forEach((row) => {
            if (!row.Time || !row.Open) return;

            const parts = row.Time.split(" ");
            if (parts.length !== 2) return;
            const [y, m, d] = parts[0].split(".");
            const [H, M] = parts[1].split(":");
            // TV charting library expects time in milliseconds
            const timestamp = Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(H), parseInt(M));

            const open = parseFloat(row.Open);
            const high = parseFloat(row.High);
            const low = parseFloat(row.Low);
            const close = parseFloat(row.Close);

            if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
              bars.push({
                time: timestamp,
                open,
                high,
                low,
                close,
                xlColor: row.XL_Color?.trim() || undefined,
                ttwUpper: parseOptionalNumber(row.TTW_Upper),
                ttwMiddle: parseOptionalNumber(row.TTW_Middle),
                ttwLower: parseOptionalNumber(row.TTW_Lower),
                hsHigh: parseOptionalNumber(row['HS_B0(High)']),
                hsLow: parseOptionalNumber(row['HS_B1(Low)']),
                hsOpen: parseOptionalNumber(row['HS_B2(Open)']),
                hsClose: parseOptionalNumber(row['HS_B3(Close)']),
                foxIsPivot: parseBooleanFlag(row.Fox_IsPivot),
                foxLevel: parsePivotLevel(row.Fox_Level),
                estIsPivot: parseBooleanFlag(row.Est_IsPivot),
                estLevel: parsePivotLevel(row.Est_Level),
              });
            }
          });

          bars.sort((a, b) => a.time - b.time);

          resolve({
            bars,
            precision: maxDecimals,
            minMove,
          });
        } catch (err) {
          reject(err);
        }
      },
      error: (err: any) => reject(new Error(`文件读取错误: ${err.message}`)),
    });
  });
};
