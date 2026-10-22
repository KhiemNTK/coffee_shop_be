import { getPermissionCatalogIssues } from './permission-catalog';
import { PermissionKeys } from './permission-keys';

describe('Deployment-managed permission catalog', () => {
  const catalog = () =>
    Object.values(PermissionKeys).map((key) => ({
      key,
      isSystemPermission: true,
    }));

  it('accepts the current code catalog without a fixed permission count', () => {
    expect(getPermissionCatalogIssues(catalog())).toEqual([]);
  });

  it('reports missing, unknown, duplicate and unprotected active keys', () => {
    const rows = catalog().filter(
      (row) => row.key !== PermissionKeys.MENU_READ,
    );
    rows[0].isSystemPermission = false;
    expect(
      getPermissionCatalogIssues([
        ...rows,
        { key: rows[0].key, isSystemPermission: true },
        { key: '/obsolete_read', isSystemPermission: false },
      ]).sort(),
    ).toEqual(
      [
        `Missing system key: ${PermissionKeys.MENU_READ}`,
        `Unprotected system key: ${rows[0].key}`,
        `Duplicate key: ${rows[0].key}`,
        'Unknown key: /obsolete_read',
      ].sort(),
    );
  });
});
