import { useEffect, useState } from 'react';
import type { LocalPoint2 } from '../types';

/** 高架/立交段：指向 major/minor 里的某条折线，h 为桥面净高（米） */
export interface OverpassSegment {
  kind: 'major' | 'minor';
  index: number;
  h: number;
}

export interface RoadsData {
  major: LocalPoint2[][];
  minor: LocalPoint2[][];
  overpass?: OverpassSegment[];
}

let cache: RoadsData | null = null;

/** 运行时加载道路数据（scripts/build-roads.mjs 产出） */
export function useRoads(): RoadsData | null {
  const [data, setData] = useState<RoadsData | null>(cache);

  useEffect(() => {
    if (cache) return;
    const controller = new AbortController();
    fetch('/data/roads.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`roads.json HTTP ${res.status}`);
        return res.json() as Promise<RoadsData>;
      })
      .then((json) => {
        cache = json;
        setData(json);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') console.error('[roads] 加载失败', err);
      });
    return () => controller.abort();
  }, []);

  return data;
}
