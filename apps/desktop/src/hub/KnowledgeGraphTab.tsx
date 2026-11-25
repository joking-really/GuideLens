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

function tierForType(nodeType: string): number {
  const t = nodeType.toLowerCase();
  if (t === "app") return 0;
  if (t === "screen" || t === "window") return 1;
  if (t === "control" || t === "element") return 2;
  return 3;
}

function truncateLabel(text: string, maxLen = 20): string {
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
    const height = Math.max(360, maxRows * rowSpacing + 80);

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
      {/* Filter & Search Bar */}
      <section className="rounded-xl bg-[#111317] border border-white/[0.07] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <SearchIcon className="w-3.5 h-3.5 text-[#5C606A] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Filter Knowledge Graph"
              data-testid="kg-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search nodes or apps…"
              className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0A0B0D] border border-white/[0.08] text-[12.5px] text-[#F4F4F5] placeholder-[#5C606A] w-52 focus:outline-none focus:border-white/25"
            />
          </div>

          <select
            aria-label="Filter by App"
            data-testid="kg-app-filter"
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-[#F4F4F5]"
          >
            <option value="">All Apps</option>
            {uniqueApps.map((app) => (
              <option key={app} value={app}>
                {app}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-0.5 bg-[#0A0B0D] p-1 rounded-lg border border-white/[0.07]">
            {(["all", "app", "screen", "control", "intent"] as const).map(
              (kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setTypeFilter(kind)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
                    typeFilter === kind
                      ? "bg-[#F4F4F5] text-[#0A0B0D]"
                      : "text-[#8E929B] hover:text-[#F4F4F5]"
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
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] text-[#E4E4E7] font-medium transition-colors"
            >
              knowledge-graph.md
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadGraphData(appFilter)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[12px] text-[#E4E4E7] transition-colors"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </section>

      {/* Main Split: Monochrome SVG Node Graph + .graph.md Reader */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <section className="lg:col-span-7 rounded-xl bg-[#111317] border border-white/[0.07] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
                Learned Path Graph
              </h2>
              <span className="text-[11px] font-mono text-[#5C606A]">
                {filteredNodes.length}n · {filteredEdges.length}e
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Zoom Out Graph"
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                className="p-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5]"
              >
                <ZoomOutIcon className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-mono text-[#5C606A] px-1.5">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom In Graph"
                onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.15).toFixed(2)))}
                className="p-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5]"
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
                className="p-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#8E929B] hover:text-[#F4F4F5]"
              >
                <MaximizeIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Monochrome SVG Stage */}
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
            className="relative h-[330px] rounded-lg bg-[#0A0B0D] border border-white/[0.07] overflow-hidden cursor-grab active:cursor-grabbing select-none"
          >
            {filteredNodes.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <p className="text-[13px] font-medium text-[#8E929B]">
                  {loading
                    ? "Loading knowledge graph…"
                    : "No learned UI nodes match the current filter."}
                </p>
                <p className="text-[11.5px] text-[#5C606A] mt-1">
                  Verified App → Screen → Control → Intent paths are recorded automatically during Live Sessions.
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
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(255,255,255,0.28)" />
                  </marker>
                </defs>

                <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                  {(["App", "Screen", "Control", "Intent"] as const).map(
                    (colLabel, idx) => (
                      <text
                        key={colLabel}
                        x={[110, 310, 520, 730][idx]}
                        y={24}
                        textAnchor="middle"
                        fill="#5C606A"
                        fontSize="10.5"
                        fontWeight="600"
                      >
                        {colLabel.toUpperCase()}
                      </text>
                    ),
                  )}

                  {/* Hairline Monochrome Edges */}
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
                          stroke={
                            isHighlighted
                              ? "rgba(244,244,245,0.75)"
                              : "rgba(255,255,255,0.14)"
                          }
                          strokeWidth={isHighlighted ? 1.6 : 1}
                          markerEnd="url(#kg-arrow)"
                        />
                        {isHighlighted && edge.intent && (
                          <text
                            x={mx}
                            y={(y1 + y2) / 2 - 6}
                            textAnchor="middle"
                            fill="#E4E4E7"
                            fontSize="10"
                          >
                            {truncateLabel(edge.intent, 24)} (×{edge.success_count})
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Monochrome Nodes */}
                  {layout.positioned.map(({ node, x, y }) => {
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
                          y={-21}
                          width={136}
                          height={42}
                          rx={8}
                          fill={isSelected ? "#17191E" : "#111317"}
                          stroke={
                            isSelected
                              ? "#F4F4F5"
                              : "rgba(255,255,255,0.16)"
                          }
                          strokeWidth={isSelected ? 1.6 : 1}
                        />
                        <circle
                          cx={-54}
                          cy={-4}
                          r={3}
                          fill={isSelected ? "#F4F4F5" : "#8E929B"}
                        />
                        <text
                          x={4}
                          y={-2}
                          textAnchor="middle"
                          fill="#F4F4F5"
                          fontSize="11.5"
                          fontWeight="500"
                        >
                          {truncateLabel(node.label, 16)}
                        </text>
                        <text
                          x={0}
                          y={13}
                          textAnchor="middle"
                          fill="#5C606A"
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

          {/* Node Inspector */}
          <div
            data-testid="kg-node-inspector"
            className="rounded-lg bg-[#0A0B0D] border border-white/[0.07] p-3.5"
          >
            {selectedNode ? (
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] uppercase font-medium text-[#E4E4E7]">
                        {selectedNode.node_type}
                      </span>
                      <span className="font-mono text-[#8E929B]">
                        {selectedNode.app_exe}
                      </span>
                      <span className="font-mono text-[#5C606A]">
                        ×{selectedNode.hit_count}
                      </span>
                    </div>
                    <div className="text-[13px] font-semibold text-[#F4F4F5] break-words">
                      {selectedNode.label}
                    </div>
                  </div>

                  <button
                    type="button"
                    data-testid="kg-delete-node-btn"
                    onClick={() => void handleDeleteNode(selectedNode.id)}
                    disabled={deletingId === selectedNode.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11.5px] text-[#E4E4E7] font-medium shrink-0 disabled:opacity-40 transition-colors"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                    {deletingId === selectedNode.id ? "Deleting…" : "Delete"}
                  </button>
                </div>

                {connectedEdges.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {connectedEdges.map((edge) => (
                      <span
                        key={edge.id}
                        className="px-2 py-1 rounded bg-[#111317] border border-white/[0.07] text-[11px] text-[#8E929B]"
                      >
                        {edge.relation}:{" "}
                        <span className="text-[#F4F4F5] font-medium">
                          {edge.intent || edge.control_name || "link"}
                        </span>
                        {edge.shortcut && (
                          <kbd className="ml-1.5 px-1 rounded bg-white/[0.06] font-mono text-[10px] text-[#E4E4E7]">
                            {edge.shortcut}
                          </kbd>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-[#5C606A]">
                Select any node in the graph to inspect connected UI controls,
                shortcuts, or delete stale memory nodes.
              </p>
            )}
          </div>
        </section>

        {/* Right: .graph.md Reader Pane */}
        <section className="lg:col-span-5 rounded-xl bg-[#111317] border border-white/[0.07] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13px] font-semibold text-[#F4F4F5]">
                .graph.md Reader
              </h2>
              <p className="text-[11.5px] text-[#8E929B]">
                Local Mermaid session traces
              </p>
            </div>
            <span className="text-[11px] font-mono text-[#5C606A]">
              {sessionList.length} files
            </span>
          </div>

          <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
            {sessionList.length === 0 ? (
              <p className="text-[12px] text-[#5C606A] py-2">
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
                    className={`w-full text-left rounded-lg p-2.5 border transition-colors ${
                      selected
                        ? "bg-[#17191E] border-white/25"
                        : "bg-[#0A0B0D] border-white/[0.07] hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-[#F4F4F5]">
                        {sess.active_app}
                      </span>
                      <span className="font-mono text-[#5C606A]">
                        {sess.day_key} · {sess.node_count}n/{sess.edge_count}e
                      </span>
                    </div>
                    <div className="text-[12px] font-medium text-[#8E929B] truncate mt-0.5">
                      {sess.goal || sess.graph_md_path}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex-1 min-h-[230px] rounded-lg bg-[#0A0B0D] border border-white/[0.07] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.07]">
              <span className="font-mono text-[11px] text-[#5C606A] truncate max-w-[260px]">
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
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-[11px] text-[#E4E4E7]"
                >
                  {copiedMd ? (
                    <CheckIcon className="w-3 h-3 text-[#F4F4F5]" />
                  ) : (
                    <CopyIcon className="w-3 h-3" />
                  )}
                  {copiedMd ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <pre
              data-testid="graph-markdown-viewer"
              className="flex-1 p-3 overflow-auto gl-mono text-[11.5px] text-[#E4E4E7] leading-relaxed whitespace-pre-wrap"
            >
              {loadingMarkdown
                ? "Reading markdown graph…"
                : markdownContent ||
                  "Select a session graph above or open knowledge-graph.md."}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
};
