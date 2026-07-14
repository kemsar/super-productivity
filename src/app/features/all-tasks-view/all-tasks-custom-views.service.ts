import { Injectable, signal, computed, Signal } from '@angular/core';
import { nanoid } from 'nanoid';

import { AllTasksCustomView } from './all-tasks-view.model';
import { Log } from '../../core/log';

const STORAGE_KEY = 'sp_all_tasks_custom_views_v1';

/**
 * Local, signal-backed store of saved custom views for the /all-tasks page
 * (issue #16, phase 3). Persists to localStorage on every write.
 *
 * Deliberately not part of the NgRx / op-log sync layer for now: custom
 * views are user-preference-shaped data, and modeling them as a first-class
 * synced entity means a shared-schema change (new EntityType + server
 * support). Local-only is the low-risk MVP; a bump to synced state is a
 * clean follow-up when there's a clear cross-device need.
 */
@Injectable({ providedIn: 'root' })
export class AllTasksCustomViewsService {
  private readonly _views = signal<AllTasksCustomView[]>(this._read());

  readonly views: Signal<AllTasksCustomView[]> = this._views.asReadonly();
  readonly sortedViews = computed(() =>
    [...this._views()].sort((a, b) => a.name.localeCompare(b.name)),
  );

  getById(id: string): AllTasksCustomView | undefined {
    return this._views().find((v) => v.id === id);
  }

  save(view: Omit<AllTasksCustomView, 'id' | 'createdAt'>): AllTasksCustomView {
    const created: AllTasksCustomView = {
      ...view,
      id: nanoid(),
      // Timestamp is a bare `Date.now()` — this data is local-only so we
      // don't need the tighter DateService/logical-clock guarantees the
      // synced NgRx state requires.
      createdAt: Date.now(),
    };
    this._views.update((prev) => [...prev, created]);
    this._write();
    return created;
  }

  update(
    id: string,
    changes: Partial<Omit<AllTasksCustomView, 'id' | 'createdAt'>>,
  ): void {
    this._views.update((prev) =>
      prev.map((v) => (v.id === id ? { ...v, ...changes } : v)),
    );
    this._write();
  }

  remove(id: string): void {
    this._views.update((prev) => prev.filter((v) => v.id !== id));
    this._write();
  }

  private _read(): AllTasksCustomView[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Best-effort shape validation. A stray legacy blob shouldn't crash
      // the whole page — just drop the malformed entries and keep going.
      return parsed.filter(
        (v): v is AllTasksCustomView =>
          !!v &&
          typeof v === 'object' &&
          typeof (v as AllTasksCustomView).id === 'string' &&
          typeof (v as AllTasksCustomView).name === 'string' &&
          !!(v as AllTasksCustomView).filter &&
          !!(v as AllTasksCustomView).sort,
      );
    } catch (err) {
      Log.err('Failed to read saved all-tasks custom views', err);
      return [];
    }
  }

  private _write(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._views()));
    } catch (err) {
      Log.err('Failed to persist all-tasks custom views', err);
    }
  }
}
