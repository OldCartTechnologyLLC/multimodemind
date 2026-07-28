/**
 * Dashboard config — persisted to .mmind/config.json
 * Copyright Old Cart Technology LLC — MIT License
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveRanking } from '../router/ranking.js';
import {
  DEFAULT_ACCESS,
  DEFAULT_BACKENDS,
  type AccessMode,
  type BackendConfig,
  type RankingConfig,
  type StoreType,
} from '../types.js';

const CONFIG_DIR = join(homedir(), '.mmind');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface DashboardConfig {
  sqlitePath: string;
  leveldbPath: string;
  filesPath: string;
  vectorIndexPath: string;
  vaultPath: string | null;
  /** Per-store read vs read/write. Governs whether the agent may write. */
  access: Record<StoreType, AccessMode>;
  /** Which engine backs the structured and vector slots. */
  backends: BackendConfig;
  /** Retrieval ranking weights. What the [t] panel edits and the server reads. */
  ranking: RankingConfig;
}

/**
 * A config with every field present, built fresh each call.
 *
 * Deliberately a function rather than a frozen object: the caller mutates what
 * it gets back (the panels assign straight onto `cfg.access[store]` and
 * `cfg.ranking.halfLifeDays[store]`), and a shared default would pick those
 * edits up permanently.
 */
function defaults(): DashboardConfig {
  return {
    sqlitePath: join(CONFIG_DIR, 'memory.db'),
    leveldbPath: join(CONFIG_DIR, 'leveldb'),
    filesPath: join(CONFIG_DIR, 'files'),
    vectorIndexPath: join(CONFIG_DIR, 'vector-index'),
    vaultPath: null,
    access: { ...DEFAULT_ACCESS },
    backends: { ...DEFAULT_BACKENDS },
    ranking: resolveRanking(),
  };
}

export function loadConfig(): DashboardConfig {
  if (!existsSync(CONFIG_FILE)) return defaults();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<DashboardConfig>;
    return {
      ...defaults(),
      ...raw,
      // Merge so files that predate a field still get sane defaults
      access: { ...DEFAULT_ACCESS, ...(raw.access ?? {}) },
      backends: { ...DEFAULT_BACKENDS, ...(raw.backends ?? {}) },
      ranking: resolveRanking(raw.ranking),
    };
  } catch {
    return defaults();
  }
}

export function saveConfig(cfg: DashboardConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}
