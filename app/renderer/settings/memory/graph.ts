/**
 * 文件职责：设置窗「记忆」面板的知识图谱：节点/连线绘制与「重建图谱」。
 *
 * 为什么单独一个文件：图谱是一段手写的 SVG 布局，和列表、时间线的 DOM 结构完全不同；单独一处才好改间距与点击命中。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type { MemoryGraphEdge, MemoryGraphNode } from "../../../shared/contracts/ipc";
import { api, byId, setText } from "../dom";
import { memoryPaneState } from "./state";
const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function renderGraph(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): void {
  const svg = byId("memory-graph");
  if (!(svg instanceof SVGSVGElement)) {
    return;
  }
  svg.replaceChildren();
  setText("graph-count", String(nodes.length) + " 节点 · " + String(edges.length) + " 连接");
  if (nodes.length === 0) {
    setText("graph-status", "还没有可连接的记忆。先聊天或写日记，再整理时间线。");
    return;
  }
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    positions.set(node.id, {
      x: nodes.length === 1 ? 360 : 360 + Math.cos(angle) * 260,
      y: nodes.length === 1 ? 180 : 180 + Math.sin(angle) * 130,
    });
  });
  for (const edge of edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (from === undefined || to === undefined) {
      continue;
    }
    const line = svgElement("line");
    line.setAttribute("x1", from.x.toFixed(1));
    line.setAttribute("y1", from.y.toFixed(1));
    line.setAttribute("x2", to.x.toFixed(1));
    line.setAttribute("y2", to.y.toFixed(1));
    line.setAttribute("class", "graph-edge");
    svg.append(line);
  }
  for (const node of nodes) {
    const point = positions.get(node.id);
    if (point === undefined) {
      continue;
    }
    const group = svgElement("g");
    group.setAttribute("class", "graph-node " + (node.kind || "memory"));
    const circle = svgElement("circle");
    circle.setAttribute("cx", point.x.toFixed(1));
    circle.setAttribute("cy", point.y.toFixed(1));
    circle.setAttribute("r", node.kind === "period" ? "10" : "7");
    const title = svgElement("title");
    title.textContent = (node.label || node.kind) + "\n" + node.summary;
    circle.append(title);
    const label = svgElement("text");
    label.setAttribute("x", point.x.toFixed(1));
    label.setAttribute("y", (point.y + (node.kind === "period" ? 23 : 19)).toFixed(1));
    label.textContent = (node.label || node.kind).slice(0, 8);
    group.append(circle, label);
    svg.append(group);
  }
  setText("graph-status", "");
}

export async function onGraphRebuild(): Promise<void> {
  const charId = memoryPaneState.charId;
  const button = byId("graph-rebuild");
  if (charId === null || !(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }
  button.disabled = true;
  setText("graph-rebuild-status", "正在抽取实体与关系…");
  try {
    const result = await api.memory.rebuildGraph({ char_id: charId });
    setText(
      "graph-rebuild-status",
      "完成：实体 " + String(result.entities) + "，关系 " + String(result.links),
    );
    await refreshGraph();
  } catch (error: unknown) {
    setText("graph-rebuild-status", "重建失败：" + String(error));
  } finally {
    button.disabled = false;
  }
}

export async function refreshGraph(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    renderGraph([], []);
    return;
  }
  try {
    const response = await api.memory.graph({ char_id: charId, limit: 60 });
    if (charId !== memoryPaneState.charId) {
      return;
    }
    renderGraph(response.nodes, response.edges);
  } catch (error: unknown) {
    setText("graph-status", "读不到记忆网络：" + String(error));
  }
}

/** 图谱页的接线（目前只有「重建图谱」一个按钮）。 */
export function initGraphPane(): void {
  byId("graph-rebuild")?.addEventListener("click", () => {
    void onGraphRebuild();
  });
}
