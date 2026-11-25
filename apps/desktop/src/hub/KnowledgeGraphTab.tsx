import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  copyToClipboard,
  deleteMemoryNode,
  getKnowledgeGraph,
  listSessionGraphs,
  readGraphMarkdown,
} from "../lib/ipc";
import type {
  KgEdgeDto,
  KgNodeDto,
  KnowledgeGraphDto,
  SessionGraphSummaryDto,
} from "../types";
import {
  CheckIcon,
  CopyIcon,
  GraphIcon,
  MaximizeIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./HubIcons";

interface PositionedNode {
  node: KgNodeDto;
  x: number;
  y: number;
  tier: number;
}

const NODE_COLORS: Record<
  string,
  { fill: string; stroke: string; badge: string; label: string }
> = {
  app: {
    fill: "#0E293B",
    stroke: "#38BDF8",
    badge: "bg-sky-400/15 text-sky-300 border-sky-400/35",
    label: "App",
  },
  screen: {
    fill: "#1E1F3B",
    stroke: "#818CF8",
    badge: "bg-indigo-400/15 text-indigo-300 border-indigo-400/35",
    label: "Screen",
  },
  control: {
    fill: "#0E2E24",
    stroke: "#22C55E",
    badge: "bg-emerald-400/15 text-emerald-300 border-emerald-400/35",
    label: "Control",
  },
  intent: {
    fill: "#30210D",
    stroke: "#F59E0B",
    badge: "bg-amber-400/15 text-amber-300 border-amber-400/35",
    label: "Intent",
  },
};

function tierForType(nodeType: string): number {
  const t = nodeType.toLowerCase();
  if (t === "app") return 0;
  if (t === "screen" || t === "window") return 1;
  if (t === "control" || t === "element") return 2;
  return 3;
}

function colorForType(nodeType: string) {
  return (
    NODE_COLORS[nodeType.toLowerCase()] ?? {
      fill: "#1B202C",
      stroke: "#94A3B8",
      badge: "bg-white/10 text-zinc-300 border-white/20",
      label: nodeType,
    }
  );
}

function truncateLabel(text: string, maxLen = 22): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

export const KnowledgeGraphTab: React.FC = () => {
  const [graph, setGraph] = useState<KnowledgeGraphDto>({
    nodes: [],
    edges: [],
    sessions: [],
    master_md_path: null,
  });
  const [sessionList, setSessionList] = useState<SessionGraphSummaryDto[]>([]);
  const [loading, setLoading] = useState(false);

  const [appFilter, setAppFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(
    null,
  );
  const selectedSessionPathRef = useRef<string | null>(null);
  selectedSessionPathRef.current = selectedSessionPath;
  const [markdownContent, setMarkdownContent] = useState<string>("");
  const [loadingMarkdown, setLoadingMarkdown] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);

  // SVG pan & zoom
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const loadGraphData = useCallback(async (app?: string) => {
    setLoading(true);
    try {
      const [kg, sessions] = await Promise.all([
        getKnowledgeGraph(app || null),
        listSessionGraphs(null, 50),
      ]);
      setGraph(kg);
      const mergedSessions = sessions.length > 0 ? sessions : kg.sessions;
      setSessionList(mergedSessions);
      if (!selectedSessionPathRef.current && mergedSessions.length > 0) {
        const firstPath = mergedSessions[0].graph_md_path;
        if (firstPath) {
          setSelectedSessionPath(firstPath);
          const md = await readGraphMarkdown(firstPath);
          setMarkdownContent(md);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGraphData(appFilter);
  }, [appFilter, loadGraphData]);

  const handleOpenMarkdown = async (path: string) => {
    if (!path) return;
    setSelectedSessionPath(path);
    setLoadingMarkdown(true);
    try {
      const text = await readGraphMarkdown(path);
      setMarkdownContent(text);
    } finally {
      setLoadingMarkdown(false);
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    setDeletingId(nodeId);
    try {
      await deleteMemoryNode(nodeId);
      setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
      await loadGraphData(appFilter);
    } finally {
      setDeletingId(null);
    }
  };

  const uniqueApps = useMemo(() => {
    const apps = new Set<string>();
    for (const n of graph.nodes) {
      if (n.app_exe) apps.add(n.app_exe);
    }
    return Array.from(apps).sort();
  }, [graph.nodes]);

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return graph.nodes.filter((n) => {
      if (typeFilter !== "all" && n.node_type.toLowerCase() !== typeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        n.label.toLowerCase().includes(q) ||
        n.app_exe.toLowerCase().includes(q) ||
        n.node_type.toLowerCase().includes(q)
      );
    });
  }, [graph.nodes, searchQuery, typeFilter]);

  const visibleNodeIds = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes],
  );

  const filteredEdges = useMemo(() => {
    return graph.edges.filter(
      (e) => visibleNodeIds.has(e.from_node) && visibleNodeIds.has(e.to_node),
    );
  }, [graph.edges, visibleNodeIds]);

  const layout = useMemo(() => {
    const buckets: KgNodeDto[][] = [[], [], [], []];
    for (const node of filteredNodes) {
      buckets[tierForType(node.node_type)].push(node);
    }
    for (const b of buckets) {
      b.sort((a, c) => c.hit_count - a.hit_count);
    }

    const colX = [110, 310, 520, 730];
    const maxRows = Math.max(1, ...buckets.map((b) => b.length));
    const rowSpacing = 74;
    const height = Math.max(380, maxRows * rowSpacing + 80);

    const positioned: PositionedNode[] = [];
    const byId = new Map<string, PositionedNode>();

    buckets.forEach((bucket, tier) => {
      const totalH = Math.max(1, bucket.length - 1) * rowSpacing;
      const startY = (height - totalH) / 2;
      bucket.forEach((node, idx) => {
        const item: PositionedNode = {
          node,
          x: colX[tier],
          y: bucket.length === 1 ? height / 2 : startY + idx * rowSpacing,
          tier,
        };
        positioned.push(item);
        byId.set(node.id, item);
      });
    });

    return { positioned, byId, width: 860, height };
  }, [filteredNodes]);

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  const connectedEdges = useMemo<KgEdgeDto[]>(() => {
    if (!selectedNode) return [];
    return graph.edges.filter(
      (e) => e.from_node === selectedNode.id || e.to_node === selectedNode.id,
    );
  }, [graph.edges, selectedNode]);

  return (
    <div className="space-y-4" data-testid="panel-graph">
      {/* Filter & Search Header */}
      <section className="rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <SearchIcon className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Filter Knowledge Graph"
              data-testid="kg-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search nodes, controls, apps…"
              className="pl-8 pr-3 py-1.5 rounded-xl bg-[#090B10] border border-white/15 text-[12.5px] text-zinc-100 placeholder-zinc-500 w-56 focus:outline-none focus:border-sky-400"
            />
          </div>

          <select
            aria-label="Filter by App"
            data-testid="kg-app-filter"
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
            className="rounded-xl bg-[#090B10] border border-white/15 px-3 py-1.5 text-[12.5px] text-zinc-100"
          >
            <option value="">All Apps</option>
            {uniqueApps.map((app) => (
              <option key={app} value={app}>
                {app}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 bg-[#090B10] p-1 rounded-xl border border-white/10">
            {(["all", "app", "screen", "control", "intent"] as const).map(
              (kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setTypeFilter(kind)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-colors ${
                    typeFilter === kind
                      ? "bg-sky-400 text-slate-950 font-semibold"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {kind}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {graph.master_md_path && (
            <button
              type="button"
              onClick={() => void handleOpenMarkdown(graph.master_md_path!)}
              className="px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-[12px] text-sky-300 font-medium"
            >
              Master knowledge-graph.md
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadGraphData(appFilter)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-[12px] text-zinc-200"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </section>

      {/* Main Split: Interactive SVG Graph + Session .graph.md Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: SVG Pan/Zoom Explorer + Node Inspector */}
        <section className="lg:col-span-7 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <GraphIcon className="w-4 h-4 text-sky-300" />
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                App → Screen → Control → Intent Graph
              </h2>
              <span className="text-[11px] font-mono text-zinc-400">
                ({filteredNodes.length} nodes · {filteredEdges.length} edges)
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Zoom Out Graph"
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300"
              >
                <ZoomOutIcon className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-mono text-zinc-400 px-1.5">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom In Graph"
                onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.15).toFixed(2)))}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300"
              >
                <ZoomInIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Reset Graph View"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300"
              >
                <MaximizeIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div
            data-testid="kg-svg-stage"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("[data-kg-node]")) return;
              dragRef.current = {
                active: true,
                startX: e.clientX,
                startY: e.clientY,
                origX: pan.x,
                origY: pan.y,
              };
            }}
            onPointerMove={(e) => {
              if (!dragRef.current.active) return;
              setPan({
                x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
                y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
              });
            }}
            onPointerUp={() => {
              dragRef.current.active = false;
            }}
            onPointerLeave={() => {
              dragRef.current.active = false;
            }}
            className="relative h-[340px] rounded-xl bg-[#090B10] border border-white/10 overflow-hidden cursor-grab active:cursor-grabbing select-none"
          >
            {filteredNodes.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <p className="text-[13px] font-medium text-zinc-300">
                  {loading
                    ? "Loading knowledge graph…"
                    : "No learned UI nodes match the current filter."}
                </p>
                <p className="text-[11.5px] text-zinc-500 mt-1">
                  GuideLens automatically records verified App → Screen → Control → Intent paths as you run Live Sessions.
                </p>
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                className="w-full h-full"
              >
                <defs>
                  <marker
                    id="kg-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748B" />
                  </marker>
                </defs>

                {/* Column Tier Headers */}
                <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                  {(["App", "Screen", "Control", "Intent"] as const).map(
                    (colLabel, idx) => (
                      <text
                        key={colLabel}
                        x={[110, 310, 520, 730][idx]}
                        y={24}
                        textAnchor="middle"
                        fill="#64748B"
                        fontSize="11"
                        fontWeight="600"
                      >
                        {colLabel.toUpperCase()}
                      </text>
                    ),
                  )}

                  {/* Edges */}
                  {filteredEdges.map((edge) => {
                    const from = layout.byId.get(edge.from_node);
                    const to = layout.byId.get(edge.to_node);
                    if (!from || !to) return null;
                    const x1 = from.x + 68;
                    const y1 = from.y;
                    const x2 = to.x - 68;
                    const y2 = to.y;
                    const mx = (x1 + x2) / 2;
                    const isHighlighted =
                      selectedNodeId === edge.from_node ||
                      selectedNodeId === edge.to_node;
                    return (
                      <g key={edge.id}>
                        <path
                          d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={isHighlighted ? "#38BDF8" : "#334155"}
                          strokeWidth={isHighlighted ? 2.2 : 1.4}
                          strokeOpacity={isHighlighted ? 0.95 : 0.7}
                          markerEnd="url(#kg-arrow)"
                        />
                        {isHighlighted && edge.intent && (
                          <text
                            x={mx}
                            y={(y1 + y2) / 2 - 6}
                            textAnchor="middle"
                            fill="#BAE6FD"
                            fontSize="10"
                          >
                            {truncateLabel(edge.intent, 24)} (×{edge.success_count})
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Nodes */}
                  {layout.positioned.map(({ node, x, y }) => {
                    const palette = colorForType(node.node_type);
                    const isSelected = selectedNodeId === node.id;
                    return (
                      <g
                        key={node.id}
                        data-kg-node={node.id}
                        data-testid={`kg-node-${node.id}`}
                        transform={`translate(${x}, ${y})`}
                        onClick={() => setSelectedNodeId(node.id)}
                        className="cursor-pointer"
                      >
                        <rect
                          x={-68}
                          y={-22}
                          width={136}
                          height={44}
                          rx={10}
                          fill={palette.fill}
                          stroke={isSelected ? "#FACC15" : palette.stroke}
                          strokeWidth={isSelected ? 2.4 : 1.3}
                        />
                        <text
                          x={0}
                          y={-3}
                          textAnchor="middle"
                          fill="#F4F4F5"
                          fontSize="11.5"
                          fontWeight="600"
                        >
                          {truncateLabel(node.label, 18)}
                        </text>
                        <text
                          x={0}
                          y={13}
                          textAnchor="middle"
                          fill="#94A3B8"
                          fontSize="9.5"
                        >
                          {node.node_type} · ×{node.hit_count}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
            )}
          </div>

          {/* Selected Node Inspector */}
          <div
            data-testid="kg-node-inspector"
            className="rounded-xl bg-[#090B10]/90 border border-white/[0.08] p-3.5"
          >
            {selectedNode ? (
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10.5px] font-semibold border uppercase ${
                          colorForType(selectedNode.node_type).badge
                        }`}
                      >
                        {selectedNode.node_type}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-400">
                        {selectedNode.app_exe}
                      </span>
                      <span className="font-mono text-[11px] text-emerald-300">
                        ×{selectedNode.hit_count} hits
                      </span>
                    </div>
                    <div className="text-[13.5px] font-semibold text-zinc-100 break-words">
                      {selectedNode.label}
                    </div>
                  </div>

                  <button
                    type="button"
                    data-testid="kg-delete-node-btn"
                    onClick={() => void handleDeleteNode(selectedNode.id)}
                    disabled={deletingId === selectedNode.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/35 text-[11.5px] text-rose-300 font-medium shrink-0 disabled:opacity-40"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                    {deletingId === selectedNode.id ? "Deleting…" : "Delete Node"}
                  </button>
                </div>

                {connectedEdges.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {connectedEdges.map((edge) => (
                      <span
                        key={edge.id}
                        className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.07] text-[11px] text-zinc-300"
                      >
                        {edge.relation}:{" "}
                        <strong className="text-sky-300">
                          {edge.intent || edge.control_name || "link"}
                        </strong>
                        {edge.shortcut && (
                          <kbd className="ml-1.5 px-1 rounded bg-white/10 font-mono text-[10px]">
                            {edge.shortcut}
                          </kbd>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-zinc-500">
                Click any node in the graph to inspect connected UI controls,
                shortcuts, hit counts, or delete stale memory nodes.
              </p>
            )}
          </div>
        </section>

        {/* Right: Session .graph.md Viewer */}
        <section className="lg:col-span-5 rounded-2xl bg-[#11141D]/90 border border-white/[0.08] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13.5px] font-semibold text-zinc-100">
                Session .graph.md Viewer
              </h2>
              <p className="text-[11px] text-zinc-400">
                Mermaid flowcharts &amp; action traces saved locally per session
              </p>
            </div>
            <span className="text-[11px] font-mono text-zinc-400">
              {sessionList.length} files
            </span>
          </div>

          <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
            {sessionList.length === 0 ? (
              <p className="text-[12px] text-zinc-500 py-2">
                No session `.graph.md` files written yet.
              </p>
            ) : (
              sessionList.map((sess) => {
                const selected = selectedSessionPath === sess.graph_md_path;
                return (
                  <button
                    key={sess.session_id}
                    type="button"
                    data-testid={`session-graph-item-${sess.session_id}`}
                    onClick={() => void handleOpenMarkdown(sess.graph_md_path)}
                    className={`w-full text-left rounded-xl p-2.5 border transition-colors ${
                      selected
                        ? "bg-sky-400/15 border-sky-400"
                        : "bg-[#090B10]/80 border-white/10 hover:bg-white/[0.06]"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-sky-300">
                        {sess.active_app}
                      </span>
                      <span className="font-mono text-zinc-400">
                        {sess.day_key} · {sess.node_count}n/{sess.edge_count}e
                      </span>
                    </div>
                    <div className="text-[12px] font-medium text-zinc-100 truncate mt-0.5">
                      {sess.goal || sess.graph_md_path}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex-1 min-h-[230px] rounded-xl bg-[#090B10] border border-white/10 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.08] bg-white/[0.02]">
              <span className="font-mono text-[11px] text-zinc-400 truncate max-w-[260px]">
                {selectedSessionPath || "No .graph.md selected"}
              </span>
              {markdownContent && (
                <button
                  type="button"
                  onClick={async () => {
                    await copyToClipboard(markdownContent);
                    setCopiedMd(true);
                    window.setTimeout(() => setCopiedMd(false), 1800);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[11px] text-zinc-200"
                >
                  {copiedMd ? (
                    <CheckIcon className="w-3 h-3 text-emerald-300" />
                  ) : (
                    <CopyIcon className="w-3 h-3" />
                  )}
                  {copiedMd ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <pre
              data-testid="graph-markdown-viewer"
              className="flex-1 p-3 overflow-auto gl-mono text-[11.5px] text-zinc-200 leading-relaxed whitespace-pre-wrap"
            >
              {loadingMarkdown
                ? "Reading markdown graph…"
                : markdownContent ||
                  "Select a session graph above or click Master knowledge-graph.md to view the Mermaid state graph and verified UI steps."}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
};
