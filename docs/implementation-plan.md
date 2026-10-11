# Backend integration delivery

Authorized scope: reconstruct from recovery records, implement missing source, connect all existing frontend pages, validate against real PostgreSQL and a native browser, merge into main. No live deployment is requested.

Use ASP.NET Core 10, EF Core/PostgreSQL, the existing vanilla frontend, and the recovered Tiptap editor. Recovery snapshots are evidence, never an assertion of a final historical checkout. Source mappings are in recovery-sources.json. Missing entities, persistence, application services, public JSON API and admin integration are new implementations. New migrations target a fresh database, not the unavailable historical migration tree.

Acceptance (verification evidence is in verification.md):

- AC01: fresh PostgreSQL migration and restart preserve persisted data.
- AC02: admin bootstrap/login/logout/reauthentication; revoked and expired sessions fail; CSRF/HTTPS boundaries apply.
- AC03: columns can be created, edited, activated, archived and ordered; published membership is server-owned.
- AC04: drafts save with ETags; publication snapshots are immutable; concurrent and repeated writes are handled.
- AC05: preview is authenticated; unpublished, withdrawn, trashed and purged articles are absent from public queries.
- AC06: article history, revision-to-draft restoration, trash/restore/purge work without resurrecting old receipts.
- AC07: validated image/video uploads, bounded native processing, persistent jobs, retry, reference-aware lifecycle and protected delivery.
- AC08: homepage, articles, column directories, knowledge chapters, projects, life and about read backend data through existing layouts/routes.
- AC09: projects, knowledge ordering and site settings have usable admin forms and persistence.
- AC10: demo data stays labelled, seeds once, does not overwrite edits, and safely converts existing HTML into schema JSON.
- AC11: async route switching cannot render stale results; empty/error states and existing animations remain usable.
- AC12: encrypted content/media backup excludes credentials and restores only into an explicitly isolated empty database; tampering fails.
- AC13: readiness, startup and deployment instructions, environment examples, dependency licenses and tests ship with source.
- AC14: all checks pass before the integration branch is merged into main; report any external limitation honestly.

All content writes share a PostgreSQL advisory transaction lock. This deliberately serializes writes for a single-owner blog and coordinates publication, media references and backups across processes. Public reads use repeatable-read snapshots. Login/session writes are independent. Secrets and generated runtime files stay outside Git.
