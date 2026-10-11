import { Prisma } from '@prisma/client';
import type {
  BusinessInsightAnalysis,
  BusinessInsightSnapshot,
  BusinessInsightSuggestions,
} from '../../common/types';

export function buildBusinessInsightAnalysis(
  snapshot: BusinessInsightSnapshot,
  suggestions?: BusinessInsightSuggestions,
): BusinessInsightAnalysis {
  const metrics = new Map(
    snapshot.metrics.map((metric) => [metric.key, metric]),
  );
  const findings: BusinessInsightAnalysis['findings'] = [];
  for (const key of [
    'netReceipts',
    'paidInvoiceCount',
    'estimatedGrossProfit',
  ]) {
    const metric = metrics.get(key);
    if (!metric) continue;
    const comparison = new Prisma.Decimal(metric.value).comparedTo(
      metric.previousValue,
    );
    findings.push({
      title: metric.label,
      kind: 'OBSERVATION',
      detail: `${metric.label} ${comparison > 0 ? 'cao hon' : comparison < 0 ? 'thap hon' : 'khong thay doi so voi'} ky so sanh.`,
      metricKeys: [key],
      action: 'Doi chieu so lieu va gioi han du lieu truoc khi quyet dinh.',
    });
  }
  const limitations = [
    'Doanh so nhom theo ngay tao hoa don; hoan tien cua nhom duoc tinh den luc snapshot, khong phai dong tien trong ky.',
    'Hao hut nhom theo ngay ghi nhan. Loi nhuan gop la uoc tinh, khong phai loi nhuan rong ke toan.',
  ];
  const sold = metrics.get('soldItemCount');
  const costed = metrics.get('itemsWithCostSnapshot');
  const zeroCost = metrics.get('zeroCostSnapshotCount');
  if (
    !sold ||
    !costed ||
    !zeroCost ||
    new Prisma.Decimal(costed.value).lt(sold.value) ||
    new Prisma.Decimal(costed.previousValue).lt(sold.previousValue) ||
    new Prisma.Decimal(zeroCost.value).gt(0) ||
    new Prisma.Decimal(zeroCost.previousValue).gt(0)
  ) {
    limitations.push(
      'Snapshot chi phi thieu hoac bang khong; khong ket luan ve hieu qua loi nhuan.',
    );
    const index = findings.findIndex((finding) =>
      finding.metricKeys.includes('estimatedGrossProfit'),
    );
    if (index >= 0) findings.splice(index, 1);
  }
  if (!suggestions)
    limitations.push(
      'Chua co gia thuyet AI; cac quan sat khong xac nhan nguyen nhan.',
    );
  return {
    summary: suggestions
      ? 'Quan sat do he thong tinh tu snapshot. Gia thuyet AI chua duoc kiem chung; can quan ly doi chieu.'
      : 'Chi hien thi quan sat tu so lieu he thong; chua co gia thuyet AI.',
    findings: [...findings, ...(suggestions?.findings ?? [])],
    limitations: [...limitations, ...(suggestions?.limitations ?? [])],
  };
}
