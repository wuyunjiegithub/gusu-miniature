import { useLodLevel } from '../hooks/useLodLevel';

/** 在场景内驱动 LOD 层级更新（FR-11） */
export function LodWatcher() {
  useLodLevel();
  return null;
}
