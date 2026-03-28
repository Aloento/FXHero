import type { CustomIndicator, PineJS } from '../charting_library';
import CustomDatafeed from './datafeed';

const CHART_COLORS = {
  xlBlue: '#2962FF',
  xlRed: '#FF5252',
  xlMagenta: '#E040FB',
  xlAqua: '#00BCD4',
  hsHigh: '#00C853',
  hsLow: '#FFB300',
  hsOpen: '#66BB6A',
  hsClose: '#FFA726',
  ttwUpper: '#00BCD4',
  ttwMiddle: '#4CAF50',
  ttwLower: '#2196F3',
  fox: '#D32F2F',
  est: '#00ACC1',
};

const toNumberOrNaN = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const makeLineDefaults = (plots: Array<{ id: string; color: string; width?: number }>) => {
  const styles: Record<string, unknown> = {};
  for (const plot of plots) {
    styles[plot.id] = {
      color: plot.color,
      linestyle: 0,
      linewidth: plot.width ?? 2,
      plottype: 2,
      trackPrice: false,
      visible: true,
      transparency: 0,
    };
  }
  return styles;
};

const makeLineStylesMeta = (plots: Array<{ id: string; title: string }>) => {
  const styles: Record<string, unknown> = {};
  for (const plot of plots) {
    styles[plot.id] = {
      title: plot.title,
      histogramBase: 0,
    };
  }
  return styles;
};

const createOverlayIndicator = (
  id: string,
  description: string,
  plots: Array<{ id: string; title: string; color: string; width?: number }>,
  valueGetter: (ctx: any) => number[]
): CustomIndicator => {
  return {
    name: description,
    metainfo: {
      _metainfoVersion: 53,
      id,
      description,
      shortDescription: description,
      is_hidden_study: false,
      is_price_study: true,
      isCustomIndicator: true,
      linkedToSeries: true,
      format: {
        type: 'price',
      },
      plots: plots.map((plot) => ({ id: plot.id, type: 'line' })),
      defaults: {
        styles: makeLineDefaults(plots),
        inputs: {},
      },
      styles: makeLineStylesMeta(plots),
      inputs: [],
    } as any,
    constructor: function (this: any) {
      this.main = function (ctx: any) {
        return valueGetter(ctx);
      };
    },
  };
};

const createHsCandlesIndicator = (datafeed: CustomDatafeed, pineStd: PineJS['Std']): CustomIndicator => {
  return {
    name: 'FX HS Candles',
    metainfo: {
      _metainfoVersion: 53,
      id: 'FX_HS_CANDLES@tv-basicstudies-1',
      description: 'FX HS Candles',
      shortDescription: 'FX HS Candles',
      is_hidden_study: false,
      is_price_study: true,
      isCustomIndicator: true,
      linkedToSeries: true,
      format: { type: 'price' },
      plots: [
        { id: 'hs_open', type: 'ohlc_open', target: 'hs_ohlc' },
        { id: 'hs_high', type: 'ohlc_high', target: 'hs_ohlc' },
        { id: 'hs_low', type: 'ohlc_low', target: 'hs_ohlc' },
        { id: 'hs_close', type: 'ohlc_close', target: 'hs_ohlc' },
        { id: 'hs_body_colorer', type: 'ohlc_colorer', target: 'hs_ohlc', palette: 'hsPalette' },
        { id: 'hs_wick_colorer', type: 'wick_colorer', target: 'hs_ohlc', palette: 'hsPalette' },
        { id: 'hs_border_colorer', type: 'border_colorer', target: 'hs_ohlc', palette: 'hsPalette' },
      ],
      palettes: {
        hsPalette: {
          colors: [{ name: 'HS Up' }, { name: 'HS Down' }],
          valToIndex: { '1': 0, '-1': 1 },
        },
      },
      ohlcPlots: {
        hs_ohlc: {
          title: 'HS Candles',
          forceOverlay: true,
        },
      },
      defaults: {
        ohlcPlots: {
          hs_ohlc: {
            plottype: 'ohlc_candles',
            color: CHART_COLORS.hsHigh,
            display: 15,
            drawWick: false,
            drawBorder: false,
            wickColor: CHART_COLORS.hsHigh,
            borderColor: CHART_COLORS.hsHigh,
          },
        },
        palettes: {
          hsPalette: {
            colors: [
              { color: CHART_COLORS.hsHigh, style: 0, width: 1 },
              { color: CHART_COLORS.hsLow, style: 0, width: 1 },
            ],
          },
        },
        styles: {},
        inputs: {},
      },
      styles: {},
      inputs: [],
    } as any,
    constructor: function (this: any) {
      this.main = function (ctx: any) {
        const ts = pineStd.time?.(ctx) ?? 0;
        const bar = datafeed.getBarByUnixTime(ts);
        if (!bar || bar.hsOpen == null || bar.hsHigh == null || bar.hsLow == null || bar.hsClose == null) {
          return [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        }
        const colorIndex = bar.hsClose >= bar.hsOpen ? 1 : -1;
        return [bar.hsOpen, bar.hsHigh, bar.hsLow, bar.hsClose, colorIndex, colorIndex, colorIndex];
      };
    },
  };
};

const createXlColorerIndicator = (datafeed: CustomDatafeed, pineStd: PineJS['Std']): CustomIndicator => {
  return {
    name: 'FX XL Color K',
    metainfo: {
      _metainfoVersion: 53,
      id: 'FX_XL_COLOR@tv-basicstudies-1',
      description: 'FX XL Color K',
      shortDescription: 'FX XL Color K',
      is_hidden_study: false,
      is_price_study: true,
      isCustomIndicator: true,
      linkedToSeries: true,
      format: { type: 'price' },
      plots: [{ id: 'xl_colorer', type: 'bar_colorer', palette: 'xlPalette' }],
      palettes: {
        xlPalette: {
          colors: [{ name: 'Blue' }, { name: 'Red' }, { name: 'Magenta' }, { name: 'Aqua' }],
          valToIndex: { '1': 0, '2': 1, '3': 2, '4': 3 },
          addDefaultColor: true,
        },
      },
      defaults: {
        palettes: {
          xlPalette: {
            colors: [
              { color: CHART_COLORS.xlBlue, style: 0, width: 1 },
              { color: CHART_COLORS.xlRed, style: 0, width: 1 },
              { color: CHART_COLORS.xlMagenta, style: 0, width: 1 },
              { color: CHART_COLORS.xlAqua, style: 0, width: 1 },
            ],
          },
        },
        styles: {},
        inputs: {},
      },
      styles: {
        xl_colorer: { title: 'XL Colorer' },
      },
      inputs: [],
    } as any,
    constructor: function (this: any) {
      this.main = function (ctx: any) {
        const ts = pineStd.time?.(ctx) ?? 0;
        const bar = datafeed.getBarByUnixTime(ts);
        if (!bar?.xlColor) return [Number.NaN];
        const color = bar.xlColor.toUpperCase();
        if (color === 'BLUE') return [1];
        if (color === 'RED') return [2];
        if (color === 'MAGENTA') return [3];
        if (color === 'AQUA') return [4];
        return [Number.NaN];
      };
    },
  };
};

export const createCustomIndicatorsGetter = (datafeed: CustomDatafeed) => {
  return async (pineJs: PineJS): Promise<readonly CustomIndicator[]> => {
    const pineStd = pineJs.Std;
    const foxIndicator = createOverlayIndicator(
      'FX_FOX@tv-basicstudies-1',
      'FX FOX',
      [
        { id: 'fox_line', title: 'FOX', color: CHART_COLORS.fox, width: 4 },
      ],
      (ctx) => {
        const ts = pineStd.time?.(ctx) ?? 0;
        const point = datafeed.getPivotLinePointAt('FOX', ts);
        if (!point) return [Number.NaN];
        return [point.value];
      }
    );

    const estIndicator = createOverlayIndicator(
      'FX_EST@tv-basicstudies-1',
      'FX EST',
      [
        { id: 'est_line', title: 'EST', color: CHART_COLORS.est, width: 2 },
      ],
      (ctx) => {
        const ts = pineStd.time?.(ctx) ?? 0;
        const point = datafeed.getPivotLinePointAt('EST', ts);
        if (!point) return [Number.NaN];
        return [point.value];
      }
    );

    const hsIndicator = createHsCandlesIndicator(datafeed, pineStd);

    const ttwIndicator = createOverlayIndicator(
      'FX_TTW@tv-basicstudies-1',
      'FX TTW',
      [
        { id: 'ttw_upper', title: 'TTW Upper', color: CHART_COLORS.ttwUpper, width: 1 },
        { id: 'ttw_middle', title: 'TTW Middle', color: CHART_COLORS.ttwMiddle, width: 1 },
        { id: 'ttw_lower', title: 'TTW Lower', color: CHART_COLORS.ttwLower, width: 1 },
      ],
      (ctx) => {
        const ts = pineStd.time?.(ctx) ?? 0;
        const bar = datafeed.getBarByUnixTime(ts);
        if (!bar) return [Number.NaN, Number.NaN, Number.NaN];
        return [
          toNumberOrNaN(bar.ttwUpper),
          toNumberOrNaN(bar.ttwMiddle),
          toNumberOrNaN(bar.ttwLower),
        ];
      }
    );

    const xlIndicator = createXlColorerIndicator(datafeed, pineStd);

    return [foxIndicator, estIndicator, hsIndicator, ttwIndicator, xlIndicator];
  };
};
