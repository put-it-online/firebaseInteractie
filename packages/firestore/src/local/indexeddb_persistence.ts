/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { User } from '../auth/user';
import { DatabaseInfo } from '../core/database_info';
import { JsonProtoSerializer } from '../remote/serializer';
import { assert, fail } from '../util/assert';
import { Code, FirestoreError } from '../util/error';
import * as log from '../util/log';

import { IndexedDbMutationQueue } from './indexeddb_mutation_queue';
import { IndexedDbQueryCache } from './indexeddb_query_cache';
import { IndexedDbRemoteDocumentCache } from './indexeddb_remote_document_cache';
import {
  ALL_STORES,
  DbClientMetadataKey,
  DbClientMetadata,
  DbPrimaryClient,
  DbPrimaryClientKey,
  SCHEMA_VERSION,
  SchemaConverter
} from './indexeddb_schema';
import { LocalSerializer } from './local_serializer';
import { MutationQueue } from './mutation_queue';
import {
  Persistence,
  PersistenceTransaction,
  PrimaryStateListener
} from './persistence';
import { PersistencePromise } from './persistence_promise';
import { QueryCache } from './query_cache';
import { RemoteDocumentCache } from './remote_document_cache';
import { SimpleDb, SimpleDbStore, SimpleDbTransaction } from './simple_db';
import { Platform } from '../platform/platform';
import { AsyncQueue, TimerId } from '../util/async_queue';
import { ClientId } from './shared_client_state';
import { CancelablePromise } from '../util/promise';

const LOG_TAG = 'IndexedDbPersistence';

/**
 * Oldest acceptable age in milliseconds for client metadata read from
 * IndexedDB. Client metadata and primary leases that are older than 5 seconds
 * are ignored.
 */
const CLIENT_METADATA_MAX_AGE_MS = 5000;

/**
 * Oldest acceptable age in milliseconds for client metadata before it and its
 * associated data (such as the remote document cache changelog) can be
 * garbage collected. Clients that exceed this threshold will not be able to
 * replay Watch events that occurred before this threshold.
 */
const CLIENT_STATE_GARBAGE_COLLECTION_THRESHOLD_MS = 30 * 60 * 1000; // 30 Minutes

/**
 * The interval at which clients will update their metadata, including
 * refreshing their primary lease if held or potentially trying to acquire it if
 * not held.
 *
 * Primary clients may opportunistically refresh their metadata earlier
 * if they're already performing an IndexedDB operation.
 */
const CLIENT_METADATA_REFRESH_INTERVAL_MS = 4000;
/** User-facing error when the primary lease is required but not available. */
const PRIMARY_LEASE_LOST_ERROR_MSG =
  'The current tab is not in the required state to perform this operation. ' +
  'It might be necessary to refresh the browser tab.';
const PRIMARY_LEASE_EXCLUSIVE_ERROR_MSG =
  'There is another tab open with offline' +
  ' persistence enabled. Only one such tab is allowed at a time. The' +
  ' other tab must be closed or persistence must be disabled.';
// TODO(multitab): When multi-tab is exposed, change this comment back to:
//     'Another tab has exclusive access to the persistence layer. ' +
//     'To allow shared access, make sure to invoke ' +
//     '`enablePersistence()` with `experimentalTabSynchronization:true` in all tabs.';
const UNSUPPORTED_PLATFORM_ERROR_MSG =
  'This platform is either missing' +
  ' IndexedDB or is known to have an incomplete implementation. Offline' +
  ' persistence has been disabled.';

// The format of the LocalStorage key that stores zombied client is:
//     firestore_zombie_<persistence_prefix>_<instance_key>
const ZOMBIED_CLIENTS_KEY_PREFIX = 'firestore_zombie';

export class IndexedDbTransaction extends PersistenceTransaction {
  constructor(readonly simpleDbTransaction: SimpleDbTransaction) {
    super();
  }
}

/**
 * An IndexedDB-backed instance of Persistence. Data is stored persistently
 * across sessions.
 *
 * On Web only, the Firestore SDKs support shared access to its persistence
 * layer. This allows multiple browser tabs to read and write to IndexedDb and
 * to synchronize state even without network connectivity. Shared access is
 * currently optional and not enabled unless all clients invoke
 * `enablePersistence()` with `{experimentalTabSynchronization:true}`.
 *
 * In multi-tab mode, if multiple clients are active at the same time, the SDK
 * will designate one client as the ???primary client???. An effort is made to pick
 * a visible, network-connected and active client, and this client is
 * responsible for letting other clients know about its presence. The primary
 * client writes a unique client-generated identifier (the client ID) to
 * IndexedDb???s ???owner??? store every 4 seconds. If the primary client fails to
 * update this entry, another client can acquire the lease and take over as
 * primary.
 *
 * Some persistence operations in the SDK are designated as primary-client only
 * operations. This includes the acknowledgment of mutations and all updates of
 * remote documents. The effects of these operations are written to persistence
 * and then broadcast to other tabs via LocalStorage (see
 * `WebStorageSharedClientState`), which then refresh their state from
 * persistence.
 *
 * Similarly, the primary client listens to notifications sent by secondary
 * clients to discover persistence changes written by secondary clients, such as
 * the addition of new mutations and query targets.
 *
 * If multi-tab is not enabled and another tab already obtained the primary
 * lease, IndexedDbPersistence enters a failed state and all subsequent
 * operations will automatically fail.
 *
 * Additionally, there is an optimization so that when a tab is closed, the
 * primary lease is released immediately (this is especially important to make
 * sure that a refreshed tab is able to immediately re-acquire the primary
 * lease). Unfortunately, IndexedDB cannot be reliably used in window.unload
 * since it is an asynchronous API. So in addition to attempting to give up the
 * lease, the leaseholder writes its client ID to a "zombiedClient" entry in
 * LocalStorage which acts as an indicator that another tab should go ahead and
 * take the primary lease immediately regardless of the current lease timestamp.
 *
 * TODO(multitab): Remove `experimentalTabSynchronization` section when
 * multi-tab is no longer optional.
 */
export class IndexedDbPersistence implements Persistence {
  static getStore<Key extends IDBValidKey, Value>(
    txn: PersistenceTransaction,
    store: string
  ): SimpleDbStore<Key, Value> {
    if (txn instanceof IndexedDbTransaction) {
      return SimpleDb.getStore<Key, Value>(txn.simpleDbTransaction, store);
    } else {
      fail('IndexedDbPersistence must use instances of IndexedDbTransaction');
    }
  }

  /**
   * The name of the main (and currently only) IndexedDB database. this name is
   * appended to the prefix provided to the IndexedDbPersistence constructor.
   */
  static MAIN_DATABASE = 'main';

  private readonly document: Document | null;
  private readonly window: Window;

  private simpleDb: SimpleDb;
  private _started = false;
  private isPrimary = false;
  private networkEnabled = true;
  private dbName: string;

  /**
   * Set to an Error object if we encounter an unrecoverable error. All further
   * transactions will be failed with this error.
   */
  private persistenceError: Error | null;
  /** Our window.unload handler, if registered. */
  private windowUnloadHandler: (() => void) | null;
  private inForeground = false;

  private serializer: LocalSerializer;

  /** Our 'visibilitychange' listener if registered. */
  private documentVisibilityHandler: ((e?: Event) => void) | null;

  /** The client metadata refresh task. */
  private clientMetadataRefresher: CancelablePromise<void>;

  /** The last time we garbage collected the Remote Document Changelog. */
  private lastGarbageCollectionTime = Number.NEGATIVE_INFINITY;

  /** Whether to allow shared multi-tab access to the persistence layer. */
  private allowTabSynchronization: boolean;

  /** A listener to notify on primary state changes. */
  private primaryStateListener: PrimaryStateListener = _ => Promise.resolve();

  private queryCache: IndexedDbQueryCache;
  private remoteDocumentCache: IndexedDbRemoteDocumentCache;

  constructor(
    private readonly persistenceKey: string,
    private readonly clientId: ClientId,
    platform: Platform,
    private readonly queue: AsyncQueue,
    serializer: JsonProtoSerializer,
    synchronizeTabs: boolean
  ) {
    this.dbName = persistenceKey + IndexedDbPersistence.MAIN_DATABASE;
    this.serializer = new LocalSerializer(serializer);
    this.document = platform.document;
    this.window = platform.window;
    this.allowTabSynchronization = synchronizeTabs;
    this.queryCache = new IndexedDbQueryCache(this.serializer);
    this.remoteDocumentCache = new IndexedDbRemoteDocumentCache(
      this.serializer,
      /*keepDocumentChangeLog=*/ this.allowTabSynchronization
    );
  }

  /**
   * Attempt to start IndexedDb persistence.
   *
   * @return {Promise<void>} Whether persistence was enabled.
   */
  start(): Promise<void> {
    if (!IndexedDbPersistence.isAvailable()) {
      this.persistenceError = new FirestoreError(
        Code.UNIMPLEMENTED,
        UNSUPPORTED_PLATFORM_ERROR_MSG
      );
      return Promise.reject(this.persistenceError);
    }

    assert(!this.started, 'IndexedDbPersistence double-started!');
    assert(this.window !== null, "Expected 'window' to be defined");

    return SimpleDb.openOrCreate(
      this.dbName,
      SCHEMA_VERSION,
      new SchemaConverter(this.serializer)
    )
      .then(db => {
        this.simpleDb = db;
      })
      .then(() => this.startRemoteDocumentCache())
      .then(() => {
        this.attachVisibilityHandler();
        this.attachWindowUnloadHook();
        return this.updateClientMetadataAndTryBecomePrimary().then(() =>
          this.scheduleClientMetadataAndPrimaryLeaseRefreshes()
        );
      })
      .then(() => {
        this._started = true;
      });
  }

  private startRemoteDocumentCache(): Promise<void> {
    return this.simpleDb.runTransaction('readonly', ALL_STORES, txn =>
      this.remoteDocumentCache.start(txn)
    );
  }

  setPrimaryStateListener(
    primaryStateListener: PrimaryStateListener
  ): Promise<void> {
    this.primaryStateListener = primaryStateListener;
    return primaryStateListener(this.isPrimary);
  }

  setNetworkEnabled(networkEnabled: boolean): void {
    if (this.networkEnabled !== networkEnabled) {
      this.networkEnabled = networkEnabled;
      // Schedule a primary lease refresh for immediate execution. The eventual
      // lease update will be propagated via `primaryStateListener`.
      this.queue.enqueueAndForget(async () => {
        if (this.started) {
          await this.updateClientMetadataAndTryBecomePrimary();
        }
      });
    }
  }

  /**
   * Updates the client metadata in IndexedDb and attempts to either obtain or
   * extend the primary lease for the local client. Asynchronously notifies the
   * primary state listener if the client either newly obtained or released its
   * primary lease.
   */
  private updateClientMetadataAndTryBecomePrimary(): Promise<void> {
    return this.simpleDb.runTransaction('readwrite', ALL_STORES, txn => {
      const metadataStore = clientMetadataStore(txn);
      return metadataStore
        .put(
          new DbClientMetadata(
            this.clientId,
            Date.now(),
            this.networkEnabled,
            this.inForeground,
            this.remoteDocumentCache.lastProcessedDocumentChangeId
          )
        )
        .next(() => this.canActAsPrimary(txn))
        .next(canActAsPrimary => {
          const wasPrimary = this.isPrimary;
          this.isPrimary = canActAsPrimary;

          if (wasPrimary !== this.isPrimary) {
            this.queue.enqueueAndForget(async () => {
              // Verify that `shutdown()` hasn't been called yet by the time
              // we invoke the `primaryStateListener`.
              if (this.started) {
                return this.primaryStateListener(this.isPrimary);
              }
            });
          }

          if (wasPrimary && !this.isPrimary) {
            return this.releasePrimaryLeaseIfHeld(txn);
          } else if (this.isPrimary) {
            return this.acquireOrExtendPrimaryLease(txn);
          }
        });
    });
  }

  private removeClientMetadata(
    txn: SimpleDbTransaction
  ): PersistencePromise<void> {
    const metadataStore = clientMetadataStore(txn);
    return metadataStore.delete(this.clientId);
  }

  /**
   * If the garbage collection threshold has passed, prunes the
   * RemoteDocumentChanges and the ClientMetadata store based on the last update
   * time of all clients.
   */
  private async maybeGarbageCollectMultiClientState(): Promise<void> {
    if (
      this.isPrimary &&
      !this.isWithinAge(
        this.lastGarbageCollectionTime,
        CLIENT_STATE_GARBAGE_COLLECTION_THRESHOLD_MS
      )
    ) {
      this.lastGarbageCollectionTime = Date.now();

      let activeClients: DbClientMetadata[];
      let inactiveClients: DbClientMetadata[];

      await this.runTransaction('readwrite', true, txn => {
        const metadataStore = IndexedDbPersistence.getStore<
          DbClientMetadataKey,
          DbClientMetadata
        >(txn, DbClientMetadata.store);

        return metadataStore
          .loadAll()
          .next(existingClients => {
            activeClients = this.filterActiveClients(
              existingClients,
              CLIENT_STATE_GARBAGE_COLLECTION_THRESHOLD_MS
            );
            inactiveClients = existingClients.filter(
              client => activeClients.indexOf(client) === -1
            );
          })
          .next(() =>
            // Delete metadata for clients that are no longer considered active.
            PersistencePromise.forEach(inactiveClients, inactiveClient =>
              metadataStore.delete(inactiveClient.clientId)
            )
          )
          .next(() => {
            // Retrieve the minimum change ID from the set of active clients.

            // The primary client doesn't read from the document change log,
            // and hence we exclude it when we determine the minimum
            // `lastProcessedDocumentChangeId`.
            activeClients = activeClients.filter(
              client => client.clientId !== this.clientId
            );

            if (activeClients.length > 0) {
              const processedChangeIds = activeClients.map(
                client => client.lastProcessedDocumentChangeId || 0
              );
              const oldestChangeId = Math.min(...processedChangeIds);
              return this.remoteDocumentCache.removeDocumentChangesThroughChangeId(
                txn,
                oldestChangeId
              );
            }
          });
      });

      // Delete potential leftover entries that may continue to mark the
      // inactive clients as zombied in LocalStorage.
      // Ideally we'd delete the IndexedDb and LocalStorage zombie entries for
      // the client atomically, but we can't. So we opt to delete the IndexedDb
      // entries first to avoid potentially reviving a zombied client.
      inactiveClients.forEach(inactiveClient => {
        this.window.localStorage.removeItem(
          this.zombiedClientLocalStorageKey(inactiveClient.clientId)
        );
      });
    }
  }

  /**
   * Schedules a recurring timer to update the client metadata and to either
   * extend or acquire the primary lease if the client is eligible.
   */
  private scheduleClientMetadataAndPrimaryLeaseRefreshes(): void {
    this.clientMetadataRefresher = this.queue.enqueueAfterDelay(
      TimerId.ClientMetadataRefresh,
      CLIENT_METADATA_REFRESH_INTERVAL_MS,
      () => {
        return this.updateClientMetadataAndTryBecomePrimary()
          .then(() => this.maybeGarbageCollectMultiClientState())
          .then(() => this.scheduleClientMetadataAndPrimaryLeaseRefreshes());
      }
    );
  }

  /** Checks whether `client` is the local client. */
  private isLocalClient(client: DbPrimaryClient | null): boolean {
    return client ? client.ownerId === this.clientId : false;
  }

  /**
   * Evaluate the state of all active clients and determine whether the local
   * client is or can act as the holder of the primary lease. Returns whether
   * the client is eligible for the lease, but does not actually acquire it.
   * May return 'false' even if there is no active leaseholder and another
   * (foreground) client should become leaseholder instead.
   */
  private canActAsPrimary(
    txn: SimpleDbTransaction
  ): PersistencePromise<boolean> {
    const store = primaryClientStore(txn);
    return store
      .get(DbPrimaryClient.key)
      .next(currentPrimary => {
        const currentLeaseIsValid =
          currentPrimary !== null &&
          this.isWithinAge(
            currentPrimary.leaseTimestampMs,
            CLIENT_METADATA_MAX_AGE_MS
          ) &&
          !this.isClientZombied(currentPrimary.ownerId);

        // A client is eligible for the primary lease if:
        // - its network is enabled and the client's tab is in the foreground.
        // - its network is enabled and no other client's tab is in the
        //   foreground.
        // - every clients network is disabled and the client's tab is in the
        //   foreground.
        // - every clients network is disabled and no other client's tab is in
        //   the foreground.
        if (currentLeaseIsValid) {
          if (this.isLocalClient(currentPrimary) && this.networkEnabled) {
            return true;
          }

          if (!this.isLocalClient(currentPrimary)) {
            if (!currentPrimary.allowTabSynchronization) {
              // Fail the `canActAsPrimary` check if the current leaseholder has
              // not opted into multi-tab synchronization. If this happens at
              // client startup, we reject the Promise returned by
              // `enablePersistence()` and the user can continue to use Firestore
              // with in-memory persistence.
              // If this fails during a lease refresh, we will instead block the
              // AsyncQueue from executing further operations. Note that this is
              // acceptable since mixing & matching different `synchronizeTabs`
              // settings is not supported.
              //
              // TODO(multitab): Remove this check when `synchronizeTabs` can no
              // longer be turned off.
              throw new FirestoreError(
                Code.FAILED_PRECONDITION,
                PRIMARY_LEASE_EXCLUSIVE_ERROR_MSG
              );
            }

            return false;
          }
        }

        if (this.networkEnabled && this.inForeground) {
          return true;
        }

        return clientMetadataStore(txn)
          .loadAll()
          .next(existingClients => {
            // Process all existing clients and determine whether at least one of
            // them is better suited to obtain the primary lease.
            const preferredCandidate = this.filterActiveClients(
              existingClients,
              CLIENT_METADATA_MAX_AGE_MS
            ).find(otherClient => {
              if (this.clientId !== otherClient.clientId) {
                const otherClientHasBetterNetworkState =
                  !this.networkEnabled && otherClient.networkEnabled;
                const otherClientHasBetterVisibility =
                  !this.inForeground && otherClient.inForeground;
                const otherClientHasSameNetworkState =
                  this.networkEnabled === otherClient.networkEnabled;
                if (
                  otherClientHasBetterNetworkState ||
                  (otherClientHasBetterVisibility &&
                    otherClientHasSameNetworkState)
                ) {
                  return true;
                }
              }
              return false;
            });
            return preferredCandidate === undefined;
          });
      })
      .next(canActAsPrimary => {
        if (this.isPrimary !== canActAsPrimary) {
          log.debug(
            LOG_TAG,
            `Client ${
              canActAsPrimary ? 'is' : 'is not'
            } eligible for a primary lease.`
          );
        }
        return canActAsPrimary;
      });
  }

  async shutdown(deleteData?: boolean): Promise<void> {
    // The shutdown() operations are idempotent and can be called even when
    // start() aborted (e.g. because it couldn't acquire the persistence lease).
    this._started = false;

    this.markClientZombied();
    if (this.clientMetadataRefresher) {
      this.clientMetadataRefresher.cancel();
    }
    this.detachVisibilityHandler();
    this.detachWindowUnloadHook();
    await this.simpleDb.runTransaction(
      'readwrite',
      [DbPrimaryClient.store, DbClientMetadata.store],
      txn => {
        return this.releasePrimaryLeaseIfHeld(txn).next(() =>
          this.removeClientMetadata(txn)
        );
      }
    );
    this.simpleDb.close();

    // Remove the entry marking the client as zombied from LocalStorage since
    // we successfully deleted its metadata from IndexedDb.
    this.removeClientZombiedEntry();
    if (deleteData) {
      await SimpleDb.delete(this.dbName);
    }
  }

  /**
   * Returns clients that are not zombied and have an updateTime within the
   * provided threshold.
   */
  private filterActiveClients(
    clients: DbClientMetadata[],
    activityThresholdMs: number
  ): DbClientMetadata[] {
    return clients.filter(
      client =>
        this.isWithinAge(client.updateTimeMs, activityThresholdMs) &&
        !this.isClientZombied(client.clientId)
    );
  }

  getActiveClients(): Promise<ClientId[]> {
    return this.simpleDb.runTransaction(
      'readonly',
      [DbClientMetadata.store],
      txn => {
        return clientMetadataStore(txn)
          .loadAll()
          .next(clients =>
            this.filterActiveClients(clients, CLIENT_METADATA_MAX_AGE_MS).map(
              clientMetadata => clientMetadata.clientId
            )
          );
      }
    );
  }

  get started(): boolean {
    return this._started;
  }

  getMutationQueue(user: User): MutationQueue {
    assert(
      this.started,
      'Cannot initialize MutationQueue before persistence is started.'
    );
    return IndexedDbMutationQueue.forUser(user, this.serializer);
  }

  getQueryCache(): QueryCache {
    assert(
      this.started,
      'Cannot initialize QueryCache before persistence is started.'
    );
    return this.queryCache;
  }

  getRemoteDocumentCache(): RemoteDocumentCache {
    assert(
      this.started,
      'Cannot initialize RemoteDocumentCache before persistence is started.'
    );
    return this.remoteDocumentCache;
  }

  runTransaction<T>(
    action: string,
    requirePrimaryLease: boolean,
    transactionOperation: (
      transaction: PersistenceTransaction
    ) => PersistencePromise<T>
  ): Promise<T> {
    // TODO(multitab): Consider removing `requirePrimaryLease` and exposing
    // three different write modes (readonly, readwrite, readwrite_primary).
    if (this.persistenceError) {
      return Promise.reject(this.persistenceError);
    }

    log.debug(LOG_TAG, 'Starting transaction:', action);

    // Do all transactions as readwrite against all object stores, since we
    // are the only reader/writer.
    return this.simpleDb.runTransaction(
      'readwrite',
      ALL_STORES,
      simpleDbTxn => {
        if (requirePrimaryLease) {
          // While we merely verify that we have (or can acquire) the lease
          // immediately, we wait to extend the primary lease until after
          // executing transactionOperation(). This ensures that even if the
          // transactionOperation takes a long time, we'll use a recent
          // leaseTimestampMs in the extended (or newly acquired) lease.
          return this.canActAsPrimary(simpleDbTxn)
            .next(canActAsPrimary => {
              if (!canActAsPrimary) {
                log.error(
                  `Failed to obtain primary lease for action '${action}'.`
                );
                this.isPrimary = false;
                this.queue.enqueueAndForget(() =>
                  this.primaryStateListener(false)
                );
                throw new FirestoreError(
                  Code.FAILED_PRECONDITION,
                  PRIMARY_LEASE_LOST_ERROR_MSG
                );
              }
              return transactionOperation(
                new IndexedDbTransaction(simpleDbTxn)
              );
            })
            .next(result => {
              return this.acquireOrExtendPrimaryLease(simpleDbTxn).next(
                () => result
              );
            });
        } else {
          return this.verifyAllowTabSynchronization(simpleDbTxn).next(() =>
            transactionOperation(new IndexedDbTransaction(simpleDbTxn))
          );
        }
      }
    );
  }

  /**
   * Verifies that the current tab is the primary leaseholder or alternatively
   * that the leaseholder has opted into multi-tab synchronization.
   */
  // TODO(multitab): Remove this check when `synchronizeTabs` can no longer be
  // turned off.
  private verifyAllowTabSynchronization(
    txn: SimpleDbTransaction
  ): PersistencePromise<void> {
    const store = primaryClientStore(txn);
    return store.get(DbPrimaryClient.key).next(currentPrimary => {
      const currentLeaseIsValid =
        currentPrimary !== null &&
        this.isWithinAge(
          currentPrimary.leaseTimestampMs,
          CLIENT_METADATA_MAX_AGE_MS
        ) &&
        !this.isClientZombied(currentPrimary.ownerId);

      if (currentLeaseIsValid && !this.isLocalClient(currentPrimary)) {
        if (!currentPrimary.allowTabSynchronization) {
          throw new FirestoreError(
            Code.FAILED_PRECONDITION,
            PRIMARY_LEASE_EXCLUSIVE_ERROR_MSG
          );
        }
      }
    });
  }

  /**
   * Obtains or extends the new primary lease for the local client. This
   * method does not verify that the client is eligible for this lease.
   */
  private acquireOrExtendPrimaryLease(txn): PersistencePromise<void> {
    const newPrimary = new DbPrimaryClient(
      this.clientId,
      this.allowTabSynchronization,
      Date.now()
    );
    return primaryClientStore(txn).put(DbPrimaryClient.key, newPrimary);
  }

  static isAvailable(): boolean {
    return SimpleDb.isAvailable();
  }

  /**
   * Generates a string used as a prefix when storing data in IndexedDB and
   * LocalStorage.
   */
  static buildStoragePrefix(databaseInfo: DatabaseInfo): string {
    // Use two different prefix formats:
    //
    //   * firestore / persistenceKey / projectID . databaseID / ...
    //   * firestore / persistenceKey / projectID / ...
    //
    // projectIDs are DNS-compatible names and cannot contain dots
    // so there's no danger of collisions.
    let database = databaseInfo.databaseId.projectId;
    if (!databaseInfo.databaseId.isDefaultDatabase) {
      database += '.' + databaseInfo.databaseId.database;
    }

    return 'firestore/' + databaseInfo.persistenceKey + '/' + database + '/';
  }

  /** Checks the primary lease and removes it if we are the current primary. */
  private releasePrimaryLeaseIfHeld(
    txn: SimpleDbTransaction
  ): PersistencePromise<void> {
    this.isPrimary = false;

    const store = primaryClientStore(txn);
    return store.get(DbPrimaryClient.key).next(primaryClient => {
      if (this.isLocalClient(primaryClient)) {
        log.debug(LOG_TAG, 'Releasing primary lease.');
        return store.delete(DbPrimaryClient.key);
      } else {
        return PersistencePromise.resolve();
      }
    });
  }

  /** Verifies that `updateTimeMs` is within `maxAgeMs`. */
  private isWithinAge(updateTimeMs: number, maxAgeMs: number): boolean {
    const now = Date.now();
    const minAcceptable = now - maxAgeMs;
    const maxAcceptable = now;
    if (updateTimeMs < minAcceptable) {
      return false;
    } else if (updateTimeMs > maxAcceptable) {
      log.error(
        `Detected an update time that is in the future: ${updateTimeMs} > ${maxAcceptable}`
      );
      return false;
    }

    return true;
  }

  private attachVisibilityHandler(): void {
    if (
      this.document !== null &&
      typeof this.document.addEventListener === 'function'
    ) {
      this.documentVisibilityHandler = () => {
        this.queue.enqueueAndForget(() => {
          this.inForeground = this.document.visibilityState === 'visible';
          return this.updateClientMetadataAndTryBecomePrimary();
        });
      };

      this.document.addEventListener(
        'visibilitychange',
        this.documentVisibilityHandler
      );

      this.inForeground = this.document.visibilityState === 'visible';
    }
  }

  private detachVisibilityHandler(): void {
    if (this.documentVisibilityHandler) {
      assert(
        this.document !== null &&
          typeof this.document.addEventListener === 'function',
        "Expected 'document.addEventListener' to be a function"
      );
      this.document.removeEventListener(
        'visibilitychange',
        this.documentVisibilityHandler
      );
      this.documentVisibilityHandler = null;
    }
  }

  /**
   * Attaches a window.unload handler that will synchronously write our
   * clientId to a "zombie client id" location in LocalStorage. This can be used
   * by tabs trying to acquire the primary lease to determine that the lease
   * is no longer valid even if the timestamp is recent. This is particularly
   * important for the refresh case (so the tab correctly re-acquires the
   * primary lease). LocalStorage is used for this rather than IndexedDb because
   * it is a synchronous API and so can be used reliably from  an unload
   * handler.
   */
  private attachWindowUnloadHook(): void {
    if (typeof this.window.addEventListener === 'function') {
      this.windowUnloadHandler = () => {
        // Note: In theory, this should be scheduled on the AsyncQueue since it
        // accesses internal state. We execute this code directly during shutdown
        // to make sure it gets a chance to run.
        this.markClientZombied();

        this.queue.enqueueAndForget(() => {
          // Attempt graceful shutdown (including releasing our primary lease),
          // but there's no guarantee it will complete.
          return this.shutdown();
        });
      };
      this.window.addEventListener('unload', this.windowUnloadHandler);
    }
  }

  private detachWindowUnloadHook(): void {
    if (this.windowUnloadHandler) {
      assert(
        typeof this.window.removeEventListener === 'function',
        "Expected 'window.removeEventListener' to be a function"
      );
      this.window.removeEventListener('unload', this.windowUnloadHandler);
      this.windowUnloadHandler = null;
    }
  }

  /**
   * Returns whether a client is "zombied" based on its LocalStorage entry.
   * Clients become zombied when their tab closes without running all of the
   * cleanup logic in `shutdown()`.
   */
  private isClientZombied(clientId: ClientId): boolean {
    if (this.window.localStorage === undefined) {
      assert(
        process.env.USE_MOCK_PERSISTENCE === 'YES',
        'Operating without LocalStorage is only supported with IndexedDbShim.'
      );
      return null;
    }

    try {
      const isZombied =
        this.window.localStorage.getItem(
          this.zombiedClientLocalStorageKey(clientId)
        ) !== null;
      log.debug(
        LOG_TAG,
        `Client '${clientId}' ${
          isZombied ? 'is' : 'is not'
        } zombied in LocalStorage`
      );
      return isZombied;
    } catch (e) {
      // Gracefully handle if LocalStorage isn't available / working.
      log.error(LOG_TAG, 'Failed to get zombied client id.', e);
      return null;
    }
  }

  /**
   * Record client as zombied (a client that had its tab closed). Zombied
   * clients are ignored during primary tab selection.
   */
  private markClientZombied(): void {
    try {
      // TODO(multitab): Garbage Collect Local Storage
      this.window.localStorage.setItem(
        this.zombiedClientLocalStorageKey(this.clientId),
        String(Date.now())
      );
    } catch (e) {
      // Gracefully handle if LocalStorage isn't available / working.
      log.error('Failed to set zombie client id.', e);
    }
  }

  /** Removes the zombied client entry if it exists. */
  private removeClientZombiedEntry(): void {
    try {
      this.window.localStorage.removeItem(
        this.zombiedClientLocalStorageKey(this.clientId)
      );
    } catch (e) {
      // Ignore
    }
  }

  private zombiedClientLocalStorageKey(clientId: ClientId): string {
    return `${ZOMBIED_CLIENTS_KEY_PREFIX}_${this.persistenceKey}_${clientId}`;
  }
}

export function isPrimaryLeaseLostError(err: FirestoreError): boolean {
  return (
    err.code === Code.FAILED_PRECONDITION &&
    err.message === PRIMARY_LEASE_LOST_ERROR_MSG
  );
}
/**
 * Helper to get a typed SimpleDbStore for the primary client object store.
 */
function primaryClientStore(
  txn: SimpleDbTransaction
): SimpleDbStore<DbPrimaryClientKey, DbPrimaryClient> {
  return txn.store<DbPrimaryClientKey, DbPrimaryClient>(DbPrimaryClient.store);
}

/**
 * Helper to get a typed SimpleDbStore for the client metadata object store.
 */
function clientMetadataStore(
  txn: SimpleDbTransaction
): SimpleDbStore<DbClientMetadataKey, DbClientMetadata> {
  return txn.store<DbClientMetadataKey, DbClientMetadata>(
    DbClientMetadata.store
  );
}
