import { PermissionKeys } from './permission-keys';
import { PermissionLabels } from './permission-labels';

describe('Permission contract labels', () => {
  it('covers every system permission with distinct keys and non-empty bilingual labels', () => {
    expect(Object.keys(PermissionLabels).sort()).toEqual(
      Object.keys(PermissionKeys).sort(),
    );
    expect(new Set(Object.values(PermissionKeys)).size).toBe(
      Object.keys(PermissionKeys).length,
    );
    for (const labels of Object.values(PermissionLabels)) {
      expect(labels).toHaveLength(2);
      for (const label of labels)
        expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
