import type { Prisma, VoucherCampaign } from '@prisma/client';
import type { VoucherWalletStatus } from './voucher.types';

export function campaignTerms(campaign: VoucherCampaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    isPublic: campaign.isPublic,
    discountType: campaign.discountType,
    discountValue: campaign.discountValue.toFixed(2),
    maxDiscount: campaign.maxDiscount?.toFixed(2) ?? null,
    minSubtotal: campaign.minSubtotal.toFixed(2),
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
  };
}

export function campaignView(campaign: VoucherCampaign) {
  return {
    ...campaignTerms(campaign),
    status: campaign.status,
    issuanceLimit: campaign.issuanceLimit,
    issuedCount: campaign.issuedCount,
    publishedAt: campaign.publishedAt,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

export const grantInclude = {
  campaign: true,
  redemptions: {
    where: { status: { in: ['RESERVED', 'REDEEMED'] } },
    select: {
      onlineOrderRequestId: true,
      invoiceId: true,
      status: true,
    },
    orderBy: { id: 'asc' },
  },
} as const satisfies Prisma.CustomerVoucherInclude;

export type GrantWithCampaign = Prisma.CustomerVoucherGetPayload<{
  include: typeof grantInclude;
}>;

export function grantStatus(
  grant: GrantWithCampaign,
  now: Date,
): VoucherWalletStatus {
  if (grant.redemptions.some((row) => row.status === 'REDEEMED')) return 'USED';
  if (grant.redemptions.some((row) => row.status === 'RESERVED'))
    return 'RESERVED';
  if (grant.revokedAt) return 'REVOKED';
  if (grant.campaign.endDate <= now) return 'EXPIRED';
  if (grant.campaign.startDate > now) return 'UPCOMING';
  return 'AVAILABLE';
}

export function grantView(grant: GrantWithCampaign, now: Date) {
  return {
    id: grant.id,
    campaignId: grant.campaignId,
    source: grant.source,
    status: grantStatus(grant, now),
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    revokedAt: grant.revokedAt,
    expiresAt: grant.campaign.endDate.toISOString(),
    orderId: grant.redemptions[0]?.onlineOrderRequestId ?? null,
    campaign: campaignTerms(grant.campaign),
    redemptions: grant.redemptions.map((row) => ({
      orderId: row.onlineOrderRequestId,
      invoiceId: row.invoiceId,
      status: row.status,
    })),
  };
}

export function adminGrantView(grant: GrantWithCampaign, now: Date) {
  return {
    ...grantView(grant, now),
    customerId: grant.customerId,
    sourceOrderId: grant.sourceOrderId,
    reason: grant.reason,
  };
}

export function grantStatusWhere(
  status: VoucherWalletStatus | undefined,
  now: Date,
): Prisma.CustomerVoucherWhereInput {
  const unused: Prisma.CustomerVoucherWhereInput = {
    revokedAt: null,
    redemptions: { none: { status: { in: ['RESERVED', 'REDEEMED'] } } },
  };
  switch (status) {
    case 'RESERVED':
    case 'USED':
      return {
        redemptions: {
          some: { status: status === 'USED' ? 'REDEEMED' : 'RESERVED' },
        },
      };
    case 'REVOKED':
      return { revokedAt: { not: null } };
    case 'EXPIRED':
      return { ...unused, campaign: { endDate: { lte: now } } };
    case 'UPCOMING':
      return { ...unused, campaign: { startDate: { gt: now } } };
    case 'AVAILABLE':
      return {
        ...unused,
        campaign: {
          publishedAt: { not: null },
          startDate: { lte: now },
          endDate: { gt: now },
        },
      };
    default:
      return {};
  }
}
