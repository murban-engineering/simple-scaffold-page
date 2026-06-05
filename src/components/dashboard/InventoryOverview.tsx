import { Fragment, useState, useMemo, useEffect } from "react";
import { Package, ArrowRight, Search, Boxes, Warehouse, Truck, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScaffolds } from "@/hooks/useScaffolds";
import { useAllClientSites } from "@/hooks/useClientSites";
import { useHireQuotations } from "@/hooks/useHireQuotations";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// @ts-ignore
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatReportDate, formatReportDateTime } from "@/lib/accountingDates";
import { getInventoryGroupKey, getInventoryGroupLabel } from "@/lib/inventoryGrouping";
import { buildCombinedInventoryMatrix, openCombinedInventoryReport } from "@/lib/combinedInventoryReport";

const InventoryOverview = ({ externalSearch, chartOnly }: { externalSearch?: string; chartOnly?: boolean }) => {
  const { data: scaffolds, isLoading, error } = useScaffolds();
  const { data: hireQuotations = [] } = useHireQuotations();
  const { data: allClientSites = [] } = useAllClientSites();
  const [search, setSearch] = useState("");

  // Sync with external search from header
  useEffect(() => {
    if (externalSearch !== undefined) setSearch(externalSearch);
  }, [externalSearch]);

  const dedupedScaffolds = useMemo(() => {
    if (!scaffolds) return [];
    // Group by part_number (or description if no part_number) to find duplicates
    const groups = new Map<string, typeof scaffolds>();
    for (const s of scaffolds) {
      const key = (s.part_number ?? s.description ?? s.id).toLowerCase().trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    // For each group, keep the one with most data fields populated (mass, weekly_rate, unit_price)
    return Array.from(groups.values()).map((group) => {
      if (group.length === 1) return group[0];
      return group.reduce((best, candidate) => {
        const score = (item: typeof group[0]) =>
          (item.mass_per_item != null ? 1 : 0) +
          (item.weekly_rate != null ? 1 : 0) +
          (item.unit_price != null ? 1 : 0);
        return score(candidate) >= score(best) ? candidate : best;
      });
    });
  }, [scaffolds]);

  const filteredAndGrouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? dedupedScaffolds.filter(
          (s) =>
            (s.part_number ?? "").toLowerCase().includes(q) ||
            (s.description ?? "").toLowerCase().includes(q) ||
            s.scaffold_type.toLowerCase().includes(q)
        )
      : dedupedScaffolds;

    return [...filtered].sort((a, b) => {
      const ga = getInventoryGroupKey(a.description ?? a.scaffold_type);
      const gb = getInventoryGroupKey(b.description ?? b.scaffold_type);
      if (ga !== gb) return ga.localeCompare(gb);
      return compareInventoryPartNumber(a, b);
    });
  }, [dedupedScaffolds, search]);

  const inventoryMetrics = useMemo(() => {
    return dedupedScaffolds.map((item) => {
      const availableStock = item.quantity ?? 0;
      // qty_at_start is the immutable baseline; only changes when new stock is added.
      const openingStock = item.qty_at_start ?? 0;
      // On Hire = physical stock dispatched = Qty at Start minus current Available in yard.
      // This is the ground truth — scaffold.quantity IS reduced on every dispatch.
      const onHire = Math.max(openingStock - availableStock, 0);
      return {
        id: item.id,
        availableStock,
        onHire,
        openingStock,
      };
    });
  }, [dedupedScaffolds]);

  const totals = useMemo(() => {
    return dedupedScaffolds.reduce(
      (acc, item, idx) => {
        const metrics = inventoryMetrics[idx];
        if (!metrics) return acc;
        const mass = item.mass_per_item ?? 0;
        acc.openingStock += metrics.openingStock;
        acc.availableStock += metrics.availableStock;
        acc.onHire += metrics.onHire;
        acc.openingStockTonnage += metrics.openingStock * mass;
        acc.availableTonnage += metrics.availableStock * mass;
        acc.onHireTonnage += metrics.onHire * mass;
        return acc;
      },
      { openingStock: 0, availableStock: 0, onHire: 0, openingStockTonnage: 0, availableTonnage: 0, onHireTonnage: 0 }
    );
  }, [inventoryMetrics, dedupedScaffolds]);

  const metricsById = useMemo(() => {
    return new Map(inventoryMetrics.map((metric) => [metric.id, metric]));
  }, [inventoryMetrics]);

  const chartData = useMemo(
    () => [
      { name: "Qty at Start", quantity: totals.openingStock },
      { name: "Available", quantity: totals.availableStock },
      { name: "On Hire", quantity: totals.onHire },
    ],
    [totals.availableStock, totals.onHire, totals.openingStock]
  );

  const formatCurrency = (value: number | null) => {
    if (value === null || value === undefined) return "-";
    return `Ksh ${value.toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;
  };

  const formatMass = (value: number | null) => {
    if (value === null || value === undefined) return "-";
    return `${value} kg`;
  };

  const combinedInventoryMatrix = useMemo(
    () => buildCombinedInventoryMatrix(hireQuotations, allClientSites),
    [allClientSites, hireQuotations]
  );

  const handlePrintCombinedReport = () => {
    openCombinedInventoryReport(combinedInventoryMatrix);
  };

  const getStatusBadge = (status: string) => {
    const statusStyles: Record<string, string> = {
      available: "status-available",
      in_use: "status-in-use",
      damaged: "status-damaged",
      maintenance: "bg-amber-500/20 text-amber-700 border-amber-500/30",
    };
    return statusStyles[status] || "";
  };

  const handlePrintInventoryReport = () => {
    if (!dedupedScaffolds?.length) {
      window.alert("No inventory items to print.");
      return;
    }

    const origin = window.location.origin;
    const printDate = formatReportDateTime(new Date());
    const docDate = formatReportDate(new Date());

    // Sort and group deduplicated scaffolds only
    const sorted = [...dedupedScaffolds].sort((a, b) => {
      const ga = getInventoryGroupKey(a.description ?? a.scaffold_type);
      const gb = getInventoryGroupKey(b.description ?? b.scaffold_type);
      if (ga !== gb) return ga.localeCompare(gb);
      return compareInventoryPartNumber(a, b);
    });

    let lastGroup = "";
    const tableRows = sorted.map((item) => {
      const group = getInventoryGroupKey(item.description ?? item.scaffold_type);
      const groupLabel = getInventoryGroupLabel(group);
      const showGroupHeader = group !== lastGroup;
      lastGroup = group;
      const metrics = metricsById.get(item.id);
      const available = metrics?.availableStock ?? 0;
      const onHire = metrics?.onHire ?? 0;
      const qtyAtStart = metrics?.openingStock ?? 0;
      let rows = "";
      if (showGroupHeader) {
        rows += `<tr class="group-header"><td colspan="8">${groupLabel}</td></tr>`;
      }
      rows += `<tr>
        <td class="mono">${item.part_number || "-"}</td>
        <td>${item.description || item.scaffold_type}</td>
        <td class="center">${qtyAtStart}</td>
        <td class="center available">${available}</td>
        <td class="center on-hire">${onHire}</td>
        <td class="center">${item.mass_per_item != null ? item.mass_per_item + " kg" : "-"}</td>
        <td class="center"></td>
        <td class="center"></td>
      </tr>`;
      return rows;
    }).join("");

    // Build per-group chart data
    const groupTotals = new Map<string, { available: number; onHire: number; qtyAtStart: number }>();
    sorted.forEach((item) => {
      const group = getInventoryGroupKey(item.description ?? item.scaffold_type);
      const label = getInventoryGroupLabel(group);
      const metrics = metricsById.get(item.id);
      const existing = groupTotals.get(label) ?? { available: 0, onHire: 0, qtyAtStart: 0 };
      existing.available += metrics?.availableStock ?? 0;
      existing.onHire += metrics?.onHire ?? 0;
      existing.qtyAtStart += metrics?.openingStock ?? 0;
      groupTotals.set(label, existing);
    });
    const groupChartData = Array.from(groupTotals.entries()).filter(([, v]) => v.qtyAtStart > 0);

    // SVG bar chart helper — generates an inline SVG bar chart
    const buildBarSVG = (
      bars: { label: string; value: number; color: string }[],
      svgWidth: number,
      svgHeight: number,
      chartTitle: string
    ) => {
      const maxVal = Math.max(...bars.map((b) => b.value), 1);
      const barAreaH = svgHeight - 50; // room for x-labels + title
      const barW = Math.max(14, Math.floor((svgWidth - 40) / bars.length) - 6);
      const gap = Math.max(4, Math.floor((svgWidth - 40 - barW * bars.length) / (bars.length + 1)));
      const barsHtml = bars.map((bar, i) => {
        const barH = Math.max(2, Math.round((bar.value / maxVal) * barAreaH));
        const x = 40 + gap + i * (barW + gap);
        const y = 20 + barAreaH - barH;
        const labelX = x + barW / 2;
        const labelText = bar.label;
        return `
          <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${bar.color}" rx="2"/>
          <text x="${labelX}" y="${y - 3}" text-anchor="middle" font-size="7" fill="#1f2937" font-family="Arial,sans-serif">${bar.value}</text>
          <text x="${labelX}" y="${20 + barAreaH + 10}" text-anchor="middle" font-size="6.5" fill="#374151" font-family="Arial,sans-serif">${labelText}</text>
        `;
      }).join("");
      // Y-axis ticks
      const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const val = Math.round(maxVal * pct);
        const y = 20 + barAreaH - Math.round(pct * barAreaH);
        return `
          <line x1="36" y1="${y}" x2="${svgWidth - 4}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>
          <text x="34" y="${y + 3}" text-anchor="end" font-size="6" fill="#6b7280" font-family="Arial,sans-serif">${val}</text>
        `;
      }).join("");
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block;">
        <text x="${svgWidth / 2}" y="12" text-anchor="middle" font-size="9" font-weight="800" fill="#111827" font-family="Arial,sans-serif">${chartTitle}</text>
        ${yTicks}
        ${barsHtml}
      </svg>`;
    };

    // Chart 1: Overall summary (Qty at Start / Available / On Hire)
    const overallSVG = buildBarSVG(
      [
        { label: "Qty at Start", value: totals.openingStock, color: "#6366f1" },
        { label: "Available", value: totals.availableStock, color: "#059669" },
        { label: "On Hire", value: totals.onHire, color: "#d97706" },
      ],
      280, 160,
      "Overall Inventory"
    );

    // Chart 2: Tonnage overview
    const tonnageSVG = buildBarSVG(
      [
        { label: "Total (t)", value: parseFloat((totals.openingStockTonnage / 1000).toFixed(2)), color: "#6366f1" },
        { label: "Available (t)", value: parseFloat((totals.availableTonnage / 1000).toFixed(2)), color: "#059669" },
        { label: "On Hire (t)", value: parseFloat((totals.onHireTonnage / 1000).toFixed(2)), color: "#d97706" },
      ],
      280, 160,
      "Tonnage Overview (tonnes)"
    );

    // Chart 3: Per-group Available vs On Hire
    const groupAvailBars = groupChartData.map(([label, v]) => ({ label, value: v.available, color: "#059669" }));
    const groupHireBars = groupChartData.map(([label, v]) => ({ label, value: v.onHire, color: "#d97706" }));
    const groupSVGWidth = Math.max(500, groupChartData.length * 50 + 60);
    // Grouped bars: available + onHire side by side per category
    const buildGroupedSVG = (svgWidth: number, svgHeight: number) => {
      const maxVal = Math.max(...groupChartData.map(([, v]) => Math.max(v.available, v.onHire)), 1);
      const barAreaH = svgHeight - 60;
      const pairW = Math.max(30, Math.floor((svgWidth - 50) / groupChartData.length));
      const singleBarW = Math.max(8, Math.floor(pairW * 0.38));
      const pairGap = 3;
      const barsHtml = groupChartData.map(([label, v], i) => {
        const x = 46 + i * pairW + Math.floor(pairW / 2) - singleBarW - pairGap / 2;
        const availH = Math.max(1, Math.round((v.available / maxVal) * barAreaH));
        const hireH = Math.max(1, Math.round((v.onHire / maxVal) * barAreaH));
        const availY = 18 + barAreaH - availH;
        const hireY = 18 + barAreaH - hireH;
        const labelX = 46 + i * pairW + Math.floor(pairW / 2);
        const labelText = label;
        return `
          <rect x="${x}" y="${availY}" width="${singleBarW}" height="${availH}" fill="#059669" rx="2"/>
          <text x="${x + singleBarW / 2}" y="${availY - 2}" text-anchor="middle" font-size="6" fill="#059669" font-family="Arial,sans-serif">${v.available}</text>
          <rect x="${x + singleBarW + pairGap}" y="${hireY}" width="${singleBarW}" height="${hireH}" fill="#d97706" rx="2"/>
          <text x="${x + singleBarW + pairGap + singleBarW / 2}" y="${hireY - 2}" text-anchor="middle" font-size="6" fill="#d97706" font-family="Arial,sans-serif">${v.onHire}</text>
          <text x="${labelX}" y="${18 + barAreaH + 10}" text-anchor="middle" font-size="6" fill="#374151" font-family="Arial,sans-serif">${labelText}</text>
        `;
      }).join("");
      const yTicks = [0, 0.5, 1].map((pct) => {
        const val = Math.round(maxVal * pct);
        const y = 18 + barAreaH - Math.round(pct * barAreaH);
        return `
          <line x1="42" y1="${y}" x2="${svgWidth - 4}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>
          <text x="40" y="${y + 3}" text-anchor="end" font-size="6" fill="#6b7280" font-family="Arial,sans-serif">${val}</text>
        `;
      }).join("");
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block;max-width:100%;">
        <text x="${svgWidth / 2}" y="11" text-anchor="middle" font-size="9" font-weight="800" fill="#111827" font-family="Arial,sans-serif">Available vs On Hire by Category</text>
        ${yTicks}
        ${barsHtml}
        <!-- Legend -->
        <rect x="46" y="${svgHeight - 18}" width="8" height="8" fill="#059669" rx="1"/>
        <text x="57" y="${svgHeight - 11}" font-size="7" fill="#059669" font-family="Arial,sans-serif">Available</text>
        <rect x="110" y="${svgHeight - 18}" width="8" height="8" fill="#d97706" rx="1"/>
        <text x="121" y="${svgHeight - 11}" font-size="7" fill="#d97706" font-family="Arial,sans-serif">On Hire</text>
      </svg>`;
    };
    const groupedSVG = buildGroupedSVG(groupSVGWidth, 180);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>Inventory Report - OTNO Access Solutions</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: "Arial Narrow", Arial, sans-serif; font-size: 9.5px; color: #1f2937; line-height: 1.3; padding: 12px; }
        .print-controls {
          position: fixed; top: 12px; right: 12px; z-index: 9999;
          display: flex; padding: 8px; background: rgba(255,255,255,0.97);
          border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .print-button { border: 1px solid #333; border-radius: 6px; background: #111; color: #fff; padding: 6px 12px; font-size: 11px; font-weight: 600; cursor: pointer; }
        .report-header { display: grid; grid-template-columns: 1.5fr 1fr; gap: 12px; margin-bottom: 14px; }
        .header-left { display: grid; gap: 8px; }
        .header-right { display: grid; gap: 6px; }
        .brand-block { padding: 8px 10px; }
        .brand-top { display: flex; align-items: center; gap: 10px; margin-bottom: 5px; }
        .brand-logo { width: 120px; height: auto; }
        .brand-title { font-size: 14px; font-weight: 800; line-height: 1.15; color: #111827; }
        .brand-meta { font-size: 9px; color: #374151; }
        .panel { border: 1px solid #111827; border-radius: 6px; padding: 7px 9px; }
        .panel h3 { font-size: 11px; font-weight: 800; margin-bottom: 4px; color: #111827; }
        .report-title { font-size: 18px; font-weight: 900; letter-spacing: -0.2px; color: #111827; margin-bottom: 6px; }
        .info-row { display: flex; gap: 4px; margin-bottom: 2px; align-items: baseline; }
        .info-label { font-weight: 700; color: #111827; min-width: 110px; font-size: 9px; }
        .info-sep { color: #6b7280; }
        .info-value { color: #111827; word-break: break-word; flex: 1; font-size: 9px; }
        /* Charts section */
        .charts-section { margin-bottom: 14px; page-break-inside: avoid; }
        .charts-section h3 { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; color: #374151; margin-bottom: 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }
        .charts-row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
        .chart-box { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; background: #fafafa; flex: 1; min-width: 0; overflow: hidden; }
        .chart-box-wide { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; background: #fafafa; width: 100%; overflow: hidden; }
        /* Table */
        table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
        th, td { border: 1px solid #d1d5db; padding: 4px 6px; font-size: 8.5px; vertical-align: middle; }
        th { background: #f3f4f6; text-transform: uppercase; letter-spacing: 0.2px; font-weight: 800; font-size: 8px; }
        tr.group-header td { background: #1f2937; color: #fff; font-weight: 800; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; padding: 5px 6px; }
        .center { text-align: center; }
        .mono { font-family: monospace; }
        .available { color: #059669; font-weight: 700; }
        .on-hire { color: #d97706; font-weight: 700; }
        .report-page { display: flex; flex-direction: column; min-height: 92vh; }
        .signoff-section { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin: 10px 0 12px; }
        .signoff-field { display: flex; flex-direction: column; gap: 5px; }
        .signoff-label { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.25px; color: #374151; }
        .signoff-line { height: 16px; border-bottom: 1px solid #6b7280; }
        .footer-wrap { margin-top: auto; }
        .footer-brand { background: #facc15; color: #1f2937; font-weight: 700; display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; }
        .footer-legal { text-align: center; font-size: 7.5px; color: #4b5563; padding: 3px 8px 4px; border: 1px solid #e5e7eb; border-top: none; }
        .footer-processed { display: flex; justify-content: space-between; font-size: 7px; color: #6b7280; padding: 4px 0 0; }
        @media print {
          body { padding: 0 !important; font-size: 8.5px; }
          .print-controls { display: none; }
          @page { size: A4; margin: 8mm; }
          tr { page-break-inside: avoid; }
          thead { display: table-header-group; }
          tr.group-header { page-break-after: avoid; }
          .charts-section { page-break-inside: avoid; }
        }
      </style>
    </head><body>
      <div class="print-controls">
        <button type="button" class="print-button" onclick="window.print()">Print Report</button>
      </div>
      <div class="report-page">
        <!-- 4-panel header -->
        <div class="report-header">
          <div class="header-left">
            <div class="brand-block">
              <div class="brand-top">
                <img src="${origin}/otn-logo-red.png" alt="OTNO Logo" class="brand-logo" />
                <div class="brand-title">OTNO Access Solutions</div>
              </div>
              <div class="brand-meta"><strong>Reg No:</strong> P052471711M</div>
            </div>
            <div class="panel">
              <h3>Inventory Summary</h3>
              <div class="info-row"><span class="info-label">Total Items (lines)</span><span class="info-sep">:</span><span class="info-value">${dedupedScaffolds.length}</span></div>
              <div class="info-row"><span class="info-label">Total Qty at Start</span><span class="info-sep">:</span><span class="info-value">${totals.openingStock}</span></div>
              <div class="info-row"><span class="info-label">Available Stock</span><span class="info-sep">:</span><span class="info-value" style="color:#059669;font-weight:800;">${totals.availableStock}</span></div>
              <div class="info-row"><span class="info-label">On Hire</span><span class="info-sep">:</span><span class="info-value" style="color:#d97706;font-weight:800;">${totals.onHire}</span></div>
              <div class="info-row"><span class="info-label">Total Tonnage</span><span class="info-sep">:</span><span class="info-value">${(totals.openingStockTonnage / 1000).toFixed(2)} t</span></div>
            </div>
          </div>
          <div class="header-right">
            <h2 class="report-title">Inventory Report</h2>
            <div class="panel">
              <h3>Document Details</h3>
              <div class="info-row"><span class="info-label">Document Type</span><span class="info-sep">:</span><span class="info-value">Inventory Report</span></div>
              <div class="info-row"><span class="info-label">Document Date</span><span class="info-sep">:</span><span class="info-value">${docDate}</span></div>
              <div class="info-row"><span class="info-label">Print Date</span><span class="info-sep">:</span><span class="info-value">${printDate}</span></div>
            </div>
            <div class="panel">
              <h3>Company Details</h3>
              <div class="info-row"><span class="info-label">Company</span><span class="info-sep">:</span><span class="info-value">OTNO Access Solutions</span></div>
              <div class="info-row"><span class="info-label">Address</span><span class="info-sep">:</span><span class="info-value">99215-80107 Mombasa, Kenya</span></div>
              <div class="info-row"><span class="info-label">Location</span><span class="info-sep">:</span><span class="info-value">Embakasi, Old North Airport Rd, next to Naivas Embakasi</span></div>
              <div class="info-row"><span class="info-label">Email</span><span class="info-sep">:</span><span class="info-value">info@otno.ke</span></div>
            </div>
          </div>
        </div>

        <!-- Charts section -->
        <div class="charts-section">
          <h3>Inventory Analytics</h3>
          <div class="charts-row">
            <div class="chart-box">${overallSVG}</div>
            <div class="chart-box">${tonnageSVG}</div>
          </div>
          <div class="chart-box-wide">${groupedSVG}</div>
        </div>

        <!-- Items table -->
        <table>
          <thead>
            <tr>
              <th style="width:90px">Part No.</th>
              <th>Description</th>
              <th class="center" style="width:70px">Qty at Start</th>
              <th class="center" style="width:70px">Available</th>
              <th class="center" style="width:70px">On Hire</th>
              <th class="center" style="width:80px">Mass/Item</th>
              <th class="center" style="width:70px">Stock</th>
              <th class="center" style="width:90px">Discrepancy</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>

        <div class="signoff-section">
          <div class="signoff-field">
            <span class="signoff-label">Name</span>
            <div class="signoff-line"></div>
          </div>
          <div class="signoff-field">
            <span class="signoff-label">Date</span>
            <div class="signoff-line"></div>
          </div>
          <div class="signoff-field">
            <span class="signoff-label">Signature</span>
            <div class="signoff-line"></div>
          </div>
        </div>

        <!-- Footer -->
        <div class="footer-wrap">
          <div class="footer-brand">
            <span>OTNO Access Solutions — Your Trusted Scaffolding &amp; Access Partner.</span>
            <img src="${origin}/otn-logo-red.png" alt="OTNO" style="width:80px;height:auto;"/>
          </div>
          <div class="footer-legal">All transactions are subject to our standard Terms of Trade which can be found at: info@otno.ke</div>
          <div class="footer-processed">
            <div>Processed Date : ${docDate}</div>
            <div>Print date : ${printDate}</div>
          </div>
        </div>
      </div>
    </body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (!win) { window.alert("Please allow popups to print the report."); URL.revokeObjectURL(url); return; }
    win.addEventListener("unload", () => URL.revokeObjectURL(url), { once: true });
  };

  if (chartOnly) {
    const safeOpeningStock = Math.max(totals.openingStock, 1);
    const availablePct = Math.round((totals.availableStock / safeOpeningStock) * 100);
    // Use actual on-hire from quotation delivery tracking, not a computed difference
    const onHirePct = Math.round((totals.onHire / safeOpeningStock) * 100);
    const availableArc = (totals.availableStock / safeOpeningStock) * 360;
    const onHireArc = (totals.onHire / safeOpeningStock) * 360;

    return (
      <div className="animate-fade-in rounded-3xl border border-white/60 bg-gradient-to-br from-[hsla(174,30%,92%,0.86)] via-[hsla(188,40%,94%,0.88)] to-[hsla(268,48%,93%,0.83)] p-6 text-slate-900 shadow-[0_22px_40px_-24px_rgba(15,23,42,0.4)] backdrop-blur-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-teal-200/70 bg-white/75 p-2 shadow-sm backdrop-blur-md">
              <Package className="h-4 w-4 text-teal-600" />
            </div>
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">Inventory Analysis</h3>
          </div>
          <span className="text-xs text-teal-700">Monthly</span>
        </div>

        <div className="flex flex-col items-center gap-6">
          <div className="relative flex h-56 w-56 items-center justify-center">
            <div
              className="h-52 w-52 rounded-full shadow-[0_16px_40px_-22px_rgba(8,145,178,0.6)]"
              style={{
                background: `conic-gradient(#14b8a6 0deg ${availableArc}deg, #c4b5fd ${availableArc}deg ${availableArc + onHireArc}deg, #e2e8f0 ${availableArc + onHireArc}deg 360deg)`,
              }}
            />
            <div className="absolute flex h-36 w-36 flex-col items-center justify-center rounded-full border border-white/70 bg-white/80 text-center shadow-inner backdrop-blur-md">
              <span className="text-4xl font-bold text-slate-900">{onHirePct}%</span>
              <span className="text-xs text-slate-500">{totals.onHire} units</span>
            </div>
          </div>

          <div className="flex items-center gap-6 text-xs font-medium text-slate-700">
            <span className="inline-flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-teal-500" />
              Available
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-violet-400" />
              On Hire
            </span>
          </div>

          <div className="w-full space-y-3 rounded-2xl border border-white/60 bg-white/60 p-4 backdrop-blur-md">
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 text-slate-700"><span className="h-2 w-2 rounded-full bg-teal-500" /> Available</span>
              <span className="font-semibold text-slate-900">{totals.availableStock}</span>
              <span className="text-xs text-teal-700">{availablePct}%</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 text-slate-700"><span className="h-2 w-2 rounded-full bg-violet-400" /> On Hire</span>
              <span className="font-semibold text-slate-900">{totals.onHire}</span>
              <span className="text-xs text-violet-600">{onHirePct}%</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 text-slate-700"><span className="h-2 w-2 rounded-full bg-sky-400" /> Qty at Start</span>
              <span className="font-semibold text-slate-900">{totals.openingStock}</span>
              <span className="text-xs text-slate-500">100%</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Scaffold Inventory</h2>
            <p className="text-sm text-muted-foreground">
              {filteredAndGrouped.length} of {scaffolds?.length || 0} items
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-accent hover:text-accent">
            View All <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrintCombinedReport}
            disabled={!combinedInventoryMatrix.itemRows.length}
            className="gap-1.5"
          >
            <Printer className="w-4 h-4" /> Print Combined Report
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrintInventoryReport} className="gap-1.5">
            <Printer className="w-4 h-4" /> Print Report
          </Button>
        </div>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by part no., description or type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 mb-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Boxes className="h-4 w-4" /> Total Qty at Start
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{totals.openingStock}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Warehouse className="h-4 w-4" /> Current Available Stock
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{totals.availableStock}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Truck className="h-4 w-4" /> Total Qty On Hire
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{totals.onHire}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Boxes className="h-4 w-4" /> Total Tonnage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{(totals.openingStockTonnage / 1000).toFixed(2)} t</p>
            <p className="text-xs text-muted-foreground">{totals.openingStockTonnage.toLocaleString()} kg</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Warehouse className="h-4 w-4" /> Available Tonnage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{(totals.availableTonnage / 1000).toFixed(2)} t</p>
            <p className="text-xs text-muted-foreground">{totals.availableTonnage.toLocaleString()} kg</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Truck className="h-4 w-4" /> On Hire Tonnage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{(totals.onHireTonnage / 1000).toFixed(2)} t</p>
            <p className="text-xs text-muted-foreground">{totals.onHireTonnage.toLocaleString()} kg</p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-6 h-60 w-full rounded-xl border border-border/60 bg-background/40 p-3">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip
              contentStyle={{
                borderRadius: "10px",
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--card))",
                fontSize: "12px",
              }}
            />
            <Bar dataKey="quantity" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-8 text-muted-foreground">
          <p>Unable to load inventory data</p>
        </div>
      ) : filteredAndGrouped.length > 0 ? (
        <ScrollArea className="h-[400px]">
          <Table>
            <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Part No.</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-center">Qty at Start</TableHead>
                  <TableHead className="text-center">Available</TableHead>
                  <TableHead className="text-center">On Hire</TableHead>
                  <TableHead className="text-center">Mass/Item</TableHead>
                  <TableHead className="text-center">Total Mass</TableHead>
                  <TableHead className="text-right">Weekly Rate</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(() => {
                let lastGroup = "";
                return filteredAndGrouped.map((item) => {
                  const group = getInventoryGroupKey(item.description ?? item.scaffold_type);
                  const groupLabel = getInventoryGroupLabel(group);
                  const showHeader = group !== lastGroup;
                  lastGroup = group;
                  const rowMetrics = metricsById.get(item.id);
                  return (
                    <Fragment key={item.id}>
                      {showHeader && (
                        <TableRow key={`group-${group}`} className="bg-muted/50 hover:bg-muted/50">
                          <TableCell colSpan={10} className="py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                            {groupLabel}
                          </TableCell>
                        </TableRow>
                      )}
                      <TableRow key={item.id} className="hover:bg-muted/30">
                        <TableCell className="font-mono text-sm">
                          {item.part_number || "-"}
                        </TableCell>
                        <TableCell className="max-w-[250px] truncate">
                          {item.description || item.scaffold_type}
                        </TableCell>
                        <TableCell className="text-center font-semibold">
                          {rowMetrics?.openingStock ?? 0}
                        </TableCell>
                        <TableCell className="text-center font-semibold text-emerald-600">
                          {rowMetrics?.availableStock ?? 0}
                        </TableCell>
                        <TableCell className="text-center font-semibold text-amber-600">
                          {rowMetrics?.onHire ?? 0}
                        </TableCell>
                        <TableCell className="text-center text-muted-foreground">
                          {formatMass(item.mass_per_item)}
                        </TableCell>
                        <TableCell className="text-center text-muted-foreground">
                          {item.mass_per_item && rowMetrics
                            ? `${((item.mass_per_item) * (rowMetrics.openingStock)).toFixed(2)} kg`
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(item.weekly_rate)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(item.unit_price)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge
                            variant="secondary"
                            className={`${getStatusBadge(item.status)} border capitalize`}
                          >
                            {item.status.replace("_", " ")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                });
              })()}
            </TableBody>
          </Table>
        </ScrollArea>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <Package className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-sm">No scaffolds registered yet.</p>
          <p className="text-xs mt-1">Add scaffolds to see inventory statistics.</p>
        </div>
      )}
    </div>
  );
};

export default InventoryOverview;
