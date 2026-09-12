// lib/sync-queue.js — Offline-first sync action queue
//
// Wrapped in a factory like the other lib/ modules on purpose: a bare top-level
// `class SyncQueue` is a global lexical binding, and background.js declares
// `const SyncQueue = JobAutofill.SyncQueue`. Both land in the same service-worker
// scope, so the pair threw "Identifier 'SyncQueue' has already been declared"
// and the worker never started.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.JobAutofill = root.JobAutofill || {};
        root.JobAutofill.SyncQueue = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SYNC_QUEUE_KEY = 'cloud_sync_queue';

    /**
     * Sync Action Types:
     * - 'patch': Merge part of an object (e.g. form fields, metrics)
     * - 'set': Full overwrite (e.g. global aliases)
     * - 'delete': Delete an entity
     */
    class SyncQueue {
        static async enqueue(actionType, dataKey, payload) {
            const queue = await this.getQueue();
            // Stamp the owning account: a queue that outlives a sign-out must never
            // be uploaded into the next user's documents.
            let userId = null;
            try {
                const auth = await globalThis.JobAutofill?.AuthStore?.getAuthState?.();
                userId = auth?.userId || null;
            } catch (_) { }
            queue.push({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                action: actionType,
                key: dataKey,
                payload,
                userId,
                attempts: 0,
                timestamp: new Date().toISOString()
            });
            await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
            console.log(`[SyncQueue] Enqueued ${actionType} for ${dataKey}`);
        }

        static async getQueue() {
            try {
                const result = await chrome.storage.local.get(SYNC_QUEUE_KEY);
                const queue = result[SYNC_QUEUE_KEY];
                return Array.isArray(queue) ? queue : [];
            } catch (err) {
                console.error('[SyncQueue] getQueue failed:', err);
                return [];
            }
        }

        static async clearQueue() {
            await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: [] });
        }

        static async removeItems(ids) {
            const queue = await this.getQueue();
            const nextQueue = queue.filter(item => !ids.includes(item.id));
            await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: nextQueue });
        }
    }

    return SyncQueue;
});
