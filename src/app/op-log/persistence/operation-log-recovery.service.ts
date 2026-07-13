import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { OperationLogStoreService } from './operation-log-store.service';
import { CURRENT_SCHEMA_VERSION } from './schema-migration.service';
import { LegacyPfDbService } from '../../core/persistence/legacy-pf-db.service';
import { ClientIdService } from '../../core/util/client-id.service';
import { loadAllData } from '../../root-store/meta/load-all-data.action';
import { Operation, OpType, ActionType } from '../core/operation.types';
import { SINGLETON_ENTITY_ID } from '../core/entity-registry';
import { uuidv7 } from '../../util/uuid-v7';
import { OpLog } from '../../core/log';
import { AppDataComplete } from '../model/model-config';
import { ValidateStateService } from '../validation/validate-state.service';
import { SnackService } from '../../core/snack/snack.service';
import { T } from '../../t.const';

/**
 * Handles crash recovery and data restoration for the operation log system.
 *
 * Responsibilities:
 * - Recovering from corrupted/missing SUP_OPS database
 * - Loading data from legacy 'pf' database
 * - Recovering pending remote ops from crashed syncs
 *
 * This service is used by OperationLogHydratorService during startup
 * when normal hydration fails or pending ops need recovery.
 */
@Injectable({ providedIn: 'root' })
export class OperationLogRecoveryService {
  private store = inject(Store);
  private opLogStore = inject(OperationLogStoreService);
  private legacyPfDb = inject(LegacyPfDbService);
  private clientIdService = inject(ClientIdService);
  private validateStateService = inject(ValidateStateService);
  private snackService = inject(SnackService);

  /**
   * Attempts to recover from a corrupted or missing SUP_OPS database.
   * Recovery strategy:
   * 1. Try to load data from legacy 'pf' database (IndexedDB)
   * 2. If found, run genesis migration with that data
   * 3. If no legacy data, log error (user will need to sync or restore from backup)
   */
  async attemptRecovery(): Promise<void> {
    OpLog.normal('OperationLogRecoveryService: Attempting disaster recovery...');

    try {
      // 1. Try to load from legacy 'pf' database
      const hasLegacyData = await this.legacyPfDb.hasUsableEntityData();

      if (hasLegacyData) {
        OpLog.normal(
          'OperationLogRecoveryService: Found data in legacy database. Recovering...',
        );
        const legacyData = await this.legacyPfDb.loadAllEntityData();
        await this.recoverFromLegacyData(
          legacyData as unknown as Record<string, unknown>,
        );
        return;
      }

      // 2. No legacy data found
      // App will start with NgRx initial state (empty).
      // User can sync or import a backup to restore their data.
      OpLog.warn(
        'OperationLogRecoveryService: No legacy data found. ' +
          'If you have sync enabled, please trigger a sync to restore your data. ' +
          'Otherwise, you may need to restore from a backup.',
      );
    } catch (e) {
      OpLog.err('OperationLogRecoveryService: Recovery failed', e);
      // App will start with NgRx initial state (empty).
      // User can sync or restore from backup.
    }
  }

  /**
   * Recovers from legacy data by creating a new genesis snapshot.
   */
  async recoverFromLegacyData(legacyData: Record<string, unknown>): Promise<void> {
    // Validate legacy data. Importing corrupted legacy data would propagate
    // the corruption into SUP_OPS and the next hydration would fail
    // validation in turn. If strict validation fails, attempt non-interactive
    // repair before refusing — otherwise the user is stuck with an empty
    // store on every launch (see #9). Only refuse when repair itself cannot
    // produce a valid state.
    const validationResult = await this.validateStateService.validateState(legacyData);
    let dataToImport = legacyData;
    let wasRepaired = false;
    if (!validationResult.isValid) {
      OpLog.warn(
        'OperationLogRecoveryService: Legacy data failed validation. Attempting repair...',
        {
          typiaErrorCount: validationResult.typiaErrors.length,
          crossModelError: validationResult.crossModelError,
        },
      );
      const repairResult =
        await this.validateStateService.validateAndRepairWithoutConfirm(legacyData);
      if (!repairResult.isValid || !repairResult.repairedState) {
        OpLog.err('OperationLogRecoveryService: Refusing to import invalid legacy data', {
          typiaErrorCount: validationResult.typiaErrors.length,
          crossModelError: validationResult.crossModelError,
          repairError: repairResult.error,
        });
        throw new Error(
          `Legacy recovery data validation failed (${validationResult.typiaErrors.length} typia errors` +
            `${validationResult.crossModelError ? `, cross-model: ${validationResult.crossModelError}` : ''})` +
            (repairResult.error ? ` — repair failed: ${repairResult.error}` : ''),
        );
      }
      OpLog.warn(
        'OperationLogRecoveryService: Repaired legacy data after validation failure.',
        { repairSummary: repairResult.repairSummary },
      );
      dataToImport = repairResult.repairedState;
      wasRepaired = true;
    }

    const clientId = await this.clientIdService.loadClientId();
    if (!clientId) {
      throw new Error('Failed to load clientId - cannot create recovery operation');
    }

    // Create recovery operation
    const recoveryOp: Operation = {
      id: uuidv7(),
      actionType: ActionType.RECOVERY_DATA_IMPORT,
      opType: OpType.Batch,
      entityType: 'RECOVERY',
      entityId: SINGLETON_ENTITY_ID,
      payload: dataToImport,
      clientId: clientId,
      vectorClock: { [clientId]: 1 },
      timestamp: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    // Write recovery operation
    await this.opLogStore.append(recoveryOp);

    // Create state cache
    const lastSeq = await this.opLogStore.getLastSeq();
    await this.opLogStore.saveStateCache({
      state: dataToImport,
      lastAppliedOpSeq: lastSeq,
      vectorClock: recoveryOp.vectorClock,
      compactedAt: Date.now(),
    });

    // Persist vector clock to IndexedDB store for immediate availability
    // Without this, getVectorClock() returns stale clock until cache is populated
    await this.opLogStore.setVectorClock(recoveryOp.vectorClock);

    // Dispatch to NgRx
    this.store.dispatch(
      loadAllData({ appDataComplete: dataToImport as AppDataComplete }),
    );

    if (wasRepaired) {
      this._notifyRepairApplied();
    }

    OpLog.normal(
      'OperationLogRecoveryService: Recovery complete. Data restored from legacy database.',
    );
  }

  /**
   * Surfaces silent boot-time repair of legacy recovery data to the user.
   * Errors are swallowed because recovery must never fail because of a UI
   * notification.
   */
  private _notifyRepairApplied(): void {
    try {
      this.snackService.open({
        type: 'ERROR',
        msg: T.F.SYNC.S.INTEGRITY_CHECK_FAILED,
      });
    } catch (err) {
      OpLog.warn('OperationLogRecoveryService: Failed to emit repair notification', err);
    }
  }

  /**
   * Recovers from pending remote ops that were stored but not applied (crash recovery).
   * These ops are replayed through reducers during normal hydration, but a crash may
   * have happened before their archive side effects completed. Move them to the
   * 'archive_pending' checkpoint so hydration retries archive work without
   * double-applying reducers; sync stays blocked until that recovery succeeds.
   */
  async recoverPendingRemoteOps(): Promise<void> {
    const recoveredLegacyFailures =
      await this.opLogStore.recoverLegacyTerminalRemoteFailures();
    if (recoveredLegacyFailures > 0) {
      OpLog.warn(
        `OperationLogRecoveryService: Re-quarantined ${recoveredLegacyFailures} legacy terminal remote failure(s).`,
      );
    }
    const pendingOps = await this.opLogStore.getPendingRemoteOps();

    if (pendingOps.length === 0) {
      return;
    }

    // Reducers are replayed status-blind during hydration; archive work is
    // retried after. Age is irrelevant — every crash-interrupted op lands in
    // the same quarantine, and retryCount stays untouched (no attempt was made).
    const seqs = pendingOps.map((e) => e.seq);
    await this.opLogStore.markReducersCommittedAndMergeClocks(
      seqs,
      pendingOps.map((entry) => entry.op),
    );
    OpLog.warn(
      `OperationLogRecoveryService: Found ${pendingOps.length} pending remote ops from previous crash. ` +
        'Quarantined their archive work (reducers will replay during hydration).',
    );
  }

  /**
   * Cleans up corrupt operations that have missing or invalid entityId.
   * These operations cause infinite rejection loops during sync because:
   * 1. They get rejected with CONFLICT_CONCURRENT
   * 2. The rejection handler tries to resolve by creating merged ops
   * 3. The new ops also have invalid entityId and get rejected again
   *
   * By marking these ops as rejected upfront, we break the infinite loop.
   */
  async cleanupCorruptOps(): Promise<void> {
    const unsyncedOps = await this.opLogStore.getUnsynced();

    if (unsyncedOps.length === 0) {
      return;
    }

    // Find ops with missing or invalid entityId (excluding bulk 'ALL' operations)
    const corruptOps = unsyncedOps.filter((entry) => {
      const op = entry.op;
      // Bulk operations with entityType 'ALL' don't need entityId
      if (op.entityType === 'ALL') {
        return false;
      }
      // Check for missing or invalid entityId
      return !op.entityId || typeof op.entityId !== 'string';
    });

    if (corruptOps.length === 0) {
      return;
    }

    const corruptIds = corruptOps.map((e) => e.op.id);
    await this.opLogStore.markRejected(corruptIds);

    OpLog.warn(
      `OperationLogRecoveryService: Rejected ${corruptOps.length} corrupt ops with invalid entityId. ` +
        `Entity types: ${[...new Set(corruptOps.map((e) => e.op.entityType))].join(', ')}`,
    );
  }
}
