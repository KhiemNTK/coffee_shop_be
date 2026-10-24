# Permission catalog and access assignment

`PermissionKeys` is the source of truth for application capabilities. Permission
labels and seed data derive from it. Creating a database key does not create an
API policy. The frontend reads the catalog and assigns existing permissions to
roles; it does not edit permission definitions.

- `pnpm permissions:check` checks active database keys against code, including
  missing, unknown, duplicate and incorrectly unprotected keys. It only reads.
- Run it after the approved permission seed in the deployment job. Do not run it
  as a request-time or readiness query. An empty, unseeded database fails.
- Review unknown keys and their assignments before retiring them. Never delete
  unknown keys automatically or run the full seed just to clear a check failure.
- Legacy permission mutation endpoints remain for compatibility and are marked
  deprecated in OpenAPI. They cannot claim, rename or delete code-defined system
  keys, even if an existing row has the wrong `isSystemPermission` flag.
- Roles Excel import only creates role names and descriptions, not grants. It is
  not an RBAC backup; there is no new frontend Excel workflow.

## Role lifecycle

- Employee profiles do not include role assignments. Use the dedicated
  `/employees/:id/roles` endpoint with `/employees_roles_read`.
- `POST /roles` accepts optional `templateRoleId` and `expectedPermissionIds`.
  Copying also requires role read, permission read-for-role and permission
  assignment rights, plus every copied permission. It creates an independent
  custom role, never a system role or an employee assignment. The frontend
  previews the source grants and sends their baseline to detect concurrent edits.
- Metadata updates do not change grants. Creation, metadata updates and imports
  write their audit in the same transaction; import audits only inserted rows.
- Assigned roles cannot be deleted (`409 ROLE_IN_USE`), including assignments to
  inactive employees. Reassign employees first; there is no force-delete option.
- Seed preflight rejects custom roles using reserved system names. Rename those
  roles explicitly before retrying; the seed never takes ownership by name alone.

The frontend contract is generated with `pnpm permissions:sync` in the frontend
repo and checked with `pnpm permissions:check` against the sibling backend.
Route-policy tests also reject permission keys absent from the code catalog.
Deploy the backend first, then update the frontend integration job's pinned
`BACKEND_REF` to the committed backend revision before releasing the frontend.

## Concurrent edits

Replacement bodies require an explicit `permissionIds` or `roleIds` array.
An empty array deliberately revokes all assignments; an omitted array is invalid.

The frontend sends the original IDs as `expectedPermissionIds` or
`expectedRoleIds`. The backend compares them inside the serializable transaction
and returns `409 AUTHORIZATION_CHANGED` before writing if the assignments changed.
An already-applied identical replacement remains a no-op. After an uncertain or
conflicting write, reload and review; do not automatically retry the command.

The baseline fields are optional for existing clients. Such clients retain the
old replacement semantics until upgraded. Baselines compare assignment sets,
not changes to the contents of an assigned role or an ABA sequence of changes.
