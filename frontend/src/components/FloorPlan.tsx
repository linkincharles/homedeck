import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { isOn, roomItems } from "../screens/layouts/shared";
import { isEnvironmentSensor } from "./SensorStrip";
import { childLocked, childLockNote } from "../devicePrefs";
import type { ScreenProps } from "../screens/types";
import type { HomeDeckConfig, HomeDeckFloorplan, HomeDeckFloorplanRect } from "../types/config";
import type { TranslationKey } from "../i18n";
import type { DiscoveredEntity, DiscoveryResponse, Room } from "../types/discovery";
import type { HomeAssistant } from "../types/home-assistant";
import { ContextHeader } from "./ContextHeader";
import { EntityModal } from "./EntityModal";
import { EntityIcon, HDIcon } from "./HDIcon";
import { HDSegmented } from "./HDSelect";

// Pro floor plan: every floor of the home drawn from Home Assistant's floors and areas, with no setup.
// Rooms are rectangles on a 48 x 32 grid, laid out on their own and then moved or resized in Edit mode;
// devices are spots inside their room (0–1 across and down), so a resized room carries them along.
// Lit rooms glow, open doors and windows show in red, motion pulses; a tap switches, holding opens details.
// A floor can have a background image (the real plan); the rooms then lie over it, without walls.
// On a phone held upright the whole plan turns a quarter clockwise to use the screen; a 3D view tilts it.

const COLS = 48;
const ROWS = 32;
const EMPTY: HomeDeckFloorplan = { rooms: {}, devices: {}, hidden: [], images: {} };
const THREE_D_KEY = "homedeck-plan-3d";
const NO_FLOOR = "__none__";
const SWITCHES = new Set(["light", "switch", "fan", "input_boolean"]);
const ON_PLAN = new Set(["light", "switch", "fan", "input_boolean", "cover", "climate", "media_player", "lock", "vacuum", "camera"]);
const OPENINGS = new Set(["door", "window", "garage_door", "opening"]);
const MOTION = new Set(["motion", "occupancy", "presence"]);
const MAX_SPOTS = 40;
const VIEW_KEY = "homedeck-plan-view";
interface View { rx: number; rz: number; zoom: number; px: number; py: number }
const VIEW_3D: View = { rx: 48, rz: -32, zoom: 1, px: 0, py: 0 };
const VIEW_2D: View = { rx: 0, rz: 0, zoom: 1, px: 0, py: 0 };

type Rect = HomeDeckFloorplanRect;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
type Spot = { x: number; y: number };

/** The floor plan's name: the one chosen in Settings → Navigation, else the default for that place. */
export function planTitle(config: HomeDeckConfig, t: (key: TranslationKey) => string, fallback: TranslationKey = "floorplan"): string {
  return config.navigation.plan_title?.trim() || t(fallback);
}

/** A room's devices for the automatic layout's weights (before the room's own arrangement is known). */
function planDevices(room: Room): DiscoveredEntity[] {
  return room.entities.filter((entity) => ON_PLAN.has(entity.domain)
    || (entity.domain === "binary_sensor" && (OPENINGS.has(entity.device_class ?? "") || MOTION.has(entity.device_class ?? ""))));
}

/** What the plan shows in a room: exactly what its room screen shows, in its order, with its names, hidden
 * devices left out and devices added from other rooms included; scenes and environment sensors moved to
 * the room's strips are shown too. */
export function roomShown(config: HomeDeckConfig, room: Room, allRooms: Room[]): DiscoveredEntity[] {
  const { byKey, visible } = roomItems(config, room, allRooms);
  const grid = visible.map((key) => byKey.get(key)).filter((entity): entity is DiscoveredEntity => Boolean(entity));
  const strips = room.entities.filter((entity) => (config.room_scenes && entity.domain === "scene") || (config.room_sensors && isEnvironmentSensor(entity)));
  return [...grid, ...strips.filter((entity) => !grid.some((item) => item.entity_id === entity.entity_id))];
}

/** A sensor's reading in a few characters, for its spot on the plan ("21.5°", "48%"). */
function shortReading(state: { state: string; attributes: Record<string, unknown> } | undefined, language?: string): string {
  if (!state || ["unavailable", "unknown"].includes(state.state)) return "–";
  const value = Number(state.state);
  if (!Number.isFinite(value)) return state.state.length > 6 ? `${state.state.slice(0, 5)}…` : state.state;
  const unit = String(state.attributes.unit_of_measurement ?? "");
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1 }).format(value);
  return unit === "°C" || unit === "°F" ? `${number}°` : unit === "%" ? `${number}%` : unit ? `${number} ${unit}` : number;
}

/** Rooms laid out like a plan: the space is cut along its longer side into two parts weighted by the
 * rooms' devices, again and again, so rooms come out close to square and keep the panel's order. */
export function autoLayout(rooms: Room[]): Record<string, Rect> {
  const result: Record<string, Rect> = {};
  const weight = (room: Room) => Math.max(1, planDevices(room).length) ** 0.6;
  const cut = (list: Room[], rect: Rect) => {
    if (list.length === 0) return;
    if (list.length === 1) { result[list[0].id] = rect; return; }
    const weights = list.map(weight);
    const total = weights.reduce((sum, value) => sum + value, 0);
    // The split that best halves the weight.
    let at = 1;
    let best = Infinity;
    let running = 0;
    for (let index = 0; index < list.length - 1; index += 1) {
      running += weights[index];
      const gap = Math.abs(running - total / 2);
      if (gap < best) { best = gap; at = index + 1; }
    }
    const share = weights.slice(0, at).reduce((sum, value) => sum + value, 0) / total;
    // Grid units are as tall as they are wide on screen only roughly; 1.4 keeps rooms from coming out thin.
    if (rect.w >= rect.h * 1.4) {
      const left = clamp(Math.round(rect.w * share), 4, rect.w - 4);
      cut(list.slice(0, at), { x: rect.x, y: rect.y, w: left, h: rect.h });
      cut(list.slice(at), { x: rect.x + left, y: rect.y, w: rect.w - left, h: rect.h });
    } else {
      const top = clamp(Math.round(rect.h * share), 4, rect.h - 4);
      cut(list.slice(0, at), { x: rect.x, y: rect.y, w: rect.w, h: top });
      cut(list.slice(at), { x: rect.x, y: rect.y + top, w: rect.w, h: rect.h - top });
    }
  };
  cut(rooms, { x: 0, y: 0, w: COLS, h: ROWS });
  return result;
}

/** Spots for devices that have none yet: an even grid under the room's name, worked out on screen
 * (upright, the plan's across runs down the screen) and given back in the plan's own terms. */
function autoSpots(count: number, rect: Rect, upright: boolean): Spot[] {
  if (count === 0) return [];
  const wide = upright ? rect.h / rect.w : rect.w / rect.h;
  const across = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * wide))));
  const down = Math.ceil(count / across);
  return Array.from({ length: count }, (_, index) => {
    const sx = ((index % across) + 0.5) / across;
    const sy = 0.3 + ((Math.floor(index / across) + 0.5) / down) * 0.62;
    // Upright, the screen's left-to-right runs up the plan and top-to-bottom runs across it.
    return upright ? { x: sy, y: 1 - sx } : { x: sx, y: sy };
  });
}

/** Floor names: Home Assistant's own list when the panel has it, else asked once over the websocket. */
export function useFloorNames(hass: HomeAssistant): Record<string, { name: string; level: number }> {
  const known = (hass as unknown as { floors?: Record<string, { floor_id: string; name: string; level?: number | null }> }).floors;
  const [asked, setAsked] = useState<Record<string, { name: string; level: number }>>({});
  useEffect(() => {
    if (known) return;
    let cancelled = false;
    hass.connection.sendMessagePromise<Array<{ floor_id: string; name: string; level?: number | null }>>({ type: "config/floor_registry/list" })
      .then((floors) => { if (!cancelled) setAsked(Object.fromEntries(floors.map((floor) => [floor.floor_id, { name: floor.name, level: floor.level ?? 0 }]))); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [Boolean(known)]);
  return useMemo(() => known ? Object.fromEntries(Object.values(known).map((floor) => [floor.floor_id, { name: floor.name, level: floor.level ?? 0 }])) : asked, [known, asked]);
}


/** Rooms grouped under their Home Assistant floor (lowest level first, rooms in their own order), for the
 * room lists when "Group rooms by floor" is on. Off, or with fewer than two floors, one group with no name. */
export function useFloorGroups<T extends { id: string; floor_id?: string | null }>(hass: HomeAssistant, rooms: T[], on: boolean, noFloor: string): Array<{ id: string; name: string | null; rooms: T[] }> {
  const floors = useFloorNames(hass);
  if (!on) return [{ id: "all", name: null, rooms }];
  const ids = [...new Set(rooms.map((room) => room.floor_id ?? ""))];
  if (ids.filter(Boolean).length < 2 && !(ids.length === 2 && ids.includes(""))) return [{ id: "all", name: null, rooms }];
  const order = (id: string) => (id && floors[id] ? floors[id].level : id ? 999 : 10_000);
  return ids.sort((a, b) => order(a) - order(b)).map((id) => ({ id: id || "none", name: id ? floors[id]?.name ?? id : noFloor, rooms: rooms.filter((room) => (room.floor_id ?? "") === id) }));
}

interface Drag { kind: "move" | "resize" | "resizeStart" | "spot"; id: string; startX: number; startY: number; rect?: Rect; spot?: Spot; box?: DOMRect; moved: boolean }

/** Reads an image file and gives it back as a data URL at most 2400 px on its longer side. */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const picture = new Image();
    picture.onload = () => {
      const scale = Math.min(1, 2400 / Math.max(picture.naturalWidth, picture.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) { URL.revokeObjectURL(url); reject(new Error("no canvas")); return; }
      // PNG and WebP keep their transparency (a plan drawn on nothing shows the panel's background);
      // photos go as JPEG, which keeps them light.
      const transparent = file.type === "image/png" || file.type === "image/webp";
      if (!transparent) { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(transparent ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.86));
    };
    picture.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    picture.src = url;
  });
}

export function FloorPlan(props: ScreenProps & { embedded?: boolean; onOpenRoom: (roomId: string) => void }) {
  const { config, data, editing, hass, language, onConfig, t } = props;
  const plan = config.floorplan ?? EMPTY;
  const floorNames = useFloorNames(hass);
  const rooms = data.rooms.filter((room) => room.id !== "__unassigned__");

  // Floors in Home Assistant's order (by level), rooms without a floor last; a home with no floors is one plan.
  const floors = useMemo(() => {
    const groups = new Map<string, Room[]>();
    for (const room of rooms) {
      const key = room.floor_id ?? NO_FLOOR;
      groups.set(key, [...(groups.get(key) ?? []), room]);
    }
    return [...groups.entries()]
      .map(([key, list]) => ({ key, rooms: list, level: key === NO_FLOOR ? 999 : floorNames[key]?.level ?? 500 }))
      .sort((a, b) => a.level - b.level);
  }, [rooms, floorNames]);
  const [floorKey, setFloorKey] = useState<string | null>(null);
  const floor = floors.find((item) => item.key === floorKey) ?? floors[0];

  // The floor's background image, if any: the plan then keeps the image's own proportions.
  const image = floor ? plan.images?.[floor.key] : undefined;
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  useEffect(() => {
    setImageRatio(null);
    if (!image?.src) return;
    const loader = new Image();
    loader.onload = () => { if (loader.naturalWidth > 0 && loader.naturalHeight > 0) setImageRatio(loader.naturalWidth / loader.naturalHeight); };
    loader.src = image.src;
  }, [image?.src]);
  const [imagePanel, setImagePanel] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [opacity, setOpacity] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 3D: the plan tilted back, kept per device (a wall tablet can show it, a phone not).
  const stage = useRef<HTMLDivElement>(null);
  const [threeD, setThreeD] = useState(() => { try { return window.localStorage.getItem(THREE_D_KEY) === "1"; } catch { return false; } });
  // The view: tilt and turn (3D), zoom and pan, changed with the fingers or the mouse and kept per device.
  const [view, setView] = useState<View>(() => {
    try { const saved = JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? "null") as View | null; if (saved && typeof saved.zoom === "number") return saved; } catch { /* default below */ }
    return threeD ? VIEW_3D : VIEW_2D;
  });
  const keepView = (next: View) => { try { window.localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* lasts this visit */ } };
  const toggle3D = () => setThreeD((value) => {
    try { if (value) window.localStorage.removeItem(THREE_D_KEY); else window.localStorage.setItem(THREE_D_KEY, "1"); } catch { /* lasts this visit */ }
    const next = value ? VIEW_2D : VIEW_3D;
    setView(next);
    keepView(next);
    return !value;
  });
  const resetView = () => { const next = threeD ? VIEW_3D : VIEW_2D; setView(next); keepView(next); };
  const changed = JSON.stringify(view) !== JSON.stringify(threeD ? VIEW_3D : VIEW_2D);
  const gesture = useRef<{ pointers: Map<number, { x: number; y: number }>; start: View; startPointers: Array<{ x: number; y: number }>; pan?: boolean } | null>(null);
  const [moving, setMoving] = useState(false);
  const pointersOf = (map: Map<number, { x: number; y: number }>) => [...map.values()];
  const onStageDown = (event: ReactPointerEvent) => {
    if (editing) return;
    try { (event.currentTarget as Element).setPointerCapture(event.pointerId); } catch { /* keeps working without capture */ }
    const pointers = gesture.current?.pointers ?? new Map<number, { x: number; y: number }>();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // With a mouse, Shift or the middle/right button moves the plan instead of turning it.
    gesture.current = { pointers, start: view, startPointers: pointersOf(pointers), pan: event.shiftKey || event.button === 1 || event.button === 2 };
    setMoving(true);
  };
  const onStageMove = (event: ReactPointerEvent) => {
    const now = gesture.current;
    if (!now || !now.pointers.has(event.pointerId)) return;
    now.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = pointersOf(now.pointers);
    const start = now.start;
    if (points.length >= 2 && now.startPointers.length >= 2) {
      // Two fingers: pinch to zoom, move together to pan.
      const gap = (list: Array<{ x: number; y: number }>) => Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) || 1;
      const mid = (list: Array<{ x: number; y: number }>) => ({ x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 });
      const zoom = clamp(start.zoom * (gap(points) / gap(now.startPointers)), 0.6, 3.5);
      const from = mid(now.startPointers);
      const to = mid(points);
      setView({ ...start, zoom, px: start.px + to.x - from.x, py: start.py + to.y - from.y });
      return;
    }
    const first = now.startPointers[0];
    if (!first) return;
    const dx = event.clientX - first.x;
    const dy = event.clientY - first.y;
    // One finger: turns and tilts the 3D model; on the flat plan it moves the plan once zoomed in.
    if (now.pan) setView({ ...start, px: start.px + dx, py: start.py + dy });
    else if (threeD) setView({ ...start, rz: start.rz + dx * 0.35, rx: clamp(start.rx - dy * 0.25, 0, 78) });
    else if (start.zoom > 1.01) setView({ ...start, px: start.px + dx, py: start.py + dy });
  };
  const onStageUp = (event: ReactPointerEvent) => {
    const now = gesture.current;
    if (!now) return;
    now.pointers.delete(event.pointerId);
    if (now.pointers.size === 0) { gesture.current = null; setMoving(false); setView((current) => { keepView(current); return current; }); }
    else gesture.current = { pointers: now.pointers, start: view, startPointers: pointersOf(now.pointers) };
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // The mouse wheel (or a trackpad pinch) zooms.
    const wheel = (event: WheelEvent) => {
      if (editing) return;
      event.preventDefault();
      setView((current) => { const next = { ...current, zoom: clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), 0.6, 3.5) }; keepView(next); return next; });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [editing]);

  // Room rectangles: the saved ones, the rest laid out on their own (and saved as soon as one is moved).
  const auto = useMemo(() => autoLayout(floor?.rooms ?? []), [floor]);
  const [draft, setDraft] = useState<{ rooms: Record<string, Rect>; devices: Record<string, Spot> } | null>(null);
  const rectOf = (room: Room) => draft?.rooms[room.id] ?? plan.rooms[room.id] ?? auto[room.id];
  // Devices left off the plan only (they stay in their room); in Edit mode they show faded, to bring back.
  const hidden = new Set(plan.hidden);
  const setHidden = (entityId: string, off: boolean) => onConfig((current) => {
    const now = current.floorplan ?? EMPTY;
    const list = new Set(now.hidden);
    if (off) list.add(entityId); else list.delete(entityId);
    return { ...current, floorplan: { ...now, hidden: [...list] } };
  });
  // "Arrange automatically" asks for a second tap (it undoes the floor's arrangement).
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  // Fit the plan in the space left, turned a quarter when the space stands upright.
  const [space, setSpace] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setSpace({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const upright = space.height > space.width * 1.05;
  const across = upright ? ROWS : COLS;
  const down = upright ? COLS : ROWS;
  // The plan fills the space, stretched at most to between 1.2 and 2.4 times as wide as tall (or the reverse upright).
  const ratio = image && imageRatio
    ? (upright ? 1 / imageRatio : imageRatio)
    : clamp(space.height > 0 ? space.width / space.height : 1.5, upright ? 1 / 2.4 : 1.2, upright ? 1 / 1.2 : 2.4);
  const canvasWidth = Math.min(space.width, space.height * ratio);
  const canvas = { width: canvasWidth, height: canvasWidth / ratio };
  const unitX = canvas.width / across;
  const unitY = canvas.height / down;
  const unit = Math.min(unitX, unitY);
  // Upright: the plan turned a quarter clockwise, so its top edge is the screen's right edge.
  const place = (rect: Rect): CSSProperties => upright
    ? { left: `${((ROWS - rect.y - rect.h) / ROWS) * 100}%`, top: `${(rect.x / COLS) * 100}%`, width: `${(rect.h / ROWS) * 100}%`, height: `${(rect.w / COLS) * 100}%` }
    : { left: `${(rect.x / COLS) * 100}%`, top: `${(rect.y / ROWS) * 100}%`, width: `${(rect.w / COLS) * 100}%`, height: `${(rect.h / ROWS) * 100}%` };
  const spotStyle = (spot: Spot): CSSProperties => upright ? { left: `${(1 - spot.y) * 100}%`, top: `${spot.x * 100}%` } : { left: `${spot.x * 100}%`, top: `${spot.y * 100}%` };

  const [modal, setModal] = useState<DiscoveredEntity | null>(null);
  const drag = useRef<Drag | null>(null);
  const hold = useRef<number | undefined>(undefined);

  // Saves the whole floor at once, so rooms still on the automatic layout keep where they were drawn.
  const save = (rooms: Record<string, Rect>, devices: Record<string, Spot>) => {
    const floorRects = Object.fromEntries((floor?.rooms ?? []).map((room) => [room.id, rooms[room.id] ?? plan.rooms[room.id] ?? auto[room.id]]));
    onConfig((current) => {
      const now = current.floorplan ?? EMPTY;
      return { ...current, floorplan: { ...now, rooms: { ...now.rooms, ...floorRects }, devices: { ...now.devices, ...devices } } };
    });
  };
  const setImage = (next: { src: string; opacity?: number } | null) => onConfig((current) => {
    const now = current.floorplan ?? EMPTY;
    const images = { ...(now.images ?? {}) };
    if (!floor) return current;
    if (next) images[floor.key] = next; else delete images[floor.key];
    return { ...current, floorplan: { ...now, images } };
  });
  // The image goes to Home Assistant made smaller (at most 2400 px across, as JPEG), which keeps it light.
  const sendImage = async (file: File) => {
    if (!floor) return;
    setUploading(true);
    setImageError("");
    try {
      const data = await shrinkImage(file);
      const result = await hass.connection.sendMessagePromise<{ url: string }>({ type: "homedeck/floorplan/upload", floor: floor.key, data });
      setImage({ src: result.url, opacity: image?.opacity ?? 0.9 });
    } catch {
      setImageError(t("floorplanImageError"));
    } finally {
      setUploading(false);
    }
  };
  const resetFloor = () => onConfig((current) => {
    const now = current.floorplan ?? EMPTY;
    const ids = new Set((floor?.rooms ?? []).map((room) => room.id));
    const entities = new Set((floor?.rooms ?? []).flatMap((room) => room.entities.map((entity) => entity.entity_id)));
    return { ...current, floorplan: { ...now, rooms: Object.fromEntries(Object.entries(now.rooms).filter(([id]) => !ids.has(id))), devices: Object.fromEntries(Object.entries(now.devices).filter(([id]) => !entities.has(id))) } };
  });

  const onDragMove = (event: ReactPointerEvent) => {
    const start = drag.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.startX) + Math.abs(event.clientY - start.startY) > 5) start.moved = true;
    if (!start.moved) return;
    if (start.kind === "spot" && start.spot && start.box) {
      const fx = (event.clientX - start.startX) / start.box.width;
      const fy = (event.clientY - start.startY) / start.box.height;
      const next = upright ? { x: start.spot.x + fy, y: start.spot.y - fx } : { x: start.spot.x + fx, y: start.spot.y + fy };
      setDraft((current) => ({ rooms: current?.rooms ?? {}, devices: { ...(current?.devices ?? {}), [start.id]: { x: clamp(next.x, 0.06, 0.94), y: clamp(next.y, 0.08, 0.94) } } }));
      return;
    }
    if (!start.rect) return;
    // Worked out as the rectangle is seen on screen (upright, the plan is turned a quarter), then turned back.
    const across = upright ? ROWS : COLS;
    const down = upright ? COLS : ROWS;
    const toScreen = (r: Rect): Rect => upright ? { x: ROWS - r.y - r.h, y: r.x, w: r.h, h: r.w } : r;
    const fromScreen = (r: Rect): Rect => upright ? { x: r.y, y: ROWS - r.x - r.w, w: r.h, h: r.w } : r;
    const dx = Math.round((event.clientX - start.startX) / unitX);
    const dy = Math.round((event.clientY - start.startY) / unitY);
    const seen = toScreen(start.rect);
    let moved: Rect;
    if (start.kind === "move") moved = { ...seen, x: clamp(seen.x + dx, 0, across - seen.w), y: clamp(seen.y + dy, 0, down - seen.h) };
    else if (start.kind === "resize") moved = { ...seen, w: clamp(seen.w + dx, 3, across - seen.x), h: clamp(seen.h + dy, 3, down - seen.y) };
    else {
      // The top left handle moves that corner and keeps the opposite one where it is.
      const x = clamp(seen.x + dx, 0, seen.x + seen.w - 3);
      const y = clamp(seen.y + dy, 0, seen.y + seen.h - 3);
      moved = { x, y, w: seen.w + seen.x - x, h: seen.h + seen.y - y };
    }
    const next = fromScreen(moved);
    setDraft((current) => ({ rooms: { ...(current?.rooms ?? {}), [start.id]: next }, devices: current?.devices ?? {} }));
  };
  const onDragEnd = () => {
    const start = drag.current;
    drag.current = null;
    if (start?.moved && draft) save(draft.rooms, draft.devices);
    setDraft(null);
  };
  const beginDrag = (event: ReactPointerEvent, next: Omit<Drag, "startX" | "startY" | "moved">) => {
    event.stopPropagation();
    try { (event.currentTarget as Element).setPointerCapture(event.pointerId); } catch { /* keeps working without capture */ }
    drag.current = { ...next, startX: event.clientX, startY: event.clientY, moved: false };
  };

  // Outside Edit mode: a tap switches what switches and opens the rest; holding always opens the details.
  const act = (entity: DiscoveredEntity) => {
    const domain = entity.domain;
    if (!entity.confirm && (domain === "scene" || domain === "script")) { void hass.callService(domain, "turn_on", { entity_id: entity.entity_id }).catch(() => undefined); return; }
    if (!entity.confirm && (domain === "button" || domain === "input_button")) { void hass.callService(domain, "press", { entity_id: entity.entity_id }).catch(() => undefined); return; }
    if (entity.confirm || domain === "lock" || !(SWITCHES.has(domain) || domain === "cover")) { openModal(entity); return; }
    void hass.callService(domain === "cover" ? "cover" : "homeassistant", "toggle", { entity_id: entity.entity_id }).catch(() => undefined);
  };
  // Under the child lock a locked device's details stay closed too.
  const openModal = (entity: DiscoveredEntity) => { if (entity.child_lock && childLocked()) { childLockNote("blocked"); return; } setModal(entity); };
  const pressStart = (entity: DiscoveredEntity) => {
    window.clearTimeout(hold.current);
    hold.current = window.setTimeout(() => { hold.current = undefined; openModal(entity); }, 550);
  };
  const pressEnd = (entity: DiscoveredEntity) => {
    if (hold.current === undefined) return;
    window.clearTimeout(hold.current);
    hold.current = undefined;
    act(entity);
  };

  const floorName = (key: string) => key === NO_FLOOR ? t("floorplanNoFloor") : floorNames[key]?.name ?? t("floorplan");
  const shownView = editing ? VIEW_2D : view;
  const body = <div className={`fp ${editing ? "fp--editing" : ""} ${upright ? "fp--upright" : ""} ${threeD && !editing ? "fp--3d" : ""} ${image ? "fp--image" : ""} ${moving ? "fp--moving" : ""}`} style={{ "--fp-rx": `${shownView.rx}deg`, "--fp-rz": `${shownView.rz}deg` } as CSSProperties}>
    <div className="fp-overlay">
    <div className="fp-bar">
      {floors.length > 1 && <HDSegmented ariaLabel={t("floorplan")} onChange={setFloorKey} options={floors.map((item) => ({ value: item.key, label: floorName(item.key) }))} value={floor?.key ?? ""} />}
      {!editing && <div className="fp-tools">
        {changed && <button aria-label={t("floorplanResetView")} className="hd-pill" onClick={resetView} type="button"><HDIcon name="refresh" size={14} />{t("floorplanResetView")}</button>}
        <button aria-pressed={threeD} className={`hd-pill fp-3d-toggle${threeD ? " fp-3d-toggle--on" : ""}`} onClick={toggle3D} type="button">3D</button>
      </div>}
      {editing && <div className="fp-tools">
        <button aria-expanded={imagePanel} className="hd-pill" onClick={() => setImagePanel((value) => !value)} type="button"><HDIcon name="plan" size={14} />{t("floorplanImage")}</button>
        <button className={`hd-pill${confirmReset ? " fp-confirm" : ""}`} onClick={() => { if (confirmReset) { setConfirmReset(false); resetFloor(); } else setConfirmReset(true); }} type="button"><HDIcon name="refresh" size={14} />{confirmReset ? t("floorplanResetConfirm") : t("floorplanReset")}</button>
      </div>}
    </div>
    {editing && imagePanel && <div className="fp-image-panel">
      <p>{t("floorplanImageHint")}</p>
      <div className="fp-image-panel__row">
        <input accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void sendImage(file); }} ref={fileInput} type="file" />
        <button className="hd-pill" disabled={uploading} onClick={() => fileInput.current?.click()} type="button"><HDIcon name="plus" size={14} />{uploading ? t("floorplanImageSending") : image ? t("floorplanImageReplace") : t("floorplanImageSend")}</button>
        {image && <button className="hd-pill" onClick={() => setImage(null)} type="button"><HDIcon name="trash" size={14} />{t("floorplanImageRemove")}</button>}
        {image && <label className="fp-image-panel__opacity"><span>{t("floorplanImageOpacity")}</span><input max={1} min={0.2} onChange={(event) => setOpacity(Number(event.target.value))} onPointerUp={() => { if (opacity != null) { setImage({ ...image, opacity }); setOpacity(null); } }} onKeyUp={() => { if (opacity != null) { setImage({ ...image, opacity }); setOpacity(null); } }} step={0.05} type="range" value={opacity ?? image.opacity ?? 0.9} /></label>}
      </div>
      {imageError && <p className="fp-image-panel__error">{imageError}</p>}
    </div>}
    </div>
    <div className="fp-stage" onContextMenu={(event) => { if (!editing) event.preventDefault(); }} onPointerCancel={onStageUp} onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} ref={stage}>
      {floor && unit > 0 && <div className="fp-canvas" onPointerCancel={onDragEnd} onPointerMove={onDragMove} onPointerUp={onDragEnd} style={{ width: canvas.width, height: canvas.height, // Sizes in CSS are tuned to the plan's original 24-column cell, twice the grid unit.
          "--fp-unit": `${unit * 2}px`, transform: threeD && !editing
          ? `translate(${shownView.px}px, calc(${shownView.py}px - 12%)) scale(${shownView.zoom * 0.8}) rotateX(${shownView.rx}deg) rotateZ(${shownView.rz}deg)`
          : `translate(${shownView.px}px, ${shownView.py}px) scale(${shownView.zoom})` } as CSSProperties}>
        {image && <img alt="" className="fp-image" draggable={false} src={image.src} style={upright
          ? { width: canvas.height, height: canvas.width, transform: `translateX(${canvas.width}px) rotate(90deg)`, transformOrigin: "0 0", opacity: opacity ?? image.opacity ?? 0.9 }
          : { width: canvas.width, height: canvas.height, opacity: opacity ?? image.opacity ?? 0.9 }} />}
        {floor.rooms.map((room) => {
          const rect = rectOf(room);
          if (!rect) return null;
          const devices = roomShown(config, room, props.allRooms).filter((entity) => editing || !hidden.has(entity.entity_id)).slice(0, MAX_SPOTS);
          const lights = devices.filter((entity) => entity.domain === "light");
          const lit = lights.filter((entity) => hass.states[entity.entity_id]?.state === "on");
          const glow = lights.length === 0 ? 0 : lit.length / lights.length;
          const temperature = room.entities.find((entity) => entity.domain === "sensor" && entity.device_class === "temperature");
          const temperatureState = temperature ? hass.states[temperature.entity_id] : undefined;
          const motion = room.entities.some((entity) => entity.domain === "binary_sensor" && MOTION.has(entity.device_class ?? "") && hass.states[entity.entity_id]?.state === "on");
          const open = room.entities.some((entity) => entity.domain === "binary_sensor" && OPENINGS.has(entity.device_class ?? "") && hass.states[entity.entity_id]?.state === "on");
          const auto = autoSpots(devices.length, rect, upright);
          return <section className={`fp-room ${glow > 0 ? "fp-room--lit" : ""} ${motion ? "fp-room--motion" : ""} ${open ? "fp-room--open" : ""}`} key={room.id}
            onPointerDown={editing ? (event) => beginDrag(event, { kind: "move", id: room.id, rect }) : undefined}
            style={{ ...place(rect), "--fp-glow": glow } as CSSProperties}>
            {editing && <header className="fp-room__head">
              <span>{room.name}</span>
              {temperatureState && Number.isFinite(Number(temperatureState.state)) && <span className="fp-room__temp">{new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Number(temperatureState.state))}°</span>}
            </header>}
            {devices.map((entity, index) => {
              const spot = draft?.devices[entity.entity_id] ?? plan.devices[entity.entity_id] ?? auto[index];
              const state = hass.states[entity.entity_id];
              const on = isOn(hass, entity);
              const alert = entity.domain === "binary_sensor" && OPENINGS.has(entity.device_class ?? "") && state?.state === "on";
              const motionOn = entity.domain === "binary_sensor" && MOTION.has(entity.device_class ?? "") && state?.state === "on";
              const reading = entity.domain === "sensor";
              const off = hidden.has(entity.entity_id);
              return <button aria-label={`${entity.name}: ${state?.state ?? ""}`}
                className={`fp-spot ${on ? "fp-spot--on" : ""} ${alert ? "fp-spot--alert" : ""} ${motionOn ? "fp-spot--motion" : ""} ${reading ? "fp-spot--reading" : ""} ${off ? "fp-spot--hidden" : ""} ${state?.state === "unavailable" ? "fp-spot--na" : ""}`}
                key={entity.entity_id}
                onContextMenu={(event) => { event.preventDefault(); if (!editing) openModal(entity); }}
                onPointerDown={editing
                  ? (event) => beginDrag(event, { kind: "spot", id: entity.entity_id, spot, box: (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect() })
                  : (event) => { event.stopPropagation(); pressStart(entity); }}
                onPointerLeave={editing ? undefined : () => { window.clearTimeout(hold.current); hold.current = undefined; }}
                onPointerUp={editing ? undefined : () => pressEnd(entity)}
                style={spotStyle(spot)}
                title={entity.name}
                type="button">
                {reading ? <><EntityIcon entity={entity} size={14} /><b>{shortReading(state, language)}</b></> : <EntityIcon entity={entity} size={18} />}
                {editing && <span className="fp-spot__label">{entity.name}</span>}
                {editing && <i aria-label={off ? t("floorplanShowOnPlan") : t("floorplanHideOnPlan")} className="fp-spot__hide" onClick={(event) => { event.stopPropagation(); setHidden(entity.entity_id, !off); }} onPointerDown={(event) => event.stopPropagation()} role="button">{off ? "+" : "−"}</i>}
              </button>;
            })}
            {editing && <span aria-hidden="true" className="fp-room__resize fp-room__resize--start" onPointerDown={(event) => beginDrag(event, { kind: "resizeStart", id: room.id, rect })} />}
            {editing && <span aria-hidden="true" className="fp-room__resize" onPointerDown={(event) => beginDrag(event, { kind: "resize", id: room.id, rect })} />}
          </section>;
        })}
      </div>}
      {!floor && <p className="hd-picker__empty">{t("floorplanEmpty")}</p>}
    </div>
    {modal && <EntityModal entity={modal} hass={hass} language={language} onClose={() => setModal(null)} roomName={rooms.find((room) => room.entities.some((entity) => entity.entity_id === modal.entity_id))?.name} t={t} />}
  </div>;

  if (props.embedded) return body;
  return <main className={`screen fp-screen ${editing ? "screen--editing" : ""}`}>
    <ContextHeader config={config} hass={hass} language={language} onSettings={props.onSettings} t={t} />
    {body}
  </main>;
}


/** The floor plan card on Home: the first floor in small, lit rooms glowing and devices that are on lit up;
 * a tap opens the Floor plan page. */
export function PlanWidget({ config, data, hass, t }: { config: HomeDeckConfig; data: DiscoveryResponse; hass: HomeAssistant; t: (key: TranslationKey) => string }) {
  const plan = config.floorplan ?? EMPTY;
  const rooms = data.rooms.filter((room) => room.id !== "__unassigned__");
  const floorNames = useFloorNames(hass);
  const firstFloor = useMemo(() => {
    const keys = [...new Set(rooms.map((room) => room.floor_id ?? NO_FLOOR))];
    keys.sort((a, b) => (a === NO_FLOOR ? 999 : floorNames[a]?.level ?? 500) - (b === NO_FLOOR ? 999 : floorNames[b]?.level ?? 500));
    return keys[0];
  }, [rooms, floorNames]);
  const floorRooms = rooms.filter((room) => (room.floor_id ?? NO_FLOOR) === firstFloor);
  const auto = useMemo(() => autoLayout(floorRooms), [floorRooms.map((room) => room.id).join()]);
  const image = firstFloor ? plan.images?.[firstFloor] : undefined;
  // The plan keeps its real proportions whatever the card's size: the image's, or the grid's (3:2) without one.
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  useEffect(() => {
    setImageRatio(null);
    if (!image?.src) return;
    const loader = new Image();
    loader.onload = () => { if (loader.naturalWidth > 0 && loader.naturalHeight > 0) setImageRatio(loader.naturalWidth / loader.naturalHeight); };
    loader.src = image.src;
  }, [image?.src]);
  const ratio = imageRatio ?? COLS / ROWS;
  const area = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  // The plan starts under the card's label, as far below it as the label is from the card's top edge
  // (the round icon beside the label doesn't push it down).
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = label.current;
    const card = element?.closest(".fp-card");
    if (!element || !card) return;
    // Layout offsets, not screen boxes: cards that hop in (Kids) are scaled while they animate.
    const measure = () => {
      let offset = 0;
      for (let node: HTMLElement | null = element; node && node !== card; node = node.offsetParent as HTMLElement | null) offset += node.offsetTop;
      if (element.offsetHeight > 0) setTop(Math.round(offset * 2 + element.offsetHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const fit = Math.min(width, height * ratio);
      setBox({ width: fit, height: fit / ratio });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ratio]);
  const hidden = new Set(plan.hidden);
  return <button aria-label={planTitle(config, t, "floorplanCardLabel")} className={`widget-card widget-card--interactive fp-card${image ? " fp-card--image" : ""}`} onClick={() => window.dispatchEvent(new CustomEvent("homedeck-navigate", { detail: "plan" }))} type="button">
    <span className="widget-card__label" ref={label}>{planTitle(config, t, "floorplanCardLabel")}</span>
    <span className="fp-card__plan" ref={area} style={top != null ? { top } : undefined}><span className="fp-card__box" style={{ width: box.width, height: box.height }}>
      {/* The card is lit (like a room with lights on) and the picture shows as it is, on that paper. */}
      {image && <img alt="" className="fp-image" src={image.src} style={{ width: "100%", height: "100%", opacity: 1 }} />}
      {floorRooms.map((room) => {
        const rect = plan.rooms[room.id] ?? auto[room.id];
        if (!rect) return null;
        const lights = room.entities.filter((entity) => entity.domain === "light");
        const glow = lights.length === 0 ? 0 : lights.filter((entity) => hass.states[entity.entity_id]?.state === "on").length / lights.length;
        const open = room.entities.some((entity) => entity.domain === "binary_sensor" && OPENINGS.has(entity.device_class ?? "") && hass.states[entity.entity_id]?.state === "on");
        // The lights that are on glow where they sit on the plan (the same spots as on the Floor plan page).
        const shown = roomShown(config, room, data.rooms).filter((entity) => !hidden.has(entity.entity_id));
        const spots = autoSpots(shown.length, rect, false);
        const lit = shown.map((entity, index) => ({ entity, spot: plan.devices[entity.entity_id] ?? spots[index] })).filter(({ entity }) => entity.domain === "light" && hass.states[entity.entity_id]?.state === "on");
        return <i className={`fp-room ${glow > 0 ? "fp-room--lit" : ""} ${open ? "fp-room--open" : ""}`} key={room.id} style={{ left: `${(rect.x / COLS) * 100}%`, top: `${(rect.y / ROWS) * 100}%`, width: `${(rect.w / COLS) * 100}%`, height: `${(rect.h / ROWS) * 100}%`, "--fp-glow": glow, "--fp-unit": "6px" } as CSSProperties}>
          {lit.map(({ entity, spot }) => <b className="fp-card__light" key={entity.entity_id} style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }} />)}
        </i>;
      })}
    </span></span>
  </button>;
}
