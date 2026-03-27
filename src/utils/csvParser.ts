import Papa from 'papaparse';

export interface CsvRow {
  Time: string;
  Open: string;
  High: string;
  Low: string;
  Close: string;
  [key: string]: any;
}

export interface TvBar {
  time: number; // in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
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
              bars.push({ time: timestamp, open, high, low, close });
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
