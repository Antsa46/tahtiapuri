import type { SkySnapshot } from "@tahtiapuri/validation/sky";
import { MAP_CENTER as C, MAP_RADIUS as R, MAP_SIZE, mapPoints, pickMapPoint, type MapPoint } from "./projection.js";
export interface SkyMapAdapter { update(snapshot: SkySnapshot | null, selectedId: string | null): void; dispose(): void }
export function createCanvasSkyMap(canvas: HTMLCanvasElement, onSelect: (id: string) => void): SkyMapAdapter {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const ctx = context, ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = MAP_SIZE * ratio; canvas.height = MAP_SIZE * ratio;
  let points: MapPoint[] = [], disposed = false;
  function click(event: MouseEvent) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const point = pickMapPoint(points, (event.clientX - bounds.left) / bounds.width * MAP_SIZE,
      (event.clientY - bounds.top) / bounds.height * MAP_SIZE, 12 / bounds.width * MAP_SIZE);
    if (point) onSelect(point.id);
  }
  canvas.addEventListener("click", click);
  return {
    update(snapshot, selectedId) {
      if (disposed) return;
      points = snapshot ? mapPoints(snapshot.objects) : [];
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
      const background = ctx.createRadialGradient(C, C - 80, 0, C, C, R);
      background.addColorStop(0, "#16253c"); background.addColorStop(1, "#070f1e");
      ctx.fillStyle = background; ctx.beginPath(); ctx.arc(C, C, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#36465a"; ctx.lineWidth = 1;
      for (const altitude of [0, 30, 60]) {
        const radius = (90 - altitude) / 90 * R;
        ctx.setLineDash(altitude === 0 ? [] : [3, 7]);
        ctx.beginPath(); ctx.arc(C, C, radius, 0, Math.PI * 2); ctx.stroke();
        if (altitude > 0) { ctx.fillStyle = "#a0adc0"; ctx.font = "14px Segoe UI, sans-serif"; ctx.fillText(altitude + "°", C + 8, C - radius + 19); }
      }
      ctx.setLineDash([3, 7]); ctx.strokeStyle = "#26394c";
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
        ctx.beginPath(); ctx.moveTo(C, C); ctx.lineTo(C + Math.sin(angle) * R, C - Math.cos(angle) * R); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.fillStyle = "#bbc9d9"; ctx.font = "600 18px Segoe UI, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const [name, x, y] of [["Pohjoinen", C, C - R - 25], ["Etelä", C, C + R + 25], ["Itä", C - R - 29, C], ["Länsi", C + R + 28, C]] as const) ctx.fillText(name, x, y);
      // Bright objects are painted last; every point is calculated, never decorative.
      for (const p of [...points].sort((a, b) => (b.object.magnitude.value ?? 6) - (a.object.magnitude.value ?? 6))) {
        ctx.fillStyle = p.object.kind === "sun" ? "#f2c875" : p.object.kind === "moon" ? "#e5e7da" : p.object.kind === "planet" ? "#eac997" : "#d4e1f4";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
      }
      const labels: { x: number; y: number; width: number }[] = [];
      const ordered = [...points].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || Number(a.object.kind === "star") - Number(b.object.kind === "star") || (a.object.magnitude.value ?? 6) - (b.object.magnitude.value ?? 6));
      ctx.font = "16px Segoe UI, sans-serif"; ctx.textAlign = "left";
      let starsLabelled = 0;
      for (const p of ordered) {
        const selected = p.id === selectedId;
        if (!selected && p.object.kind === "star" && (starsLabelled >= 6 || (p.object.magnitude.value ?? 6) > 1.5)) continue;
        const name = p.object.name, width = ctx.measureText(name).width;
        const x = Math.min(MAP_SIZE - width - 12, Math.max(12, p.x + 11)), y = Math.min(MAP_SIZE - 16, Math.max(16, p.y - 10));
        if (!selected && labels.some(l => Math.abs(l.y - y) < 22 && x < l.x + l.width + 10 && x + width + 10 > l.x)) continue;
        labels.push({ x, y, width });
        if (p.object.kind === "star") starsLabelled++;
        ctx.lineWidth = 4; ctx.strokeStyle = "#091321"; ctx.strokeText(name, x, y);
        ctx.fillStyle = selected ? "#b5eee2" : p.object.kind === "star" ? "#aebed3" : "#e6d7b6"; ctx.fillText(name, x, y);
        if (selected) { ctx.strokeStyle = "#8ad8c6"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 7, 0, Math.PI * 2); ctx.stroke(); }
      }
    },
    dispose() { disposed = true; points = []; canvas.removeEventListener("click", click); ctx.clearRect(0, 0, canvas.width, canvas.height); },
  };
}
