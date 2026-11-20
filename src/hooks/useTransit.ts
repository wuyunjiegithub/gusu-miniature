import { useEffect, useState } from 'react';
import type { LocalPoint2 } from '../types';

export interface TransitLine {
  ref: string;
  name: string;
  color: string;
  segments: LocalPoint2[][];
}

export interface TransitStation {
  x: number;
  z: number;
  name: string;
}

export interface TransitData {
  lines: TransitLine[];
  stations: TransitStation[];
}

let cache: TransitData | null = null;

/** 运行时加载轨道交通数据（scripts/build-transit.mjs 产出） */
export function useTransit(): TransitData | null {
  const [data, setData] = useState<TransitData | null>(cache);

  useEffect(() => {
    if (cache) return;
    const controller = new AbortController();
    fetch('/data/transit.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`transit.json HTTP ${res.status}`);
        return res.json() as Promise<TransitData>;
      })
      .then((json) => {
        cache = json;
        setData(json);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') console.error('[transit] 加载失败', err);
      });
    return () => controller.abort();
  }, []);

  return data;
}
