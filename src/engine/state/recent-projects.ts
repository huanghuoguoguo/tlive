import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';

/**
 * A recently used project/directory entry.
 * Tracks usage frequency and recency for smart ranking.
 */
export interface RecentProject {
  /** Working directory path */
  workdir: string;
  /** Display name (derived from directory basename) */
  name: string;
  /** Number of times this directory was used for CC sessions */
  useCount: number;
  /** Last used timestamp (ISO string) */
  lastUsedAt: string;
}

/**
 * Manages global recent projects list.
 * Auto-records directories when users start CC sessions.
 *
 * Ranking algorithm:
 * - Score = recencyWeight * recencyScore + frequencyWeight * frequencyScore
 * - Recency score: decays over time (1.0 for just now, 0.5 for 1 day ago)
 * - Frequency score: log(useCount) normalized
 *
 * Features:
 * - Auto-add when CC session starts (not on /cd)
 * - Deduplication with increment
 * - Size limit (max 10)
 * - Persisted to disk
 * - Button interaction for quick switch
 */
export class RecentProjectsManager {
  private projects: RecentProject[] = [];
  private persistPath: string | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 2000;
  /** Maximum recent projects to keep */
  static readonly MAX_SIZE = 10;
  /** Weight for recency in ranking (0-1) */
  static readonly RECENCY_WEIGHT = 0.6;
  /** Weight for frequency in ranking (0-1) */
  static readonly FREQUENCY_WEIGHT = 0.4;

  constructor(runtimeDir?: string) {
    if (runtimeDir) {
      this.persistPath = join(runtimeDir, 'recent-projects.json');
      this.loadPersisted();
    }
  }

  /**
   * Record a CC session start in this directory.
   * - Increments useCount if already exists
   * - Updates lastUsedAt
   * - Re-ranks based on combined score
   */
  recordSession(workdir: string): void {
    const now = new Date().toISOString();
    const existing = this.projects.find(p => p.workdir === workdir);

    if (existing) {
      existing.useCount++;
      existing.lastUsedAt = now;
    } else {
      this.projects.push({
        workdir,
        name: basename(workdir),
        useCount: 1,
        lastUsedAt: now,
      });
    }

    // Re-sort by combined score
    this.sortByScore();

    // Truncate to max size
    if (this.projects.length > RecentProjectsManager.MAX_SIZE) {
      this.projects = this.projects.slice(0, RecentProjectsManager.MAX_SIZE);
    }

    this.debouncedSave();
  }

  /**
   * Remove a directory from recent projects.
   */
  remove(workdir: string): void {
    const index = this.projects.findIndex(p => p.workdir === workdir);
    if (index !== -1) {
      this.projects.splice(index, 1);
      this.debouncedSave();
    }
  }

  /**
   * Get all recent projects, sorted by score.
   */
  list(): RecentProject[] {
    return [...this.projects];
  }

  /**
   * Get project by index (for button click).
   */
  getByIndex(index: number): RecentProject | undefined {
    return this.projects[index];
  }

  /**
   * Check if a directory is in recent projects.
   */
  has(workdir: string): boolean {
    return this.projects.some(p => p.workdir === workdir);
  }

  /**
   * Get project by workdir.
   */
  get(workdir: string): RecentProject | undefined {
    return this.projects.find(p => p.workdir === workdir);
  }

  /**
   * Clear all recent projects.
   */
  clear(): void {
    this.projects = [];
    this.debouncedSave();
  }

  // --- Ranking algorithm ---

  /**
   * Calculate combined score for a project.
   * Higher score = more likely to be shown first.
   */
  private calculateScore(project: RecentProject): number {
    const recencyScore = this.calculateRecencyScore(project.lastUsedAt);
    const frequencyScore = this.calculateFrequencyScore(project.useCount);
    return RecentProjectsManager.RECENCY_WEIGHT * recencyScore
      + RecentProjectsManager.FREQUENCY_WEIGHT * frequencyScore;
  }

  /**
   * Recency score: decays over time.
   * - Just now: 1.0
   * - 1 hour ago: ~0.9
   * - 1 day ago: 0.5
   * - 7 days ago: ~0.2
   * - 30 days ago: ~0.1
   */
  private calculateRecencyScore(lastUsedAt: string): number {
    const now = Date.now();
    const then = new Date(lastUsedAt).getTime();
    const hoursAgo = (now - then) / (1000 * 60 * 60);

    // Exponential decay: score = e^(-hoursAgo / 24)
    // This gives 1.0 at 0h, 0.5 at 24h, 0.25 at 48h, etc.
    return Math.exp(-hoursAgo / 24);
  }

  /**
   * Frequency score: log(useCount) normalized.
   * - 1 use: 0.0
   * - 2 uses: ~0.3
   * - 5 uses: ~0.7
   * - 10 uses: 1.0
   */
  private calculateFrequencyScore(useCount: number): number {
    // log10(useCount) capped at 1.0 (10 uses = max)
    return Math.min(1.0, Math.log10(Math.max(1, useCount)));
  }

  /**
   * Sort projects by combined score (descending).
   */
  private sortByScore(): void {
    this.projects.sort((a, b) => this.calculateScore(b) - this.calculateScore(a));
  }

  // --- Persistence ---

  private debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.savePersisted();
    }, RecentProjectsManager.SAVE_DEBOUNCE_MS);
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      const data: RecentProject[] = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      if (Array.isArray(data)) {
        // Validate and migrate old entries without useCount
        this.projects = data
          .map(p => ({
            workdir: p.workdir,
            name: p.name || basename(p.workdir),
            useCount: p.useCount ?? 1,
            lastUsedAt: p.lastUsedAt,
          }))
          .slice(0, RecentProjectsManager.MAX_SIZE);
        // Re-sort on load (scores may have changed)
        this.sortByScore();
      }
    } catch {
      // File doesn't exist or invalid — start fresh
    }
  }

  private savePersisted(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.projects, null, 2));
    } catch (err) {
      console.warn('[recent-projects] Failed to persist:', err);
    }
  }
}