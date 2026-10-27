/* eslint-disable @typescript-eslint/unbound-method -- Inspecting decorator metadata, not invoking handlers. */
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { UpdatePromotionStorefrontDto } from './promotion-storefront.dto';
import { PromotionsController } from '../promotions.controller';
import { IS_SKIP_AUTH } from '../../auth/auth.decorator';
import { REQUIRED_PERMISSIONS_KEY } from '../../authorization/authorization.decorator';
import { PermissionKeys } from '../../../common/consts/permission-keys';

describe('Storefront promotion boundary', () => {
  it('requires a version and rejects financial fields and oversized public copy', () => {
    const valid = {
      showOnStorefront: true,
      storefrontDescription: 'At the counter',
      expectedUpdatedAt: '2026-10-25T00:00:00.000Z',
    };
    expect(UpdatePromotionStorefrontDto.schema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      UpdatePromotionStorefrontDto.schema.safeParse({
        ...valid,
        expectedUpdatedAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      UpdatePromotionStorefrontDto.schema.safeParse({
        ...valid,
        discountValue: 99,
      }).success,
    ).toBe(false);
    expect(
      UpdatePromotionStorefrontDto.schema.safeParse({
        ...valid,
        storefrontDescription: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
  it('makes only the minimal read public and requires the existing update permission for publication', () => {
    expect(
      Reflect.getMetadata(
        IS_SKIP_AUTH,
        PromotionsController.prototype.featured,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        HEADERS_METADATA,
        PromotionsController.prototype.featured,
      ),
    ).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PromotionsController.prototype.updateStorefront,
      ),
    ).toEqual([PermissionKeys.PROMOTIONS_UPDATE]);
    expect(
      Reflect.getMetadata(
        IS_SKIP_AUTH,
        PromotionsController.prototype.findActive,
      ),
    ).toBeUndefined();
  });
});
