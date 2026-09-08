import type { Migration } from './index.js';

/**
 * Per-agent-group fallback model on `container_configs`.
 *
 * NULL = no fallback (pre-migration behavior for every existing row — no
 * backfill). A non-NULL value is a model id or alias the provider tries when
 * the primary `model` is overloaded or unavailable (Claude: the Agent SDK's
 * `fallbackModel` query option). Takes effect on the group's next respawn.
 */
export const migration025: Migration = {
  version: 25,
  name: 'container-config-fallback-model',
  sqliteOnly: true,
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN fallback_model TEXT;`);
  },
};
