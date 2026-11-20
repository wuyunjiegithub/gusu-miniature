import { useEffect, useState } from 'react';

/** 建筑实例数据（scripts/build-buildings.mjs 产出） */
export interface BuildingRecord {
  x: number;
  z: number;
  w: number;
  d: number;
  rot: number;
  h: number;
  roofH: number;
}

export interface BuildingsData {
  pitched: number[][];
  flat: number[][];
  /** 城外背景白模（体量示意） */
  outer: number[][];
}

let cache: BuildingsData | null = null;

/** 运行时加载建筑实例数据（public/data/buildings.json） */
export function useBuildings(): BuildingsData | null {
  const [data, setData] = useState<BuildingsData | null>(cache);

  useEffect(() => {
    if (cache) return;
    const controller = new AbortController();
    fetch('/data/buildings.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`buildings.json HTTP ${res.status}`);
        return res.json() as Promise<BuildingsData>;
      })
      .then((json) => {
        cache = json;
        setData(json);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') {
          console.error('[buildings] 加载失败', err);
        }
      });
    return () => controller.abort();
  }, []);

  return data;
}
